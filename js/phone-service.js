/**
 * The SIP registration, held apart from any one page.
 *
 * THE PROBLEM THIS SOLVES
 *
 * This app is a set of separate HTML documents. Navigating from the Phone page
 * to the IVR list is a full document load: the browser destroys the JavaScript
 * context, and with it the SIP.js UserAgent and its WebSocket. Asterisk sees the
 * socket close and drops the registration. Nothing running inside phone.html can
 * prevent that — a page cannot outlive its own document.
 *
 * So the registration is not kept alive. It is *re-established*, immediately and
 * silently, on every page. app.js calls resume() during boot on every page in the
 * app; if a session was left open, this reconnects and re-REGISTERs before the
 * user notices. From their side the extension simply stays registered until they
 * press Unregister, which is the only thing that clears the stored session.
 *
 * WHY THE PASSWORD IS STORED, AND WHERE
 *
 * A fresh document knows nothing. To re-authenticate without prompting, the
 * credentials have to be somewhere the next page can read, and sessionStorage is
 * the narrowest option that works: scoped to this one tab, wiped when the tab
 * closes, never written to disk. It is still readable by any script on this
 * origin, which is a real cost — it is the same secret a desk phone uses. The
 * alternative is re-typing the password on every page, which is not a phone.
 *
 * WHAT THIS STILL CANNOT DO
 *
 * A call in progress does not survive navigation. Media lives in the document's
 * RTCPeerConnection and dies with it. Registration comes back in about a second;
 * an active call does not come back at all.
 */

import { Web } from '../assets/vendor/sipjs/sip.min.js';

/** Where the open session lives between page loads. Cleared by unregister(). */
const SESSION_KEY = 'ivrm:phone:session';

/** The live SIP.js SimpleUser for this document, or null. */
let phone = null;

/** Last known registration state, so a late-arriving UI can paint immediately. */
let state = { status: 'idle', detail: '', extension: '', server: '' };

/** Whoever wants telling when something changes — usually the Phone page. */
const listeners = new Set();

/** The audio element the far end is played through. Created once, per document. */
let remoteAudio = null;

/* ==========================================================================
   Session storage
   ========================================================================== */

function readSession() {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(session) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private browsing. Registration still works on this page; it just will not
    // survive the next navigation, which resume() will show as "not registered".
    console.warn('[phone] session storage unavailable; registration will not persist.');
  }
}

function clearSession() {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* Nothing to clear. */
  }
}

/** True when an extension is meant to be registered right now. */
export function hasSession() {
  return readSession() !== null;
}

/* ==========================================================================
   Notification
   ========================================================================== */

export function subscribe(listener) {
  listeners.add(listener);
  listener(state); // Paint from what is already known, rather than from 'idle'.
  return () => listeners.delete(listener);
}

function emit(next) {
  state = { ...state, ...next };
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('[phone] listener failed', error);
    }
  });
}

/* ==========================================================================
   The user agent
   ========================================================================== */

function audioElement() {
  if (remoteAudio) return remoteAudio;
  // Owned here rather than by the page, because the far end has to be audible on
  // whichever page happens to be open when a call is answered.
  remoteAudio = document.getElementById('phoneRemoteAudio');
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.id = 'phoneRemoteAudio';
    remoteAudio.autoplay = true;
    remoteAudio.hidden = true;
    document.body.append(remoteAudio);
  }
  return remoteAudio;
}

/** Everything that can go wrong at the transport, said usefully. */
function describeTransportFailure(error, server) {
  const host = String(server).replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  return (
    `Could not open a secure WebSocket to ${host}. ` +
    `If Asterisk uses a self-signed certificate, open https://${host}/httpstatus in a tab and ` +
    'accept the warning once, then try again. Otherwise check that http.conf has tlsenable=yes ' +
    'and that the port is reachable.' +
    (error?.message ? ` (${error.message})` : '')
  );
}

