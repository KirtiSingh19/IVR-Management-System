/**
 * Test IVR controller — the call simulator.
 *
 * Walks a call through whatever menu the flow builder holds for the selected
 * IVR. Nothing is dialled and nothing leaves the browser; this is the same
 * data the Asterisk dialplan will be generated from in Stage 2, played back
 * by hand.
 *
 * The keypad is a real DTMF pad: pressing a key sounds the genuine dual-tone
 * frequency pair through the Web Audio API, and physical number keys work too.
 */

import { qs, qsa, escapeHtml, formatClock, getParam } from './utils.js';
import { IvrRepo, AudioRepo, FlowRepo } from './repo.js';
import { PROMPT_SCRIPTS } from '../data/demo-data.js';

/* ==========================================================================
   Keypad definition
   --------------------------------------------------------------------------
   DTMF encodes each key as one low (row) tone plus one high (column) tone.
   These are the ITU-T Q.23 frequencies, which is what makes the pad sound
   like a telephone rather than like a synthesiser.
   ========================================================================== */

const ROW_FREQUENCIES = [697, 770, 852, 941];
const COLUMN_FREQUENCIES = [1209, 1336, 1477];

/** Grid order, with the letter groups that make a keypad read as a keypad. */
const KEYPAD = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

/** @returns {[number, number]|null} the tone pair for a key. */
function tonesFor(digit) {
  const index = KEYPAD.findIndex((key) => key.digit === digit);
  if (index === -1) return null;
  return [ROW_FREQUENCIES[Math.floor(index / 3)], COLUMN_FREQUENCIES[index % 3]];
}

/* ==========================================================================
   Tone generator
   ========================================================================== */

/**
 * Created on the first key press, not on page load: browsers refuse to start
 * an AudioContext without a user gesture, and one created too early sits
 * suspended.
 */
let audioContext = null;

function playDtmf(digit) {
  const tones = tonesFor(digit);
  if (!tones) return;

  try {
    audioContext ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
  } catch {
    return; // no Web Audio available; the simulator still works silently
  }

  const now = audioContext.currentTime;
  const duration = 0.16;

  // A shared gain node with a short ramp at each end. Without the ramp the
  // abrupt start and stop produce an audible click on top of the tone.
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.012);
  gain.gain.setValueAtTime(0.14, now + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, now + duration);
  gain.connect(audioContext.destination);

  for (const frequency of tones) {
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }
}

/* ==========================================================================
   Call state
   ========================================================================== */

/**
 * `transferred` is the moment after a key is pressed, while the option's own
 * prompt plays; `connected` is once that prompt has finished and the call has
 * reached its destination. Keeping them apart is what lets the simulator hold on
 * the prompt rather than jumping straight to the result.
 *
 * @typedef {'idle'|'greeting'|'menu'|'transferred'|'connected'|'ended'} CallState
 */
const call = {
  /** @type {CallState} */ state: 'idle',
  /** @type {import('../data/demo-data.js').Ivr|null} */ ivr: null,
  /** @type {Array} */ options: [],
  /** @type {string|null} */ selectedDigit: null,
};

/** The states in which the line is up, so hang-up and restart are available. */
const LIVE_STATES = new Set(['greeting', 'menu', 'transferred', 'connected']);

/** Plays the IVR's welcome prompt, when the library still holds it. */
const promptPlayer = new Audio();

/** Timer for the greeting-to-menu transition, so it can be cancelled. */
let greetingTimer = null;

/** Timer for the transfer-to-connected transition. */
let transferTimer = null;

/**
 * Drop every pending transition.
 *
 * Called wherever the call changes course, so a timer armed by the previous step
 * cannot fire into the new one — a greeting timer landing after the caller has
 * hung up used to be impossible only by luck of ordering.
 */
function clearCallTimers() {
  clearTimeout(greetingTimer);
  clearTimeout(transferTimer);
}

