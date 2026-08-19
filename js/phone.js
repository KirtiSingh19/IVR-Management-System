/**
 * Phone page.
 *
 * The screen only: every field, button and badge here reflects state owned by
 * js/phone-service.js, which holds the SIP registration. That split is what lets
 * the extension stay registered while the user is on the IVR pages — the service
 * runs on every page, this UI only exists on this one.
 *
 * So nothing below owns a UserAgent, and leaving the page tears down no calls.
 */

import { qs, qsa, delegate, formatDuration } from './utils.js';
import { toast } from './ui.js';
import * as phone from './phone-service.js';

/** Where the server and extension are remembered. Never the password. */
const SETTINGS_KEY = 'ivrm:phone:settings';

/** Keys the dial pad offers, laid out as a phone. */
const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** Ticks the call duration while a call is up. */
let durationTimer = null;

/* ==========================================================================
   Prerequisites
   ========================================================================== */

/**
 * Why the phone cannot work here, or null when it can.
 *
 * Both conditions are environmental — no amount of correct SIP configuration
 * overcomes them — so failing early with the actual reason saves debugging the
 * wrong layer.
 */
function checkPrerequisites() {
  if (!window.isSecureContext) {
    return (
      `This page is open at ${window.location.origin}, which the browser does not treat as a ` +
      'secure context, so it will not grant microphone access. Open it at ' +
      'http://127.0.0.1:5500 instead, or serve the site over HTTPS.'
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support getUserMedia, so it cannot place calls.';
  }
  if (!window.RTCPeerConnection) {
    return 'This browser does not support WebRTC.';
  }
  return null;
}

/* ==========================================================================
   Settings
   ========================================================================== */

function loadSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSettings({ server, extension }) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ server, extension }));
  } catch {
    /* Private mode. Only costs convenience. */
  }
}

/* ==========================================================================
   Rendering
   ========================================================================== */

/** Paint everything from one state object, so the UI cannot drift from it. */
function render(state) {
  const tone = { registered: 'ok', connecting: 'warn', failed: 'danger' }[state.status] ?? 'neutral';
  const label = {
    registered: 'Registered',
    connecting: 'Connecting…',
    failed: 'Not registered',
    idle: 'Not registered',
  }[state.status];

  qs('[data-phone-registration]').innerHTML =
    `<span class="status status--${tone}"><span class="status__dot" aria-hidden="true"></span>${label}</span>`;
  qs('[data-phone-registration-detail]').textContent = state.detail ?? '';

  const registered = state.status === 'registered';
  qs('[data-phone-register]').hidden = registered;
  qs('[data-phone-unregister]').hidden = !registered;
  qsa('[data-phone-requires-registration]').forEach((el) => {
    el.disabled = !registered;
  });

  // A restored session fills the form back in, so the page looks the way it did
  // before the user navigated away.
  if (state.extension && !qs('#phoneExtension').value) qs('#phoneExtension').value = state.extension;
  if (state.server && !qs('#phoneServer').value) qs('#phoneServer').value = state.server;

  renderCall(state);
}

function renderCall(state) {
  const call = state.call ?? 'idle';
  const remote = state.remote ?? '';

  qs('[data-phone-call-state]').textContent = {
    idle: 'No active call',
    outgoing: `Calling ${remote}…`,
    ringing: `Incoming call from ${remote}`,
    active: `In call with ${remote}`,
  }[call];

  qs('[data-phone-panel]').dataset.callState = call;
  qs('[data-phone-incoming]').hidden = call !== 'ringing';
  qs('[data-phone-answer]').hidden = call !== 'ringing';
  qs('[data-phone-reject]').hidden = call !== 'ringing';
  qs('[data-phone-hangup]').hidden = call === 'idle' || call === 'ringing';
  qs('[data-phone-mute]').hidden = call !== 'active';
  qs('[data-phone-call]').disabled = call !== 'idle' || state.status !== 'registered';

  if (call === 'active' && state.answeredAt) startTimer(state.answeredAt);
  else stopTimer();

  if (call === 'idle') {
    qs('[data-phone-duration]').textContent = '';
    paintMute(false);
  }
}

