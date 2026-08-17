/**
 * Repositories — the seam, now used for what it was built for.
 *
 * All three repositories now read and write MySQL through the Python API. This
 * file no longer imports js/storage.js at all — localStorage keeps only the
 * pre-migration backup of the IVR data, which js/migrate.js reads.
 *
 * The point of this file was always that the swap would be confined to it, and
 * it was: every method below keeps the exact signature and return shape it had
 * when it read from localStorage, so dashboard.js, ivr.js, flow-builder.js,
 * audio.js and test-ivr.js needed no rewriting.
 *
 *   Before  async list(query) { return paginate(filter(read(KEYS.IVRS)), query); }
 *   Now     async list(query) { return paginate(filter(await fetchIvrs()), query); }
 *
 * Filtering, sorting and pagination stay on this side of the wire. The API
 * returns the whole collection, which is the right trade at this size: it keeps
 * ordering and search behaviour identical to what the UI has always done, and it
 * keeps the API to the four endpoints it documents.
 */

import * as IvrApi from './api.js';
import { ApiError } from './api.js';

/** Raised when input fails a business rule. Carries the offending field. */
export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** Raised when an id does not resolve. Maps onto HTTP 404. */
export class NotFoundError extends Error {
  constructor(message = 'Record not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Turn a transport-level ApiError back into the domain error the views already
 * handle, so the API's 400s and 404s reach the same `catch` branches that the
 * localStorage rules used to.
 *
 * Anything else — the API being down, a 500 — passes through untouched and is
 * reported as an unexpected failure, which is exactly right: those are not the
 * user's mistake and should not be dressed up as a form error.
 */
function asDomainError(error) {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new NotFoundError(error.message);
  if (error.field) return new ValidationError(error.field, error.message);
  if (error.status === 400) return new ValidationError(null, error.message);
  return error;
}

/* ==========================================================================
   Change notification

   localStorage gave this away for free, including across tabs, via the storage
   event. HTTP has no equivalent — the server cannot push — so mutations made
   here announce themselves to listeners in this tab.

   Every topic fires on every write. With the menu nested inside its IVR, a menu
   change and an IVR change are literally the same request, so there is nothing to
   tell apart; audio joins them rather than being a third mechanism for the sake
   of it. What is genuinely lost is cross-tab notification: a second tab now finds
   out on its next read rather than immediately.
   ========================================================================== */

const changeListeners = { ivrs: new Set(), flows: new Set(), audio: new Set() };

function onServerChange(topic, listener) {
  changeListeners[topic].add(listener);
  return () => changeListeners[topic].delete(listener);
}

function announceChange() {
  for (const [topic, listeners] of Object.entries(changeListeners)) {
    listeners.forEach((listener) => {
      try {
        listener(topic);
      } catch (error) {
        console.error('[repo] change listener failed', error);
      }
    });
  }
}

/* ==========================================================================
   Query helpers
   These emulate, in the browser, what the backend will later do in SQL.
   ========================================================================== */

/** Case-insensitive "contains" across the named fields. */
function matchesSearch(record, term, fields) {
  if (!term) return true;
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(record[field] ?? '').toLowerCase().includes(needle));
}

function compare(a, b, key) {
  const left = a[key];
  const right = b[key];
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, {
    numeric: true, // so "5010" sorts after "509", not before
    sensitivity: 'base',
  });
}

function sortRecords(records, sort, direction = 'asc') {
  if (!sort) return records;
  const factor = direction === 'desc' ? -1 : 1;
  return [...records].sort((a, b) => compare(a, b, sort) * factor);
}

/**
 * Slice a result set into a page.
 * Returns the envelope shape the backend will return, so the table renderer
 * never has to learn a second one.
 */
function paginate(records, { page = 1, pageSize = 10 } = {}) {
  const total = records.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  return {
    items: records.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    pageCount,
  };
}

/* ==========================================================================
   IVRs
   ========================================================================== */