/** Spoken text for a prompt file, for the readout. */
function scriptFor(fileName) {
  if (!fileName) return null;
  return PROMPT_SCRIPTS[fileName] ?? `Plays ${fileName}.`;
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function renderKeypad() {
  const keypad = qs('#keypad');
  const mapped = new Set(call.options.map((option) => option.digit));

  keypad.innerHTML = KEYPAD.map(
    ({ digit, letters }) => `
      <button
        class="keypad__key${mapped.has(digit) ? ' is-mapped' : ''}"
        type="button"
        data-digit="${escapeHtml(digit)}"
        aria-label="${
          mapped.has(digit)
            ? `Press ${digit} for ${escapeHtml(
                call.options.find((option) => option.digit === digit).label,
              )}`
            : `Press ${digit}`
        }"
      >
        <span class="keypad__digit" aria-hidden="true">${escapeHtml(digit)}</span>
        <span class="keypad__letters" aria-hidden="true">${escapeHtml(letters)}</span>
      </button>`,
  ).join('');
}

function renderOptionList() {
  const list = qs('[data-option-list]');

  if (!call.options.length) {
    list.innerHTML = `
      <li>
        <div class="empty-state tw-py-8">
          <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-list-ol"></i></span>
          <p class="empty-state__title">This IVR has no menu yet</p>
          <p class="empty-state__body">
            Callers would hear the welcome prompt and nothing more. Add options and they will
            appear here.
          </p>
          <a class="btn btn-primary btn-sm" href="edit-ivr.html?id=${encodeURIComponent(
            call.ivr.id,
          )}">
            <i class="bi bi-pencil" aria-hidden="true"></i>
            Build the menu
          </a>
        </div>
      </li>`;
    return;
  }

  list.innerHTML = call.options
    .map(
      (option) => `
        <li>
          <button class="option-item${
            call.selectedDigit === option.digit ? ' is-selected' : ''
          }" type="button" data-digit="${escapeHtml(option.digit)}">
            <span class="option-item__digit" aria-hidden="true">${escapeHtml(option.digit)}</span>
            <span>
              <span class="option-item__label">${escapeHtml(option.label)}</span>
              <span class="option-item__dest">
                Extension <span class="num">${escapeHtml(option.destination)}</span>
              </span>
            </span>
            <i class="bi bi-chevron-right option-item__go" aria-hidden="true"></i>
          </button>
        </li>`,
    )
    .join('');
}

/** The dialplan tree: the IVR at the root, one branch per menu option. */
function renderDialplan() {
  const canvas = qs('[data-dialplan]');

  if (!call.options.length) {
    canvas.innerHTML = `
      <div class="empty-state">
        <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-diagram-2"></i></span>
        <p class="empty-state__title">Nothing to draw yet</p>
        <p class="empty-state__body">The dialplan appears once this IVR has at least one option.</p>
      </div>`;
    return;
  }

  canvas.innerHTML = `
    <div class="dialplan__canvas">
      <div class="dialplan__root">
        <div class="dp-node dp-node--root">
          <p class="dp-node__name">${escapeHtml(call.ivr.name)}</p>
          <span class="dp-node__ext">${escapeHtml(call.ivr.extension)}</span>
        </div>
      </div>
      <div class="dialplan__branches">
        ${call.options
          .map(
            (option) => `
              <div class="dialplan__branch">
                <div class="dp-node${
                  call.selectedDigit === option.digit ? ' is-selected' : ''
                }" data-node-digit="${escapeHtml(option.digit)}">
                  <span class="dp-node__digit" aria-hidden="true">${escapeHtml(option.digit)}</span>
                  <p class="dp-node__name">${escapeHtml(option.label)}</p>
                  <span class="dp-node__ext">${escapeHtml(option.destination)}</span>
                </div>
              </div>`,
          )
          .join('')}
      </div>
    </div>`;
}

/** Paint the call state indicator and the transport buttons. */
function renderCallState() {
  const isLive = LIVE_STATES.has(call.state);

  const indicator = qs('[data-sim-state]');
  indicator.classList.toggle('is-live', isLive);
  qs('[data-sim-state-text]').textContent = {
    idle: 'Idle',
    greeting: 'In call',
    menu: 'In call',
    transferred: 'Transferring',
    connected: 'Connected',
    ended: 'Call ended',
  }[call.state];

  qs('[data-call-start]').disabled = isLive;
  qs('[data-call-end]').disabled = !isLive;
  qs('[data-call-restart]').disabled = !isLive;
}

