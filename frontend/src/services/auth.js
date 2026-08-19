/**
 * Who is signed in.
 *
 * A module singleton, like the phone service and for the same reason: it has to
 * outlive any component, and the route guard needs to read it during render
 * rather than after an effect has run.
 *
 * The session token is never here. It lives in an HttpOnly cookie the browser
 * attaches automatically, which no script — including this one — can read. All
 * this module holds is the username the server reported, which is not a
 * credential and cannot be used to impersonate anybody.
 */

import { onUnauthorised } from './api.js';

const API = '';

/** 'unknown' until the first check completes, so the guard can wait rather than bounce. */
let state = { status: 'unknown', username: null, role: null };

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function emit(next) {
  state = { ...state, ...next };
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('[auth] listener failed', error);
    }
  });
}

export function current() {
  return state;
}

// Any 401 from the data layer means this session is over, whichever call hit it.
onUnauthorised(() => {
  if (state.status !== 'out') emit({ status: 'out', username: null, role: null });
});

async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

/**
 * Ask the server whether this browser has a valid session.
 *
 * Called once on start-up. The cookie may be expired, revoked, or from a server
 * that has since been restarted, so only the server can answer this — a token in
 * local storage would let the app believe it was signed in when it is not.
 */
export async function check() {
  try {
    const { response, payload } = await call('/api/auth/me');
    if (response.ok && payload?.authenticated) {
      emit({ status: 'in', username: payload.username, role: payload.role ?? 'user' });
      return true;
    }
  } catch {
    // The API being unreachable is not the same as being signed out, but there
    // is nothing useful the app can do either way: it cannot load data.
  }
  emit({ status: 'out', username: null, role: null });
  return false;
}

export async function login(username, password) {
  const { response, payload } = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  if (response.ok && payload?.authenticated) {
    emit({ status: 'in', username: payload.username, role: payload.role ?? 'user' });
    return { ok: true };
  }
  return { ok: false, message: payload?.error ?? 'Could not sign in. Is the API running?' };
}

/**
 * End the session.
 *
 * The server is told first, so the token is dead even if the browser keeps a
 * copy of the cookie. Local state is cleared regardless of the outcome: a failed
 * request must not leave someone apparently signed in with a session that may
 * already be gone.
 */
export async function logout() {
  try {
    await call('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.warn('[auth] logout request failed', error);
  }
  emit({ status: 'out', username: null, role: null });
}