/** Build and connect a UserAgent for these credentials. */
async function start({ server, extension, password }, { silent = false } = {}) {
  const socket = `wss://${String(server).replace(/^wss?:\/\//, '').replace(/\/.*$/, '')}/ws`;
  const domain = String(server).replace(/^wss?:\/\//, '').replace(/:.*$/, '');

  emit({ status: 'connecting', detail: silent ? 'Restoring session…' : `Connecting to ${socket}`, extension, server });

  phone = new Web.SimpleUser(socket, {
    aor: `sip:${extension}@${domain}`,
    media: { remote: { audio: audioElement() } },
    userAgentOptions: {
      authorizationUsername: extension,
      authorizationPassword: password,
      displayName: extension,
      transportOptions: { server: socket },
    },
    delegate: {
      onCallReceived: () => {
        const from = phone?.session?.remoteIdentity?.uri?.user ?? 'unknown';
        emit({ call: 'ringing', remote: from });
      },
      onCallAnswered: () => emit({ call: 'active', answeredAt: Date.now() }),
      onCallHangup: () => emit({ call: 'idle', remote: '', answeredAt: 0 }),
      onRegistered: () => emit({ status: 'registered', detail: `${extension} @ ${domain}` }),
      onUnregistered: () => emit({ status: 'idle', detail: '' }),
      onServerDisconnect: (error) => {
        emit({ status: 'failed', detail: describeTransportFailure(error, server) });
      },
    },
  });

  await phone.connect();
  await phone.register();
  return phone;
}

/* ==========================================================================
   What the Phone page calls
   ========================================================================== */

export async function register({ server, extension, password }) {
  await stop();
  try {
    await start({ server, extension, password });
    writeSession({ server, extension, password });
    return { ok: true };
  } catch (error) {
    console.error('[phone] registration failed', error);
    phone = null;
    clearSession();
    const detail = describeTransportFailure(error, server);
    emit({ status: 'failed', detail });
    return { ok: false, message: detail };
  }
}

/**
 * Re-establish a session left open by a previous page.
 *
 * Called on every page in the app. Silent by design: if there is no session it
 * does nothing, and if there is one the user should not have to watch it being
 * rebuilt. A failure here clears the stored session rather than retrying — a
 * password that no longer works would otherwise fail on every page load.
 */
export async function resume() {
  const session = readSession();
  if (!session || phone) return false;

  if (!window.isSecureContext) {
    // The mic is unavailable here, so a registration would be able to receive a
    // call it could never answer.
    emit({ status: 'idle', detail: '' });
    return false;
  }

  try {
    await start(session, { silent: true });
    return true;
  } catch (error) {
    console.warn('[phone] could not restore the session', error);
    phone = null;
    clearSession();
    emit({ status: 'idle', detail: '' });
    return false;
  }
}

/** Tear down this document's user agent without touching the stored session. */
async function stop() {
  if (!phone) return;
  try {
    await phone.disconnect();
  } catch (error) {
    console.warn('[phone] disconnect failed', error);
  }
  phone = null;
}

/** The only thing that ends a registration for good. */
export async function unregister() {
  clearSession();
  try {
    await phone?.unregister();
  } catch (error) {
    console.warn('[phone] unregister failed', error);
  }
  await stop();
  emit({ status: 'idle', detail: '', call: 'idle', remote: '' });
}

/* ==========================================================================
   Call control — thin passthroughs, so the page never holds the UserAgent
   ========================================================================== */

export function current() {
  return state;
}

export function isRegistered() {
  return state.status === 'registered';
}

export async function call(target, server) {
  const domain = String(server).replace(/^wss?:\/\//, '').replace(/:.*$/, '');
  emit({ call: 'outgoing', remote: target });
  try {
    await phone.call(`sip:${target}@${domain}`);
  } catch (error) {
    emit({ call: 'idle', remote: '' });
    throw error;
  }
}

export const answer = () => phone?.answer();
export const decline = () => phone?.decline();
export const hangup = () => phone?.hangup();
export const sendDTMF = (key) => phone?.sendDTMF(key);
export const mute = () => phone?.mute();
export const unmute = () => phone?.unmute();