/** The prompt readout: what the caller is hearing right now. */
function renderScreen({ eyebrow, prompt, detail = '', destination = null }) {
  qs('[data-sim-screen]').innerHTML = `
    <p class="sim-screen__eyebrow">${escapeHtml(eyebrow)}</p>
    <p class="sim-screen__prompt">${escapeHtml(prompt)}</p>
    ${detail ? `<p class="sim-screen__detail">${escapeHtml(detail)}</p>` : ''}
    ${
      destination
        ? `<span class="sim-screen__dest">
             <i class="bi bi-arrow-right-circle" aria-hidden="true"></i>
             Extension ${escapeHtml(destination)}
           </span>`
        : ''
    }`;
}

/* ==========================================================================
   Call log
   ========================================================================== */

let logIsEmpty = true;

function log(text, kind = 'system') {
  const list = qs('[data-sim-log]');
  if (logIsEmpty) {
    list.innerHTML = '';
    logIsEmpty = false;
  }

  const entry = document.createElement('li');
  entry.className = `sim-log__entry sim-log__entry--${kind}`;
  entry.innerHTML = `
    <span class="sim-log__time">${escapeHtml(formatClock())}</span>
    <p class="sim-log__text">${escapeHtml(text)}</p>`;
  list.append(entry);
  list.scrollTop = list.scrollHeight;
}

function clearLog() {
  qs('[data-sim-log]').innerHTML = `
    <li class="sim-log__entry">
      <span class="sim-log__time">--:--:--</span>
      <p class="sim-log__text">No call yet.</p>
    </li>`;
  logIsEmpty = true;
}

/* ==========================================================================
   Call flow
   ========================================================================== */

/** Read the menu out, the way the IVR would. */
function menuSentence() {
  if (!call.options.length) return 'This menu has no options.';
  return call.options
    .map((option) => `Press ${option.digit} for ${option.label}.`)
    .join(' ');
}

function goToMenu({ announce = true } = {}) {
  call.state = 'menu';
  call.selectedDigit = null;

  renderScreen({
    eyebrow: 'Main menu',
    prompt: menuSentence(),
    detail: 'Press a key on the pad, your keyboard, or pick an option from the list.',
  });
  renderCallState();
  renderOptionList();
  renderDialplan();
  if (announce) log('Menu offered to caller.');
}

async function startCall() {
  clearCallTimers();

  call.state = 'greeting';
  call.selectedDigit = null;
  renderCallState();
  renderOptionList();
  renderDialplan();

  log(`Call connected to ${call.ivr.name} on extension ${call.ivr.extension}.`);

  const script = scriptFor(call.ivr.welcomeAudio);
  renderScreen({
    eyebrow: 'Welcome message',
    prompt: script ?? 'No welcome prompt is assigned to this IVR.',
    detail: call.ivr.welcomeAudio ? `Playing ${call.ivr.welcomeAudio}` : 'Going straight to the menu.',
  });

  // Play the real prompt when the library still holds it.
  let promptIsSounding = false;
  if (call.ivr.welcomeAudio) {
    log(`Playing welcome prompt: ${call.ivr.welcomeAudio}.`);
    try {
      const file = await AudioRepo.byName(call.ivr.welcomeAudio);
      const source = file ? AudioRepo.sourceFor(file) : null;
      if (source) {
        promptPlayer.src = source;
        await promptPlayer.play();
        promptIsSounding = true;
      }
    } catch (error) {
      // Autoplay refusal or a missing file. The simulation continues silently.
      console.warn('[test-ivr] the welcome prompt could not be played', error);
    }
  }

  // Guarded so it is harmless if the caller has already pressed a key or hung
  // up by the time it runs.
  const openMenu = () => {
    if (call.state === 'greeting') goToMenu();
  };

  if (promptIsSounding) {
    // Follow the actual prompt: the menu is read out when the greeting
    // finishes, which is what a real IVR does. The timer is only a safety net
    // for the case where 'ended' never arrives, such as a backgrounded tab.
    promptPlayer.addEventListener('ended', openMenu, { once: true });
    const remaining = Number.isFinite(promptPlayer.duration) ? promptPlayer.duration : 5;
    greetingTimer = setTimeout(openMenu, remaining * 1000 + 600);
  } else {
    // No audio to wait on, so pause briefly instead, to keep the greeting a
    // distinct step rather than a flash.
    greetingTimer = setTimeout(openMenu, 1200);
  }
}

