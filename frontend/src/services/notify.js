/**
 * Toasts and the confirmation dialog, as plain functions.
 *
 * The old js/ui.js exposed `toast()` and `confirmDialog()` — callable from
 * anywhere, with confirmDialog returning a promise so a caller could write
 * `if (!(await confirmDialog(...))) return;`. Every page controller was written
 * against that shape.
 *
 * Keeping the same shape here means the ported logic reads the same rather than
 * being restructured around a context provider and a pile of props. React only
 * needs to render what these stores hold, which <Toaster> and <ConfirmHost> do.
 *
 * Module-level state, like the phone service, for the same reason: it outlives
 * any one component, so a toast raised while navigating still appears.
 */

let nextId = 1;

/* ==========================================================================
   Toasts
   ========================================================================== */

const toasts = [];
const toastListeners = new Set();

function emitToasts() {
  const snapshot = [...toasts];
  toastListeners.forEach((listener) => listener(snapshot));
}

export function subscribeToasts(listener) {
  toastListeners.add(listener);
  listener([...toasts]);
  return () => toastListeners.delete(listener);
}

/**
 * Show a toast.
 *
 * Same signature and same tones as the original, so ported call sites are
 * unchanged. Titles name the action in the past tense — "Create IVR" produces
 * "IVR created" — so the vocabulary stays consistent across a flow.
 */
export function toast({ title, text = '', tone = 'ok', delay = 4000 }) {
  const id = nextId++;
  toasts.push({ id, title, text, tone, delay });
  emitToasts();
  return id;
}

export function dismissToast(id) {
  const index = toasts.findIndex((entry) => entry.id === id);
  if (index !== -1) {
    toasts.splice(index, 1);
    emitToasts();
  }
}

/* ==========================================================================
   Confirmation dialog
   ========================================================================== */

let pending = null;
const confirmListeners = new Set();

function emitConfirm() {
  confirmListeners.forEach((listener) => listener(pending));
}

export function subscribeConfirm(listener) {
  confirmListeners.add(listener);
  listener(pending);
  return () => confirmListeners.delete(listener);
}

/**
 * Ask the user to confirm a destructive action.
 *
 * Resolves true only when the confirm button was pressed; Escape, the backdrop
 * and Cancel all resolve false, so callers can rely on `if (!ok) return`.
 *
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'Are you sure?',
  body = 'This action cannot be undone.',
  confirmLabel = 'Delete',
  tone = 'danger',
} = {}) {
  // A second request while one is open would strand the first promise unsettled
  // and its caller waiting forever. Decline it instead.
  if (pending) return Promise.resolve(false);

  return new Promise((resolve) => {
    pending = {
      title,
      body,
      confirmLabel,
      tone,
      settle(accepted) {
        pending = null;
        emitConfirm();
        resolve(accepted);
      },
    };
    emitConfirm();
  });
}
