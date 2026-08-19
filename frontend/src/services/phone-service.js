/**
 * The SIP registration, held apart from any one component.
 *
 * WHY THIS IS A MODULE, NOT A COMPONENT
 *
 * The UserAgent, its WebSocket and any call in progress live here, at module
 * scope, outside the React tree. Components subscribe to the state; they never
 * own the connection. Navigating from Phone to Edit IVR unmounts the Phone UI
 * and detaches one listener — the call carries on.
 *
 * The usual instinct is to treat a connection opened "for" a component as that
 * component's to close. Here that instinct is the bug. The only things that may
 * end a registration are the Unregister button and the transport genuinely
 * dropping.
 *
 * NO CREDENTIALS ARE STORED
 *
 * The vanilla app was seven separate documents, so every navigation destroyed
 * this module and the registration with it. The workaround was to keep the SIP
 * password in sessionStorage and silently re-authenticate on each page load —
 * a real cost, since any script on the origin could read it.
 *
 * A single-page app removes the reason for it: the JavaScript context is never
 * torn down, so there is nothing to restore and nothing to remember. The
 * password now lives in a variable for as long as the connection does, and a
 * genuine browser reload asks for it again, as it should.
 *
 * WHAT THIS STILL CANNOT DO
 *
 * A full browser reload (F5) ends the call and the registration. That is
 * correct — the page really is being destroyed — and it is the only case left.
 */

// Now a real dependency rather than a vendored bundle: the build step React
// brought with it makes npm the simpler source, and Vite bundles it the same way.
import { Web } from 'sip.js';

/**
 * The credentials backing the live registration, for as long as it lives.
 *
 * In memory only. Nothing is written to sessionStorage, localStorage or a
 * cookie, so nothing outlives the tab or is readable after a reload.
 */
let session = null;

/** True when an extension is registered, or being registered. */
export function hasSession() {
  return session !== null;
}

/** The live SIP.js SimpleUser, or null. */
let phone = null;

/** Last known state, so a component mounting mid-call paints the live call. */
let state = { status: 'idle', detail: '', extension: '', server: '' };

/** Whoever wants telling when something changes — usually the Phone page. */
const listeners = new Set();

/** The element the far end is played through. Owned here, not by a component. */
let remoteAudio = null;

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
        emit({ call: 'ringing', remote: from, callDirection: 'inbound' });
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

  if (!window.isSecureContext) {
    // Without a microphone a registration could receive a call it can never
    // answer, which is worse than refusing to register at all.
    const detail =
      `This page is open at ${window.location.origin}, which the browser does not treat as a ` +
      'secure context, so it will not grant microphone access.';
    emit({ status: 'failed', detail });
    return { ok: false, message: detail };
  }

  try {
    await start({ server, extension, password });
    session = { server, extension, password };
    return { ok: true };
  } catch (error) {
    console.error('[phone] registration failed', error);
    phone = null;
    session = null;
    const detail = describeTransportFailure(error, server);
    emit({ status: 'failed', detail });
    return { ok: false, message: detail };
  }
}

/**
 * Kept for the app shell to call on start-up.
 *
 * There is nothing to resume any more: in a single-page app the module is never
 * torn down, so a registration either still exists in memory or was genuinely
 * ended. It stays as a no-op rather than being deleted so App.jsx does not need
 * to care, and so the shape is here if a deliberate "remember me" is ever added.
 */
export async function resume() {
  return hasSession();
}

/** Tear down the user agent without forgetting the credentials. */
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
  // Forget the credentials as well as dropping the connection, so nothing is
  // left in memory that could re-register without the user asking.
  session = null;
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
  emit({ call: 'outgoing', remote: target, callDirection: 'outbound' });
  try {
    await phone.call(`sip:${target}@${domain}`);
  } catch (error) {
    emit({ call: 'idle', remote: '' });
    throw error;
  }
}

/**
 * The two halves of the live call.
 *
 * Exposed so services/recorder.js can mix them; nothing else should reach in
 * here. Null unless a call is up.
 */
export const localStream = () => phone?.localMediaStream ?? null;
export const remoteStream = () => phone?.remoteMediaStream ?? null;

export const answer = () => phone?.answer();
export const decline = () => phone?.decline();
export const hangup = () => phone?.hangup();
export const mute = () => phone?.mute();
export const unmute = () => phone?.unmute();

/**
 * Send one DTMF digit to the far end.
 *
 * Over RTP (RFC 4733) first, falling back to SIP INFO.
 *
 * SimpleUser.sendDTMF() sends an INFO request with content type
 * application/dtmf-relay — its own docs say so. But PJSIP endpoints default to
 * `dtmf_mode = rfc4733`, and `webrtc = yes` does not change that, so Asterisk is
 * listening for telephone-events in the RTP stream and silently discards the
 * INFO. The digit never arrives, Read() times out, and the IVR appears dead.
 *
 * The Web session description handler exposes sendDtmf(), which drives the
 * browser's own RTCDTMFSender and emits RFC 4733 — exactly what Asterisk expects
 * by default. That is the primary path here.
 *
 * INFO is kept as a fallback rather than deleted: an endpoint deliberately set to
 * `dtmf_mode = info` would only accept that, and RTCDTMFSender is unavailable
 * until media is flowing. Trying the standard path first and INFO second means
 * both configurations work without anyone editing pjsip.conf.
 *
 * @param {string} key A single DTMF character: 0-9, * or #.
 * @returns {Promise<boolean>} Whether the digit was handed to a transport.
 */
export async function sendDTMF(key) {
  if (!phone?.session) return false;

  // RFC 4733 over RTP — what an unconfigured PJSIP endpoint expects.
  const handler = phone.session.sessionDescriptionHandler;
  if (typeof handler?.sendDtmf === 'function') {
    try {
      if (handler.sendDtmf(key)) return true;
    } catch (error) {
      console.warn('[phone] RFC 4733 DTMF failed, falling back to SIP INFO', error);
    }
  }

  // SIP INFO — for endpoints explicitly set to dtmf_mode = info.
  try {
    await phone.sendDTMF(key);
    return true;
  } catch (error) {
    console.warn('[phone] SIP INFO DTMF failed', error);
    return false;
  }
}