function endCall({ reason = 'Caller hung up.' } = {}) {
  clearCallTimers();
  promptPlayer.pause();

  call.state = 'ended';
  call.selectedDigit = null;

  renderScreen({
    eyebrow: 'Call ended',
    prompt: 'The line is clear.',
    detail: 'Press Call to dial this IVR again.',
  });
  renderCallState();
  renderOptionList();
  renderDialplan();
  log(reason);
}

/** Handle one key press. */
function pressDigit(digit) {
  playDtmf(digit);
  flashKey(digit);

  // Pressing a key on an idle line dials first, the way picking up and dialling
  // would. The digit is then applied once the greeting is out of the way.
  if (call.state === 'idle' || call.state === 'ended') {
    startCall();
    log(`Caller pressed ${digit}.`, 'input');
    clearTimeout(greetingTimer);
    greetingTimer = setTimeout(() => {
      goToMenu({ announce: false });
      applyDigit(digit);
    }, 900);
    return;
  }

  // Pressing during the greeting skips it, which is what impatient callers do.
  if (call.state === 'greeting') {
    clearTimeout(greetingTimer);
    promptPlayer.pause();
    goToMenu({ announce: false });
  }

  log(`Caller pressed ${digit}.`, 'input');
  applyDigit(digit);
}

async function applyDigit(digit) {
  const option = call.options.find((candidate) => candidate.digit === digit);

  if (!option) {
    // Exactly what a real IVR does: say so and re-offer the menu.
    renderScreen({
      eyebrow: 'Invalid option',
      prompt: 'That is not a valid option. Please try again.',
      detail: menuSentence(),
    });
    log(`No menu option for ${digit}; invalid-option prompt played.`);
    call.selectedDigit = null;
    renderOptionList();
    renderDialplan();
    return;
  }

  // Silence whatever was playing. Choosing a second option must not leave the
  // first option's prompt sounding underneath the new one.
  clearTimeout(transferTimer);
  promptPlayer.pause();

  call.state = 'transferred';
  call.selectedDigit = digit;

  renderScreen({
    eyebrow: `You selected ${digit}`,
    prompt: option.label,
    detail: option.audioFile ? `Playing ${option.audioFile}` : 'Transferring the call now.',
    destination: option.destination,
  });
  log(`Transferring to ${option.label} on extension ${option.destination}.`);

  renderCallState();
  renderOptionList();
  renderDialplan();

  // The option's own prompt is what the caller hears while the transfer happens.
  // The call is held in `transferred` for as long as it plays, then connects —
  // which is why this is a separate state rather than the end of the story.
  let promptIsSounding = false;
  if (option.audioFile) {
    log(`Playing transfer prompt: ${option.audioFile}.`);
    try {
      const file = await AudioRepo.byName(option.audioFile);
      const source = file ? AudioRepo.sourceFor(file) : null;
      if (source) {
        promptPlayer.src = source;
        await promptPlayer.play();
        promptIsSounding = true;
      } else {
        log(`${option.audioFile} is not in the audio library; transferring in silence.`);
      }
    } catch (error) {
      // Autoplay refusal, or a prompt missing from the server. Either way the
      // transfer still has to complete — the caller is not left in limbo.
      console.warn('[test-ivr] the transfer prompt could not be played', error);
    }
  }

  // Guarded on both the state and the digit: the caller may have hung up, or
  // pressed a different key, while the prompt was still playing.
  const connect = () => {
    if (call.state !== 'transferred' || call.selectedDigit !== digit) return;
    connectCall(option);
  };

  if (promptIsSounding) {
    promptPlayer.addEventListener('ended', connect, { once: true });
    // Safety net for a backgrounded tab, where 'ended' may never fire.
    const remaining = Number.isFinite(promptPlayer.duration) ? promptPlayer.duration : 5;
    transferTimer = setTimeout(connect, remaining * 1000 + 600);
  } else {
    transferTimer = setTimeout(connect, 900);
  }
}