function paintMute(muted) {
  const button = qs('[data-phone-mute]');
  button.classList.toggle('is-active', muted);
  qs('i', button).className = `bi ${muted ? 'bi-mic-mute-fill' : 'bi-mic-fill'}`;
  button.setAttribute('aria-pressed', String(muted));
  qs('[data-phone-mute-label]', button).textContent = muted ? 'Unmute' : 'Mute';
}

function startTimer(answeredAt) {
  if (durationTimer) return;
  const tick = () => {
    qs('[data-phone-duration]').textContent = formatDuration((Date.now() - answeredAt) / 1000);
  };
  tick();
  durationTimer = setInterval(tick, 1000);
}

function stopTimer() {
  if (durationTimer) clearInterval(durationTimer);
  durationTimer = null;
}

/* ==========================================================================
   Actions
   ========================================================================== */

async function onRegister() {
  const server = qs('#phoneServer').value.trim();
  const extension = qs('#phoneExtension').value.trim();
  const password = qs('#phonePassword').value;

  if (!server || !extension || !password) {
    toast({ title: 'Missing details', text: 'Server, extension and password are all required.', tone: 'warn' });
    return;
  }

  const result = await phone.register({ server, extension, password });
  if (result.ok) {
    saveSettings({ server, extension });
    // Not kept in the field once the session holds it.
    qs('#phonePassword').value = '';
    return;
  }
  toast({ title: 'Could not register', text: result.message, tone: 'danger', delay: 10000 });
}

async function onCall() {
  const target = qs('#phoneNumber').value.trim();
  if (!target) {
    toast({ title: 'No number', text: 'Enter an extension to call.', tone: 'warn' });
    return;
  }
  try {
    await phone.call(target, qs('#phoneServer').value);
  } catch (error) {
    console.error('[phone] call failed', error);
    toast({ title: 'Call failed', text: error.message ?? 'Asterisk rejected the call.', tone: 'danger' });
  }
}

let muted = false;

function onMute() {
  muted = !muted;
  if (muted) phone.mute();
  else phone.unmute();
  paintMute(muted);
}

/* ==========================================================================
   Init
   ========================================================================== */

export async function init() {
  qs('[data-phone-keypad]').innerHTML = KEYPAD.map(
    (key) => `<button class="keypad__key" type="button" data-key="${key}">${key}</button>`,
  ).join('');

  const settings = loadSettings();
  if (settings.server) qs('#phoneServer').value = settings.server;
  if (settings.extension) qs('#phoneExtension').value = settings.extension;

  const blocked = checkPrerequisites();
  if (blocked) {
    qs('[data-phone-blocked]').hidden = false;
    qs('[data-phone-blocked-reason]').textContent = blocked;
    qs('[data-phone-register]').disabled = true;
    return;
  }

  // Paints now and on every later change, including a session app.js restored
  // before this page's controller ran.
  phone.subscribe(render);

  qs('[data-phone-register]').addEventListener('click', onRegister);
  qs('[data-phone-unregister]').addEventListener('click', () => phone.unregister());
  qs('[data-phone-call]').addEventListener('click', onCall);
  qs('[data-phone-answer]').addEventListener('click', () => phone.answer());
  qs('[data-phone-reject]').addEventListener('click', () => phone.decline());
  qs('[data-phone-hangup]').addEventListener('click', () => phone.hangup());
  qs('[data-phone-mute]').addEventListener('click', onMute);

  // Typing a digit appends to the number; during a call it is sent as DTMF, so
  // the pad keeps working for IVRs on the far end.
  delegate(qs('[data-phone-keypad]'), 'click', '[data-key]', (_event, button) => {
    const key = button.dataset.key;
    if (phone.current().call === 'active') {
      phone.sendDTMF(key)?.catch?.((error) => console.warn('[phone] DTMF failed', error));
      return;
    }
    qs('#phoneNumber').value += key;
  });

  qs('[data-phone-clear]').addEventListener('click', () => {
    qs('#phoneNumber').value = '';
  });

  qs('#phoneNumber').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && phone.isRegistered()) onCall();
  });

  // Deliberately no beforeunload hang-up. Leaving this page no longer ends the
  // registration, so ending the call here would defeat the point.
}
