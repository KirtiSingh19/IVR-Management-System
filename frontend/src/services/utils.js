/**
 * Shared helpers: DOM lookup, escaping, formatting, validation, URL params.
 *
 * Nothing here knows about IVRs, audio, or storage. If a function needs domain
 * knowledge it belongs in a feature module, not in this file.
 */

/* ==========================================================================
   DOM
   ========================================================================== */

/** @returns {HTMLElement|null} */
export const qs = (selector, scope = document) => scope.querySelector(selector);

/** @returns {HTMLElement[]} */
export const qsa = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

/**
 * Build an element in one call.
 * @param {string} tag
 * @param {Object} [props]  className, textContent, dataset, attrs, plus any DOM property
 * @param {Array<Node|string>} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') for (const [a, v] of Object.entries(value)) node.setAttribute(a, v);
    else if (key === 'className') node.className = value;
    else node[key] = value;
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Escape a value for safe interpolation into an HTML string.
 *
 * Every user-supplied value — IVR names, descriptions, uploaded file names —
 * passes through this before reaching innerHTML. Without it, naming an IVR
 * `<img src=x onerror=alert(1)>` executes script, and the same hole would
 * survive into Stage 2 when the data comes from a database.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Delegated event listener. Survives table re-renders, so handlers are bound
 * once to a container rather than re-bound to every row on every draw.
 */
export function delegate(root, eventName, selector, handler) {
  root.addEventListener(eventName, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

/* ==========================================================================
   Timing
   ========================================================================== */

/** Trailing-edge debounce, used for search-as-you-type. */
export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ==========================================================================
   Formatting
   ========================================================================== */

/** 1536 -> "1.5 KB". Uses the binary step because file managers do. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const decimals = exponent === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** 65 -> "01:05". Durations are always mm:ss so columns align. */
export function formatDuration(totalSeconds) {
  const safe = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
  const seconds = String(safe % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** ISO string -> "12 Aug 2026". */
export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** ISO string -> "12 Aug 2026, 14:05". */
export function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDate(iso)}, ${date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** ISO string -> "3 days ago". Falls back to a date beyond a month. */
export function formatRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

/** Clock time for the simulator log. */
export function formatClock(date = new Date()) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/** "Main IVR" -> "MI". Used for avatar and node marks. */
export function initials(text, max = 2) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/* ==========================================================================
   Identity
   ========================================================================== */

/**
 * Collision-resistant local id. Stage 2 replaces these with server ids, so
 * nothing in the app is allowed to parse meaning out of an id.
 */
export function uid(prefix = 'id') {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${random[0].toString(36)}${random[1].toString(36)}`;
}

/* ==========================================================================
   URL
   ========================================================================== */

/** Read a query-string parameter from the current URL. */
export function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/** Serialise an object to a query string, dropping empty values. */
export function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) search.set(key, value);
  }
  return search.toString();
}

/* ==========================================================================
   Validation
   --------------------------------------------------------------------------
   Rules return an error message or null. They are shared by the create form,
   the edit form and the flow builder so a rule is only ever written once.
   ========================================================================== */

export const LIMITS = {
  nameMin: 3,
  nameMax: 60,
  descriptionMax: 160,
  extensionPattern: /^\d{3,6}$/,
  digitPattern: /^[0-9*#]$/,
};

export function validateName(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'Enter a name for this IVR.';
  if (name.length < LIMITS.nameMin) return `Use at least ${LIMITS.nameMin} characters.`;
  if (name.length > LIMITS.nameMax) return `Use ${LIMITS.nameMax} characters or fewer.`;
  return null;
}

export function validateExtension(value) {
  const extension = String(value ?? '').trim();
  if (!extension) return 'Enter an extension.';
  if (!LIMITS.extensionPattern.test(extension)) return 'Use 3 to 6 digits, numbers only.';
  return null;
}

export function validateDescription(value) {
  const description = String(value ?? '').trim();
  if (description.length > LIMITS.descriptionMax) {
    return `Use ${LIMITS.descriptionMax} characters or fewer.`;
  }
  return null;
}

export function validateDigit(value) {
  const digit = String(value ?? '').trim();
  if (!digit) return 'Choose a digit.';
  if (!LIMITS.digitPattern.test(digit)) return 'Use a single digit 0-9, * or #.';
  return null;
}

export function validateLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) return 'Enter a label.';
  if (label.length > 40) return 'Use 40 characters or fewer.';
  return null;
}

/* ==========================================================================
   Form field errors
   Bootstrap validation classes, driven from the rules above.
   ========================================================================== */

/**
 * Mark a field invalid and write its message into the paired feedback element.
 * The feedback element must be `#<fieldId>-error` and carry .invalid-feedback.
 */
export function setFieldError(field, message) {
  const feedback = document.getElementById(`${field.id}-error`);
  if (message) {
    field.classList.add('is-invalid');
    field.setAttribute('aria-invalid', 'true');
    if (feedback) feedback.textContent = message;
  } else {
    field.classList.remove('is-invalid');
    field.removeAttribute('aria-invalid');
    if (feedback) feedback.textContent = '';
  }
  return !message;
}

/** Clear every error on a form. */
export function clearFormErrors(form) {
  qsa('.is-invalid', form).forEach((field) => setFieldError(field, null));
}

/**
 * Run a map of { fieldId: validatorFn } against a form.
 * Focuses the first invalid field, which is what a keyboard user expects.
 * @returns {boolean} true when every field passed
 */
export function runValidators(form, validators) {
  let firstInvalid = null;
  for (const [fieldId, validator] of Object.entries(validators)) {
    const field = form.querySelector(`#${fieldId}`);
    if (!field) continue;
    const message = validator(field.value, field);
    setFieldError(field, message);
    if (message && !firstInvalid) firstInvalid = field;
  }
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}