export const IvrRepo = {
  /** Notify when the IVR collection changes. */
  onChange(listener) {
    return onServerChange('ivrs', listener);
  },

  /** Every IVR, unfiltered. For pickers and dashboard counts. */
  async all() {
    return IvrApi.fetchIvrs();
  },

  /**
   * Filtered, sorted, paginated list.
   * @param {Object} [query]
   * @param {string} [query.search]           matched against name, extension, description
   * @param {'active'|'inactive'|''} [query.status]
   * @param {string} [query.extensionPrefix]  e.g. "50" matches 5000-5099
   * @param {string} [query.sort]             field name
   * @param {'asc'|'desc'} [query.direction]
   * @param {number} [query.page]
   * @param {number} [query.pageSize]
   */
  async list(query = {}) {
    const { search = '', status = '', extensionPrefix = '' } = query;
    const filtered = (await IvrApi.fetchIvrs()).filter((ivr) => {
      if (status && ivr.status !== status) return false;
      if (extensionPrefix && !ivr.extension.startsWith(extensionPrefix)) return false;
      return matchesSearch(ivr, search, ['name', 'extension', 'description']);
    });
    return paginate(sortRecords(filtered, query.sort, query.direction), query);
  },

  async get(id) {
    try {
      return await IvrApi.fetchIvr(id);
    } catch (error) {
      throw asDomainError(error);
    }
  },

  /**
   * The extension is the dialable identity of an IVR, so it has to be unique.
   *
   * The unique index in MySQL is the actual guarantee, and the API returns a
   * field-level error when it is violated. This check stays because it names the
   * IVR already holding the extension, which is a better message than the server
   * can give without a second query — and because the create and edit pages both
   * want that message from one place.
   */
  async assertExtensionFree(extension, exceptId = null) {
    const wanted = String(extension).trim();
    const except = exceptId === null ? null : String(exceptId);
    const clash = (await IvrApi.fetchIvrs()).find(
      (ivr) => ivr.extension === wanted && ivr.id !== except,
    );
    if (clash) {
      throw new ValidationError('extension', `Extension ${wanted} is already used by ${clash.name}.`);
    }
  },

  async create(input) {
    await this.assertExtensionFree(input.extension);
    try {
      const created = await IvrApi.createIvr(input);
      announceChange();
      return created;
    } catch (error) {
      throw asDomainError(error);
    }
  },

  /**
   * Apply a partial change set.
   *
   * Only the keys present in `changes` are sent, and the server leaves the rest
   * alone — including the menu, which the edit form never sends. That is what
   * stops saving a rename from wiping the IVR's menu options.
   */
  async update(id, changes) {
    if (changes.extension) await this.assertExtensionFree(changes.extension, id);
    try {
      const updated = await IvrApi.updateIvr(id, changes);
      announceChange();
      return updated;
    } catch (error) {
      throw asDomainError(error);
    }
  },

  /** Deleting an IVR also drops its menu, so no orphan flow is left behind. */
  async remove(id) {
    try {
      const removed = await IvrApi.deleteIvr(id);
      announceChange();
      return removed;
    } catch (error) {
      throw asDomainError(error);
    }
  },

  /** Distinct two-digit extension prefixes, for the extension filter. */
  async extensionPrefixes() {
    const prefixes = new Set(
      (await IvrApi.fetchIvrs())
        .map((ivr) => ivr.extension.slice(0, 2))
        .filter((prefix) => prefix.length === 2),
    );
    return [...prefixes].sort();
  },

  /** Counts for the dashboard tiles. */
  async stats() {
    const records = await IvrApi.fetchIvrs();
    const active = records.filter((ivr) => ivr.status === 'active').length;
    return { total: records.length, active, inactive: records.length - active };
  },
};

/* ==========================================================================
   Audio
   ========================================================================== */

