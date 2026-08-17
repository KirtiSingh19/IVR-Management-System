/**
 * Low-level persistence.
 *
 * The only module in the project that touches localStorage. Everything above
 * it goes through js/repo.js, so when Stage 2 arrives this file simply stops
 * being imported rather than needing to be unpicked from the UI.
 *
 * Responsibilities:
 *   - namespaced, version-stamped keys
 *   - one-time seeding from data/demo-data.js
 *   - reads that cannot throw on corrupt or absent data
 *   - writes that report quota failures instead of failing silently
 *   - change notification, including across browser tabs
 */

import { SCHEMA_VERSION, DEMO_IVRS, DEMO_FLOWS } from '../data/demo-data.js';

const NAMESPACE = 'ivrm';
const prefix = `${NAMESPACE}:v${SCHEMA_VERSION}`;

export const KEYS = {
  IVRS: `${prefix}:ivrs`,
  AUDIO: `${prefix}:audio`,
  FLOWS: `${prefix}:flows`,
  SEEDED: `${prefix}:seeded`,
};

/**
 * Records that the one-time push of local IVRs into MySQL has completed.
 *
 * Deliberately outside KEYS, because resetToDemoData() clears everything in
 * KEYS. Restoring the demo audio library must not make the app think it has
 * never migrated and re-post three IVRs to the server.
 */
export const MIGRATED_KEY = `${prefix}:migrated`;

/** Raised when a write cannot be persisted. Callers surface this to the user. */
export class StorageWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageWriteError';
    this.cause = cause;
  }
}

/* ==========================================================================
   Backend selection
   Safari private browsing and some locked-down enterprise policies expose
   localStorage but throw on write. Detect that once and fall back to an
   in-memory store so the prototype still runs — it just will not persist.
   ========================================================================== */

function detectBackend() {
  try {
    const probe = `${prefix}:probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    console.warn('[storage] localStorage is unavailable; data will not persist this session.');
    const memory = new Map();
    return {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, value),
      removeItem: (key) => memory.delete(key),
      get length() {
        return memory.size;
      },
      key: (index) => Array.from(memory.keys())[index] ?? null,
    };
  }
}

const backend = detectBackend();

/** True when data survives a reload. The UI uses this to warn honestly. */
export const isPersistent = backend === window.localStorage;

/* ==========================================================================
   Change notification
   ========================================================================== */

const listeners = new Map();

/**
 * Subscribe to changes for one storage key.
 * @returns {() => void} unsubscribe
 */
export function subscribe(key, listener) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(listener);
  return () => listeners.get(key)?.delete(listener);
}

function notify(key) {
  listeners.get(key)?.forEach((listener) => {
    try {
      listener(key);
    } catch (error) {
      console.error('[storage] listener failed', error);
    }
  });
}

// Keep two open tabs consistent. The storage event only fires in *other* tabs,
// which is exactly the case local notify() cannot cover.
if (isPersistent) {
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith(prefix)) notify(event.key);
  });
}

/* ==========================================================================
   Read / write
   ========================================================================== */

/**
 * Read and parse a key.
 * Corrupt JSON returns the fallback rather than throwing, so one bad write can
 * never leave the app permanently unable to start.
 */
export function read(key, fallback) {
  const raw = backend.getItem(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    console.error(`[storage] could not parse "${key}", falling back to defaults`, error);
    return fallback;
  }
}

/**
 * Serialise and persist a key, then notify subscribers.
 * @throws {StorageWriteError} when the browser refuses the write
 */
export function write(key, value) {
  try {
    backend.setItem(key, JSON.stringify(value));
  } catch (error) {
    const quotaExceeded =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    throw new StorageWriteError(
      quotaExceeded
        ? 'Browser storage is full. Remove some records and try again.'
        : 'Could not save to browser storage.',
      error,
    );
  }
  notify(key);
  return value;
}

/**
 * Read a plain string key, bypassing JSON.
 *
 * Used for the one-shot flags — SEEDED and MIGRATED — which are not documents
 * and would gain nothing from being serialised.
 */
export function readFlag(key) {
  return backend.getItem(key);
}

/** Write a plain string key. Silent on failure: a flag is not worth a toast. */
export function writeFlag(key, value) {
  try {
    backend.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[storage] could not record the "${key}" flag`, error);
    return false;
  }
}

/* ==========================================================================
   Seeding
   ========================================================================== */

/**
 * Populate storage from the demo data, once.
 *
 * Guarded by a dedicated SEEDED flag rather than by "are the IVRs empty",
 * so that a user who deliberately deletes every IVR does not get the demo
 * records pushed back at them on the next reload.
 */
export function seedIfEmpty() {
  if (backend.getItem(KEYS.SEEDED) === 'true') return false;
  write(KEYS.IVRS, DEMO_IVRS);
  write(KEYS.FLOWS, DEMO_FLOWS);
  // Audio is no longer seeded here. The prompts in assets/audio are imported
  // into the server's library on its first start, so that a file the app ships
  // with and a file somebody uploads are the same kind of thing.
  backend.setItem(KEYS.SEEDED, 'true');
  return true;
}

/**
 * Discard the browser's copy of the IVR data.
 *
 * This is the last step of the move to MySQL: the local records were kept as a
 * backup until the database could be trusted, and this is what removes them once
 * it can. SEEDED is deliberately left in place, so clearing the backup does not
 * cause the demo records to be written straight back on the next load.
 */
export function clearLocalBackup() {
  [KEYS.IVRS, KEYS.AUDIO, KEYS.FLOWS].forEach((key) => {
    backend.removeItem(key);
    notify(key);
  });
}

/** Approximate bytes used by this app's keys, for the storage meter. */
export function usageBytes() {
  return Object.values(KEYS).reduce((total, key) => {
    const raw = backend.getItem(key);
    return total + (raw ? raw.length + key.length : 0);
  }, 0);
}
