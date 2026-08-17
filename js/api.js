/**
 * HTTP transport for the IVR API.
 *
 * Two jobs, and only these two:
 *
 *   1. Talk to the Python API and turn its error responses into throwable
 *      objects that carry the field they belong to.
 *   2. Translate between the API's wire format and the shape the UI already
 *      uses. The API speaks snake_case with a capitalised status, because that
 *      is the documented contract and it mirrors the MySQL columns. Every
 *      controller in this project speaks camelCase with a lowercase status, and
 *      has since Stage 1. Mapping in one place here means not a single view,
 *      form or template had to change when the data moved to MySQL.
 *
 * js/repo.js is the only importer. Nothing above it knows this file exists.
 */

/**
 * Where the API lives.
 *
 * The frontend is served by a different process on a different port, so this
 * cannot be a relative URL. Set `window.__IVR_API_BASE__` before app.js loads to
 * point a deployment somewhere else without editing this file.
 */
export const API_BASE = (window.__IVR_API_BASE__ ?? 'http://127.0.0.1:5000').replace(/\/$/, '');

/**
 * A non-2xx response, or a transport failure.
 *
 * `field` is set when the server blamed a specific input, which is what lets a
 * duplicate extension land under the extension box rather than in a toast.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, field = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
    this.cause = cause;
  }
}

/* ==========================================================================
   Field mapping
   ========================================================================== */

/** Wire → UI. Ids become strings because they arrive in URLs as strings. */
function ivrFromApi(row) {
  return {
    id: String(row.id),
    name: row.name ?? '',
    extension: String(row.extension ?? ''),
    description: row.description ?? '',
    welcomeAudio: row.welcome_audio ?? '',
    // The ENUM is 'Active'/'Inactive'; every view and both <select>s use
    // lowercase, and ui.js STATUS_TONES is keyed on lowercase.
    status: String(row.status ?? '').toLowerCase() === 'inactive' ? 'inactive' : 'active',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    menu: (row.menu ?? []).map(optionFromApi),
  };
}

function optionFromApi(row) {
  return {
    id: String(row.id),
    digit: String(row.digit ?? ''),
    // The column is option_name; the flow builder and the simulator both read
    // `label`, so the rename happens here rather than in five templates.
    label: row.option_name ?? '',
    destination: String(row.destination ?? ''),
    destinationType: row.destination_type ?? 'extension',
    // The prompt played after this key is pressed, while the call transfers.
    // A file name, joined to the audio library the same way welcomeAudio is.
    audioFile: row.audio_file ?? '',
  };
}

/**
 * UI → wire, for one menu option.
 *
 * destinationType has no input on any form yet, so it defaults to 'extension' —
 * which is what every option in the app means today. The column exists so that
 * queues and voicemail boxes have somewhere to go later without a schema change.
 */
function optionToApi(option) {
  return {
    digit: String(option.digit ?? '').trim(),
    option_name: String(option.label ?? '').trim(),
    destination_type: option.destinationType || 'extension',
    destination: String(option.destination ?? '').trim(),
    audio_file: String(option.audioFile ?? '').trim(),
  };
}

/**
 * UI → wire, for an IVR.
 *
 * Only the keys actually present are sent. That is what makes a partial update
 * possible: the edit form sends the five detail fields and no menu, the flow
 * builder sends a menu and no detail fields, and the server leaves out whatever
 * it was not told about.
 */
function ivrToApi(input) {
  const body = {};
  if ('name' in input) body.name = String(input.name ?? '').trim();
  if ('extension' in input) body.extension = String(input.extension ?? '').trim();
  if ('description' in input) body.description = String(input.description ?? '').trim();
  if ('welcomeAudio' in input) body.welcome_audio = String(input.welcomeAudio ?? '').trim();
  if ('status' in input) body.status = input.status === 'inactive' ? 'Inactive' : 'Active';
  if ('menu' in input) body.menu = (input.menu ?? []).map(optionToApi);
  return body;
}

/* ==========================================================================
   Transport
   ========================================================================== */

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // fetch only rejects on a transport failure, so this is genuinely "the API
    // is not reachable" rather than "the API said no".
    throw new ApiError(
      'Could not reach the IVR API. Check that the Python server is running.',
      { cause: error },
    );
  }

  // 204 has no body to parse. Nothing returns one today, but a DELETE plausibly
  // could later, and a JSON.parse on an empty string is an ugly way to find out.
  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(payload?.error ?? `The API returned ${response.status}.`, {
      status: response.status,
      field: payload?.field ?? null,
    });
  }

  return payload;
}

/* ==========================================================================
   Endpoints
   ========================================================================== */

/**
 * The in-flight GET, shared rather than duplicated.
 *
 * A single page load asks for the IVR list several times over — the table, the
 * menu counts, the extension filter and the stats tiles all need it, and they
 * ask in parallel. Handing every caller in the same tick the same promise turns
 * that into one HTTP request. It is not a cache: the moment the request settles
 * the next call goes back to the network, so nothing here can serve stale data.
 */
let inFlightList = null;

/** GET /api/ivrs — every IVR, each with its menu nested. */
export function fetchIvrs() {
  if (inFlightList) return inFlightList;

  inFlightList = request('GET', '/api/ivrs')
    .then((rows) => (Array.isArray(rows) ? rows.map(ivrFromApi) : []))
    .finally(() => {
      inFlightList = null;
    });

  return inFlightList;
}

