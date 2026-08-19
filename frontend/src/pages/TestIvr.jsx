/**
 * Test IVR — the call simulator. Ported from pages/test-ivr.html + js/test-ivr.js.
 *
 * Walks a call through whatever menu the flow builder holds for the selected
 * IVR. Nothing is dialled; this is the same data the Asterisk dialplan is
 * generated from, played back by hand.
 *
 * WHY THE CALL LIVES IN A REF
 *
 * The original was a state machine driven by timers, with `call.state` read from
 * inside timer callbacks and audio event handlers. Putting that in useState
 * alone would break it: a callback armed in one render closes over the state as
 * it was then, so a timer fired after a hang-up would see a live call and press
 * on. The ref holds the truth that callbacks read; the state mirror exists only
 * so React re-renders. They are written together, never separately.
 *
 * Unlike the phone, tearing everything down on unmount is right here — this is a
 * simulation local to the page, not a connection anyone is relying on.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { IvrRepo, AudioRepo, FlowRepo } from '../services/repo.js';
import { PROMPT_SCRIPTS } from '../data/demo-data.js';
import { formatClock } from '../services/utils.js';
import { KEYPAD, playDtmf } from '../services/dtmf.js';

/** The states in which the line is up, so hang-up and restart are available. */
const LIVE_STATES = new Set(['greeting', 'menu', 'transferred', 'connected']);

const STATE_LABELS = {
  idle: 'Idle',
  greeting: 'In call',
  menu: 'In call',
  transferred: 'Transferring',
  connected: 'Connected',
  ended: 'Call ended',
};

/** Spoken text for a prompt file, for the readout. */
function scriptFor(fileName) {
  if (!fileName) return null;
  return PROMPT_SCRIPTS[fileName] ?? `Plays ${fileName}.`;
}