/**
 * The prompt library.
 *
 * This used to keep uploaded audio in a Map of blob: URLs and persist only the
 * metadata, because the blobs were far too large for localStorage. That map died
 * with the tab, so an uploaded prompt survived a reload as a row with nothing
 * behind it — the "Audio not kept after reload" note, and a Play button that did
 * nothing.
 *
 * The bytes now go to the server, which writes them to disk and serves them back
 * from a plain URL. Nothing is held in memory, nothing expires, and a prompt
 * uploaded on one machine plays on another.
 */
export const AudioRepo = {
  onChange(listener) {
    return onServerChange('audio', listener);
  },

  async all() {
    return IvrApi.fetchAudio();
  },

  /**
   * @param {Object} [query]
   * @param {string} [query.search]
   * @param {string} [query.format]  e.g. "WAV"
   * @param {string} [query.sort]
   * @param {'asc'|'desc'} [query.direction]
   * @param {number} [query.page]
   * @param {number} [query.pageSize]
   */
  async list(query = {}) {
    const { search = '', format = '' } = query;
    const filtered = (await IvrApi.fetchAudio()).filter((file) => {
      if (format && file.format !== format) return false;
      return matchesSearch(file, search, ['name', 'format']);
    });
    return paginate(sortRecords(filtered, query.sort, query.direction), query);
  },

  async get(id) {
    const wanted = String(id);
    const file = (await IvrApi.fetchAudio()).find((record) => record.id === wanted);
    if (!file) throw new NotFoundError('That audio file no longer exists.');
    return file;
  },

  /**
   * Find a prompt by file name, ignoring case. Null when there is no match.
   *
   * `ivrs.welcome_audio` stores a name rather than an id, so this is the join
   * between an IVR and its greeting. It has to ignore case, because everything
   * else in the system already does: the unique index on audio_files.name uses
   * the utf8mb4_0900_ai_ci collation, and this repository's own duplicate check
   * has always compared lowercased names. JavaScript's === was the one place that
   * did not, which is how an IVR saved against "Invalid.wav" quietly stopped
   * playing a library file called "invalid.wav".
   */
  async byName(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    const files = await IvrApi.fetchAudio();
    return files.find((file) => file.name.toLowerCase() === wanted) ?? null;
  },

  /**
   * Playable URL for a file, or null when there is nothing to play.
   *
   * Stays synchronous because the table renderer calls it while building rows.
   * It no longer needs to look anything up: every file, shipped or uploaded, is
   * served from the same endpoint, so the URL is just built from the id.
   */
  sourceFor(file) {
    if (!file || file.missing) return null;
    return IvrApi.audioSourceUrl(file.id);
  },

  /** True when the row exists but its file has gone missing on the server. */
  isSourceMissing(file) {
    return this.sourceFor(file) === null;
  },

  /**
   * Upload a file and register it.
   *
   * The duration is read from the browser's own decoder rather than guessed, so
   * the table shows the real length — and the decode doubles as a format check,
   * rejecting anything unplayable before it is ever sent.
   *
   * @param {File} file
   * @param {number} durationSeconds
   */
  async create(file, durationSeconds) {
    try {
      const created = await IvrApi.uploadAudio(file, durationSeconds);
      announceChange();
      return created;
    } catch (error) {
      throw asDomainError(error);
    }
  },

  async remove(id) {
    try {
      const removed = await IvrApi.deleteAudio(id);
      announceChange();
      return removed;
    } catch (error) {
      throw asDomainError(error);
    }
  },

  /** Distinct formats present, for the format filter. */
  async formats() {
    return [...new Set((await IvrApi.fetchAudio()).map((file) => file.format))].sort();
  },

  async stats() {
    const records = await IvrApi.fetchAudio();
    return {
      total: records.length,
      totalBytes: records.reduce((sum, file) => sum + (file.sizeBytes || 0), 0),
    };
  },
};

/* ==========================================================================
   Menu flows
   ========================================================================== */