/**
 * One IVR, from the list.
 *
 * The API exposes four endpoints and none of them is a detail read, so this
 * filters the list rather than inventing a fifth. Because it goes through
 * fetchIvrs(), a page that wants both the IVR and its menu still makes one
 * request.
 */
export async function fetchIvr(id) {
  const wanted = String(id);
  const found = (await fetchIvrs()).find((ivr) => ivr.id === wanted);
  if (!found) throw new ApiError('That IVR no longer exists.', { status: 404 });
  return found;
}

/** POST /api/ivrs */
export async function createIvr(input) {
  return ivrFromApi(await request('POST', '/api/ivrs', ivrToApi(input)));
}

/** PUT /api/ivrs/<id> */
export async function updateIvr(id, changes) {
  return ivrFromApi(await request('PUT', `/api/ivrs/${encodeURIComponent(id)}`, ivrToApi(changes)));
}

/** DELETE /api/ivrs/<id> — returns the record that was removed. */
export async function deleteIvr(id) {
  return ivrFromApi(await request('DELETE', `/api/ivrs/${encodeURIComponent(id)}`));
}

/* ==========================================================================
   Audio
   ========================================================================== */

function audioFromApi(row) {
  return {
    id: String(row.id),
    name: row.name ?? '',
    format: row.format ?? '',
    durationSeconds: row.duration_seconds ?? 0,
    sizeBytes: row.size_bytes ?? 0,
    status: row.status ?? 'ready',
    createdAt: row.created_at ?? '',
    seeded: Boolean(row.seeded),
    // True when the row outlived its file on disk. The server checks rather than
    // assumes, so the UI can disable playback instead of offering a URL that 404s.
    missing: Boolean(row.missing),
  };
}

/** The playable URL for a file. A plain path now — no blob, nothing to expire. */
export function audioSourceUrl(id) {
  return `${API_BASE}/api/audio/${encodeURIComponent(id)}/file`;
}

/** GET /api/audio — deduplicated the same way as the IVR list. */
let inFlightAudio = null;

export function fetchAudio() {
  if (inFlightAudio) return inFlightAudio;

  inFlightAudio = request('GET', '/api/audio')
    .then((rows) => (Array.isArray(rows) ? rows.map(audioFromApi) : []))
    .finally(() => {
      inFlightAudio = null;
    });

  return inFlightAudio;
}

/**
 * POST /api/audio — the file's bytes as the body.
 *
 * Sent raw rather than as multipart/form-data, because Python 3.13 removed the
 * `cgi` module and there is no longer a standard-library multipart parser on the
 * other end. The name and duration travel as headers instead; the name is
 * percent-encoded because HTTP headers cannot carry raw UTF-8.
 *
 * fetch() streams a File without reading it into memory first, so a large prompt
 * does not get buffered twice.
 */
export async function uploadAudio(file, durationSeconds) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api/audio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Filename': encodeURIComponent(file.name),
        'X-Audio-Duration': String(Math.round(durationSeconds || 0)),
      },
      body: file,
    });
  } catch (error) {
    throw new ApiError('Could not reach the IVR API. Check that the Python server is running.', {
      cause: error,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error ?? `The API returned ${response.status}.`, {
      status: response.status,
      field: payload?.field ?? null,
    });
  }
  return audioFromApi(payload);
}

/** DELETE /api/audio/<id> — removes the row and the file. */
export async function deleteAudio(id) {
  return audioFromApi(await request('DELETE', `/api/audio/${encodeURIComponent(id)}`));
}

/* ==========================================================================
   Asterisk (read-only)

   The browser never talks to AMI. It asks this API, which holds the manager
   credentials server-side and does the talking. Nothing here can change the
   switch — these are reads.
   ========================================================================== */

/**
 * GET /api/asterisk/status
 *
 * Never throws for a PBX that is simply down. The server answers 200 with
 * `success: false` in that case, because "Asterisk is unreachable" is the
 * correct answer to the question, not a failed request — and the dashboard has
 * to render that state rather than fall into an error path. Only the API itself
 * being unreachable produces a rejection, which is caught here too so a stopped
 * Python server shows as disconnected rather than breaking the page.
 */
export async function fetchAsteriskStatus() {
  try {
    return await request('GET', '/api/asterisk/status');
  } catch (error) {
    return {
      success: false,
      connected: false,
      host: '',
      port: 0,
      message: error instanceof ApiError ? error.message : 'The IVR API is not reachable.',
    };
  }
}

/**
 * POST /api/asterisk/ivrs/<id>/sync
 *
 * Writes this IVR — and every other active one — into Asterisk's managed
 * dialplan file, then reloads. The credentials stay on the server; the browser
 * only ever names the record it wants synced.
 *
 * Reports rather than throws, for the same reason as the reads above: "Asterisk
 * refused this menu because 6001 is not configured" is an answer the user needs
 * to see on the page, not an exception.
 */
export async function syncIvrToAsterisk(id) {
  try {
    return await request('POST', `/api/asterisk/ivrs/${encodeURIComponent(id)}/sync`);
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof ApiError ? error.message : 'The IVR API is not reachable.',
      warnings: [],
      unverified_sounds: [],
    };
  }
}

/** GET /api/asterisk/extensions — same contract: reports trouble, never throws. */
export async function fetchAsteriskExtensions() {
  try {
    return await request('GET', '/api/asterisk/extensions');
  } catch (error) {
    return {
      success: false,
      status_source: '',
      extensions: [],
      message: error instanceof ApiError ? error.message : 'The IVR API is not reachable.',
    };
  }
}