export default function TestIvr() {
  const [params] = useSearchParams();

  const [ivrs, setIvrs] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [ivr, setIvr] = useState(null);
  const [options, setOptions] = useState([]);

  const [callState, setCallState] = useState('idle');
  const [selectedDigit, setSelectedDigit] = useState(null);
  const [screen, setScreen] = useState({ eyebrow: '', prompt: '', detail: '', destination: null });
  const [entries, setEntries] = useState([]);
  const [pressed, setPressed] = useState(null);

  // The authoritative call state, readable from timers and audio callbacks.
  const call = useRef({ state: 'idle', selectedDigit: null, options: [], ivr: null });
  const promptPlayer = useRef(null);
  const greetingTimer = useRef(null);
  const transferTimer = useRef(null);

  /** Write the ref and the mirror together, so they can never disagree. */
  const setState = useCallback((next) => {
    call.current.state = next;
    setCallState(next);
  }, []);

  const setDigit = useCallback((digit) => {
    call.current.selectedDigit = digit;
    setSelectedDigit(digit);
  }, []);

  const log = useCallback((text, kind = 'system') => {
    setEntries((current) => [...current, { id: `${Date.now()}-${current.length}`, time: formatClock(), text, kind }]);
  }, []);

  /** Drop every pending transition, so a timer armed by a previous step cannot fire into a new one. */
  const clearCallTimers = useCallback(() => {
    clearTimeout(greetingTimer.current);
    clearTimeout(transferTimer.current);
  }, []);

  useEffect(() => {
    promptPlayer.current = new Audio();
    return () => {
      clearTimeout(greetingTimer.current);
      clearTimeout(transferTimer.current);
      promptPlayer.current?.pause();
      promptPlayer.current = null;
    };
  }, []);

  /* ---------------------------------------------------------------- loading */

  useEffect(() => {
    IvrRepo.all().then((all) => {
      setIvrs(all);
      if (!all.length) return;
      const requested = params.get('id');
      setSelectedId(all.some((entry) => entry.id === requested) ? requested : all[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectIvr = useCallback(
    async (id) => {
      clearCallTimers();
      promptPlayer.current?.pause();

      const [record, menu] = await Promise.all([IvrRepo.get(id), FlowRepo.list(id)]);
      call.current.ivr = record;
      call.current.options = menu;
      setIvr(record);
      setOptions(menu);
      setState('idle');
      setDigit(null);
      setEntries([]);
      setScreen({
        eyebrow: 'Not connected',
        prompt: `Press Call to dial ${record.name}.`,
        detail: menu.length
          ? 'The welcome prompt plays first, then the menu is read out.'
          : 'This IVR has no menu options yet, so there will be nothing to choose.',
        destination: null,
      });
    },
    [clearCallTimers, setDigit, setState],
  );

  useEffect(() => {
    if (selectedId) selectIvr(selectedId);
  }, [selectedId, selectIvr]);

  // Menu edited in the flow builder, in this tab.
  useEffect(() => {
    if (!ivr) return undefined;
    return FlowRepo.onChange(async () => {
      const menu = await FlowRepo.list(ivr.id);
      call.current.options = menu;
      setOptions(menu);
    });
  }, [ivr]);

  /* ------------------------------------------------------------- call flow */

  const menuSentence = useCallback(() => {
    const menu = call.current.options;
    if (!menu.length) return 'This menu has no options.';
    return menu.map((option) => `Press ${option.digit} for ${option.label}.`).join(' ');
  }, []);

  const goToMenu = useCallback(
    ({ announce = true } = {}) => {
      setState('menu');
      setDigit(null);
      setScreen({
        eyebrow: 'Main menu',
        prompt: menuSentence(),
        detail: 'Press a key on the pad, your keyboard, or pick an option from the list.',
        destination: null,
      });
      if (announce) log('Menu offered to caller.');
    },
    [log, menuSentence, setDigit, setState],
  );

  const connectCall = useCallback(
    (option) => {
      setState('connected');
      setScreen({
        eyebrow: 'Connected',
        prompt: `The caller is through to ${option.label}.`,
        detail: `Extension ${option.destination} answered.`,
        destination: option.destination,
      });
      log(`Connected to ${option.label} on extension ${option.destination}.`);
    },
    [log, setState],
  );

  const applyDigit = useCallback(
    async (digit) => {
      const option = call.current.options.find((candidate) => candidate.digit === digit);

      if (!option) {
        // Exactly what a real IVR does: say so and re-offer the menu.
        setScreen({
          eyebrow: 'Invalid option',
          prompt: 'That is not a valid option. Please try again.',
          detail: menuSentence(),
          destination: null,
        });
        log(`No menu option for ${digit}; invalid-option prompt played.`);
        setDigit(null);
        return;
      }

      // Silence whatever was playing: choosing a second option must not leave
      // the first option's prompt sounding underneath the new one.
      clearTimeout(transferTimer.current);
      promptPlayer.current?.pause();

      setState('transferred');
      setDigit(digit);
      setScreen({
        eyebrow: `You selected ${digit}`,
        prompt: option.label,
        detail: option.audioFile ? `Playing ${option.audioFile}` : 'Transferring the call now.',
        destination: option.destination,
      });
      log(`Transferring to ${option.label} on extension ${option.destination}.`);

      let sounding = false;
      if (option.audioFile) {
        log(`Playing transfer prompt: ${option.audioFile}.`);
        try {
          const file = await AudioRepo.byName(option.audioFile);
          const source = file ? AudioRepo.sourceFor(file) : null;
          if (source && promptPlayer.current) {
            promptPlayer.current.src = source;
            await promptPlayer.current.play();
            sounding = true;
          } else {
            log(`${option.audioFile} is not in the audio library; transferring in silence.`);
          }
        } catch (error) {
          console.warn('[test-ivr] the transfer prompt could not be played', error);
        }
      }

      // Guarded on both state and digit: the caller may have hung up, or pressed
      // a different key, while the prompt was still playing.
      const connect = () => {
        if (call.current.state !== 'transferred' || call.current.selectedDigit !== digit) return;
        connectCall(option);
      };

      if (sounding && promptPlayer.current) {
        promptPlayer.current.addEventListener('ended', connect, { once: true });
        const remaining = Number.isFinite(promptPlayer.current.duration) ? promptPlayer.current.duration : 5;
        transferTimer.current = setTimeout(connect, remaining * 1000 + 600);
      } else {
        transferTimer.current = setTimeout(connect, 900);
      }
    },
    [connectCall, log, menuSentence, setDigit, setState],
  );

  const startCall = useCallback(async () => {
    clearCallTimers();
    setState('greeting');
    setDigit(null);

    const record = call.current.ivr;
    log(`Call connected to ${record.name} on extension ${record.extension}.`);

    const script = scriptFor(record.welcomeAudio);
    setScreen({
      eyebrow: 'Welcome message',
      prompt: script ?? 'No welcome prompt is assigned to this IVR.',
      detail: record.welcomeAudio ? `Playing ${record.welcomeAudio}` : 'Going straight to the menu.',
      destination: null,
    });

    let sounding = false;
    if (record.welcomeAudio) {
      log(`Playing welcome prompt: ${record.welcomeAudio}.`);
      try {
        const file = await AudioRepo.byName(record.welcomeAudio);
        const source = file ? AudioRepo.sourceFor(file) : null;
        if (source && promptPlayer.current) {
          promptPlayer.current.src = source;
          await promptPlayer.current.play();
          sounding = true;
        }
      } catch (error) {
        // Autoplay refusal or a missing file. The simulation continues silently.
        console.warn('[test-ivr] the welcome prompt could not be played', error);
      }
    }

    const openMenu = () => {
      if (call.current.state === 'greeting') goToMenu();
    };

    if (sounding && promptPlayer.current) {
      // Follow the actual prompt: the menu is read out when the greeting
      // finishes, which is what a real IVR does. The timer is a safety net for
      // a backgrounded tab, where 'ended' may never arrive.
      promptPlayer.current.addEventListener('ended', openMenu, { once: true });
      const remaining = Number.isFinite(promptPlayer.current.duration) ? promptPlayer.current.duration : 5;
      greetingTimer.current = setTimeout(openMenu, remaining * 1000 + 600);
    } else {
      // Nothing to wait on, so pause briefly instead, to keep the greeting a
      // distinct step rather than a flash.
      greetingTimer.current = setTimeout(openMenu, 1200);
    }
  }, [clearCallTimers, goToMenu, log, setDigit, setState]);

  const endCall = useCallback(
    ({ reason = 'Caller hung up.' } = {}) => {
      clearCallTimers();
      promptPlayer.current?.pause();
      setState('ended');
      setDigit(null);
      setScreen({
        eyebrow: 'Call ended',
        prompt: 'The line is clear.',
        detail: 'Press Call to dial this IVR again.',
        destination: null,
      });
      log(reason);
    },
    [clearCallTimers, log, setDigit, setState],
  );

  const pressDigit = useCallback(
    (digit) => {
      playDtmf(digit);
      setPressed(digit);
      setTimeout(() => setPressed(null), 130);

      const state = call.current.state;

      // Pressing a key on an idle line dials first, the way picking up and
      // dialling would. The digit is applied once the greeting is out of the way.
      if (state === 'idle' || state === 'ended') {
        startCall();
        log(`Caller pressed ${digit}.`, 'input');
        clearTimeout(greetingTimer.current);
        greetingTimer.current = setTimeout(() => {
          goToMenu({ announce: false });
          applyDigit(digit);
        }, 900);
        return;
      }

      // Pressing during the greeting skips it, which is what impatient callers do.
      if (state === 'greeting') {
        clearTimeout(greetingTimer.current);
        promptPlayer.current?.pause();
        goToMenu({ announce: false });
      }

      log(`Caller pressed ${digit}.`, 'input');
      applyDigit(digit);
    },
    [applyDigit, goToMenu, log, startCall],
  );

  // Physical keyboard. Ignored while typing into a field, so the select and any
  // search box are unaffected.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target.matches?.('input, textarea, select') || target.isContentEditable) return;
      if (!/^[0-9*#]$/.test(event.key)) return;
      event.preventDefault();
      pressDigit(event.key);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pressDigit]);

  /* --------------------------------------------------------------- render */

  const isLive = LIVE_STATES.has(callState);
  const mapped = new Set(options.map((option) => option.digit));

  if (ivrs && ivrs.length === 0) {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-header__title">Test IVR</h1>
          </div>
        </div>
        <section className="card">
          <div className="card-body">
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                <i className="bi bi-diagram-3" />
              </span>
              <p className="empty-state__title">There is nothing to test yet</p>
              <p className="empty-state__body">Create an IVR and you can walk a call through it here.</p>
              <Link className="btn btn-primary btn-sm" to="/create-ivr">
                <i className="bi bi-plus-lg" aria-hidden="true" /> Create IVR
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Test IVR</h1>
          <p className="page-header__subtitle">
            Dial an IVR and press keys the way a caller would. This is a simulation &mdash; no real
            call is placed and no switch is contacted.
          </p>
        </div>
        <div className="page-header__actions">
          <label className="visually-hidden" htmlFor="testIvrSelect">
            Choose an IVR
          </label>
          <select
            className="form-select"
            id="testIvrSelect"
            value={selectedId ?? ''}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {(ivrs ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.extension}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-lg-5">
          <section className="card h-100" aria-labelledby="simHeading">
            <div className="card-header">
              <div>
                <h2 id="simHeading">Call simulator</h2>
                <p className="card-header__hint">{ivr ? `Extension ${ivr.extension}` : ''}</p>
              </div>
              <span className={`sim-state${isLive ? ' is-live' : ''}`}>
                <span className="sim-state__dot" aria-hidden="true" />
                {STATE_LABELS[callState]}
              </span>
            </div>

            <div className="card-body">
              <div className="sim-screen">
                <p className="sim-screen__eyebrow">{screen.eyebrow}</p>
                <p className="sim-screen__prompt">{screen.prompt}</p>
                {screen.detail ? <p className="sim-screen__detail">{screen.detail}</p> : null}
                {screen.destination ? (
                  <span className="sim-screen__dest">
                    <i className="bi bi-arrow-right-circle" aria-hidden="true" />
                    Extension {screen.destination}
                  </span>
                ) : null}
              </div>

              <div className="keypad" id="keypad">
                {KEYPAD.map(({ digit, letters }) => (
                  <button
                    key={digit}
                    className={`keypad__key${mapped.has(digit) ? ' is-mapped' : ''}${
                      pressed === digit ? ' is-pressed' : ''
                    }`}
                    type="button"
                    aria-label={
                      mapped.has(digit)
                        ? `Press ${digit} for ${options.find((option) => option.digit === digit).label}`
                        : `Press ${digit}`
                    }
                    onClick={() => pressDigit(digit)}
                  >
                    <span className="keypad__digit" aria-hidden="true">
                      {digit}
                    </span>
                    <span className="keypad__letters" aria-hidden="true">
                      {letters}
                    </span>
                  </button>
                ))}
              </div>

              <div className="sim-transport">
                <button className="btn btn-success" type="button" onClick={startCall} disabled={isLive}>
                  <i className="bi bi-telephone-fill" aria-hidden="true" /> Call
                </button>
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  onClick={() => {
                    goToMenu();
                    log('Caller returned to the main menu.');
                  }}
                  disabled={!isLive}
                >
                  <i className="bi bi-arrow-counterclockwise" aria-hidden="true" /> Main menu
                </button>
                <button className="btn btn-danger" type="button" onClick={() => endCall()} disabled={!isLive}>
                  <i className="bi bi-telephone-x-fill" aria-hidden="true" /> Hang up
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="col-12 col-lg-7">
          <section className="card" aria-labelledby="optionsHeading">
            <div className="card-header">
              <div>
                <h2 id="optionsHeading">Menu options</h2>
                <p className="card-header__hint">What the caller can press</p>
              </div>
            </div>
            <div className="card-body tw-p-0">
              <ul className="option-list">
                {options.length === 0 ? (
                  <li>
                    <div className="empty-state tw-py-8">
                      <span className="empty-state__icon" aria-hidden="true">
                        <i className="bi bi-list-ol" />
                      </span>
                      <p className="empty-state__title">This IVR has no menu yet</p>
                      <p className="empty-state__body">
                        Callers would hear the welcome prompt and nothing more. Add options and they
                        will appear here.
                      </p>
                      <Link className="btn btn-primary btn-sm" to={`/edit-ivr?id=${encodeURIComponent(ivr?.id ?? '')}`}>
                        <i className="bi bi-pencil" aria-hidden="true" /> Build the menu
                      </Link>
                    </div>
                  </li>
                ) : (
                  options.map((option) => (
                    <li key={option.id}>
                      <button
                        className={`option-item${selectedDigit === option.digit ? ' is-selected' : ''}`}
                        type="button"
                        onClick={() => pressDigit(option.digit)}
                      >
                        <span className="option-item__digit" aria-hidden="true">
                          {option.digit}
                        </span>
                        <span>
                          <span className="option-item__label">{option.label}</span>
                          <span className="option-item__dest">
                            Extension <span className="num">{option.destination}</span>
                          </span>
                        </span>
                        <i className="bi bi-chevron-right option-item__go" aria-hidden="true" />
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>

          <section className="card tw-mt-3" aria-labelledby="dialplanHeading">
            <div className="card-header">
              <div>
                <h2 id="dialplanHeading">Dialplan</h2>
                <p className="card-header__hint">The IVR at the root, one branch per option</p>
              </div>
            </div>
            <div className="card-body dialplan">
              {options.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state__icon" aria-hidden="true">
                    <i className="bi bi-diagram-2" />
                  </span>
                  <p className="empty-state__title">Nothing to draw yet</p>
                  <p className="empty-state__body">
                    The dialplan appears once this IVR has at least one option.
                  </p>
                </div>
              ) : (
                <div className="dialplan__canvas">
                  <div className="dialplan__root">
                    <div className="dp-node dp-node--root">
                      <p className="dp-node__name">{ivr?.name}</p>
                      <span className="dp-node__ext">{ivr?.extension}</span>
                    </div>
                  </div>
                  <div className="dialplan__branches">
                    {options.map((option) => (
                      <div className="dialplan__branch" key={option.id}>
                        <div className={`dp-node${selectedDigit === option.digit ? ' is-selected' : ''}`}>
                          <span className="dp-node__digit" aria-hidden="true">
                            {option.digit}
                          </span>
                          <p className="dp-node__name">{option.label}</p>
                          <span className="dp-node__ext">{option.destination}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="card tw-mt-3" aria-labelledby="logHeading">
            <div className="card-header">
              <div>
                <h2 id="logHeading">Call log</h2>
                <p className="card-header__hint">Everything that happened, in order</p>
              </div>
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setEntries([])}>
                Clear
              </button>
            </div>
            <div className="card-body tw-p-0">
              <ul className="sim-log">
                {entries.length === 0 ? (
                  <li className="sim-log__entry">
                    <span className="sim-log__time">--:--:--</span>
                    <p className="sim-log__text">No call yet.</p>
                  </li>
                ) : (
                  entries.map((entry) => (
                    <li className={`sim-log__entry sim-log__entry--${entry.kind}`} key={entry.id}>
                      <span className="sim-log__time">{entry.time}</span>
                      <p className="sim-log__text">{entry.text}</p>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