/**
 * The menu lives inside its IVR, both in the API response and in the request
 * that saves it. The flow builder still edits one option at a time, so each of
 * these methods reads the current menu, changes the one option, and sends the
 * whole menu back with PUT — which is what "replace its menu records" means on
 * the server side, inside one transaction.
 *
 * The consequence worth knowing: two people editing the same menu at once will
 * see last-write-wins, because each PUT carries a full menu rather than a single
 * row. Dedicated per-option endpoints would fix that, and the nested shape is
 * ready for them; at one administrator it is not yet a problem worth the extra
 * four routes.
 */
export const FlowRepo = {
  onChange(listener) {
    return onServerChange('flows', listener);
  },

  /** Menu options for one IVR, ordered by digit so the menu reads in order. */
  async list(ivrId) {
    const { menu } = await IvrRepo.get(ivrId);
    return [...menu].sort((a, b) => a.digit.localeCompare(b.digit, undefined, { numeric: true }));
  },

  /**
   * A caller can only press one key, so a digit can only mean one thing.
   * This is the flow builder's single business rule, and it is also a unique
   * index on (ivr_id, digit), so it holds even if this check is bypassed.
   */
  async assertDigitFree(ivrId, digit, exceptId = null) {
    const wanted = String(digit).trim();
    const except = exceptId === null ? null : String(exceptId);
    const clash = (await this.list(ivrId)).find(
      (option) => option.digit === wanted && option.id !== except,
    );
    if (clash) {
      throw new ValidationError('digit', `Digit ${wanted} is already assigned to ${clash.label}.`);
    }
  },

  /**
   * Save a menu and hand back the one option the caller was working on.
   *
   * Found by digit rather than by id. An option that keeps its digit keeps its
   * id, but one that moves to a different digit is a different row, so the digit
   * is the handle that survives every case — and it is unique within an IVR.
   */
  async _saveMenu(ivrId, menu, digit) {
    const { menu: saved } = await IvrRepo.update(ivrId, { menu });
    return saved.find((option) => option.digit === digit) ?? null;
  },

  async create(ivrId, input) {
    await this.assertDigitFree(ivrId, input.digit);
    const digit = String(input.digit).trim();
    const menu = await this.list(ivrId);
    return this._saveMenu(
      ivrId,
      [
        ...menu,
        {
          digit,
          label: String(input.label).trim(),
          destination: String(input.destination).trim(),
          destinationType: input.destinationType || 'extension',
          audioFile: String(input.audioFile ?? '').trim(),
        },
      ],
      digit,
    );
  },

  async update(ivrId, optionId, changes) {
    const wantedId = String(optionId);
    const menu = await this.list(ivrId);
    const current = menu.find((option) => option.id === wantedId);
    if (!current) throw new NotFoundError('That menu option no longer exists.');
    if (changes.digit) await this.assertDigitFree(ivrId, changes.digit, optionId);

    const digit = String(changes.digit ?? current.digit).trim();
    const next = menu.map((option) =>
      option.id === wantedId
        ? {
            ...option,
            digit,
            label: String(changes.label ?? option.label).trim(),
            destination: String(changes.destination ?? option.destination).trim(),
            // `??` rather than `||`, so choosing "No audio" clears the prompt
            // instead of falling back to whatever was set before.
            audioFile: String(changes.audioFile ?? option.audioFile ?? '').trim(),
          }
        : option,
    );
    return this._saveMenu(ivrId, next, digit);
  },

  async remove(ivrId, optionId) {
    const wantedId = String(optionId);
    const menu = await this.list(ivrId);
    const target = menu.find((option) => option.id === wantedId);
    if (!target) throw new NotFoundError('That menu option no longer exists.');

    await IvrRepo.update(ivrId, { menu: menu.filter((option) => option.id !== wantedId) });
    // The row is gone, so return the copy read before the write — the caller
    // names the deleted option in its confirmation toast.
    return target;
  },

  /** Option count per IVR, so the list can show menu size without N reads. */
  async countsByIvr() {
    const ivrs = await IvrApi.fetchIvrs();
    return Object.fromEntries(ivrs.map((ivr) => [ivr.id, ivr.menu.length]));
  },
};