/** The transfer prompt has finished and the destination has picked up. */
function connectCall(option) {
  call.state = 'connected';

  renderScreen({
    eyebrow: 'Connected',
    prompt: `The caller is through to ${option.label}.`,
    detail: `Extension ${option.destination} answered.`,
    destination: option.destination,
  });
  log(`Connected to ${option.label} on extension ${option.destination}.`);

  renderCallState();
  renderOptionList();
  renderDialplan();
}

/** Brief visual echo of a key press, for keyboard use where there is no hover. */
function flashKey(digit) {
  const key = qs(`.keypad__key[data-digit="${CSS.escape(digit)}"]`);
  if (!key) return;
  key.classList.add('is-pressed');
  setTimeout(() => key.classList.remove('is-pressed'), 130);
}

/* ==========================================================================
   IVR selection
   ========================================================================== */

async function selectIvr(id) {
  clearCallTimers();
  promptPlayer.pause();

  call.ivr = await IvrRepo.get(id);
  call.options = await FlowRepo.list(id);
  call.state = 'idle';
  call.selectedDigit = null;

  qs('[data-sim-ivr-name]').textContent = call.ivr.name;
  qs('[data-sim-ivr-ext]').textContent = `Ext ${call.ivr.extension}`;
  qsa('[data-edit-link]').forEach((link) => {
    link.href = `edit-ivr.html?id=${encodeURIComponent(call.ivr.id)}`;
  });

  renderScreen({
    eyebrow: 'Not connected',
    prompt: `Press Call to dial ${call.ivr.name}.`,
    detail: call.options.length
      ? 'The welcome prompt plays first, then the menu is read out.'
      : 'This IVR has no menu options yet, so there will be nothing to choose.',
  });

  renderKeypad();
  renderOptionList();
  renderDialplan();
  renderCallState();
  clearLog();
}

/* ==========================================================================
   Init
   ========================================================================== */

export async function init() {
  const ivrs = await IvrRepo.all();

  if (!ivrs.length) {
    qs('[data-no-ivrs]').hidden = false;
    qs('#testIvrSelect').disabled = true;
    return;
  }

  qs('[data-test-body]').hidden = false;

  const select = qs('#testIvrSelect');
  select.innerHTML = ivrs
    .map(
      (ivr) =>
        `<option value="${escapeHtml(ivr.id)}">${escapeHtml(ivr.name)} · ${escapeHtml(
          ivr.extension,
        )}</option>`,
    )
    .join('');

  // ?id= preselects an IVR, so "Test" from the list lands on the right one.
  const requestedId = getParam('id');
  const initialId = ivrs.some((ivr) => ivr.id === requestedId) ? requestedId : ivrs[0].id;
  select.value = initialId;
  await selectIvr(initialId);

  select.addEventListener('change', (event) => selectIvr(event.target.value));

  // Keypad, option list and transport controls all funnel into pressDigit.
  qs('#keypad').addEventListener('click', (event) => {
    const key = event.target.closest('[data-digit]');
    if (key) pressDigit(key.dataset.digit);
  });

  qs('[data-option-list]').addEventListener('click', (event) => {
    const option = event.target.closest('[data-digit]');
    if (option) pressDigit(option.dataset.digit);
  });

  qs('[data-call-start]').addEventListener('click', startCall);
  qs('[data-call-end]').addEventListener('click', () => endCall());
  qs('[data-call-restart]').addEventListener('click', () => {
    goToMenu();
    log('Caller returned to the main menu.');
  });
  qs('[data-clear-log]').addEventListener('click', clearLog);

  // Physical keyboard. Ignored while the user is typing into a field, so the
  // search box and the select are unaffected.
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target.matches('input, textarea, select') || target.isContentEditable) return;
    if (!/^[0-9*#]$/.test(event.key)) return;
    event.preventDefault();
    pressDigit(event.key);
  });

  // Menu edited in another tab, or in the flow builder.
  FlowRepo.onChange(async () => {
    call.options = await FlowRepo.list(call.ivr.id);
    renderKeypad();
    renderOptionList();
    renderDialplan();
  });
}
