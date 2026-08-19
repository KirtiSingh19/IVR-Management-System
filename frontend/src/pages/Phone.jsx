/**
 * Phone page. Ported from pages/phone.html + js/phone.js.
 *
 * Markup and classes are unchanged, so css/phone.css styles it exactly as
 * before. What changed is ownership: this component renders the phone, it does
 * not *hold* it. The UserAgent, the WebSocket and any live call belong to
 * services/phone-service.js, a module singleton outside the React tree.
 *
 * Nothing here unregisters. Leaving the page unmounts this component and detaches
 * one listener; the call carries on. Only the Unregister button ends a session.
 */

import { useEffect, useRef, useState } from 'react';
import { usePhone, phone } from '../hooks/usePhone.js';
import * as recorder from '../services/recorder.js';
import { formatDuration } from '../services/utils.js';
import Toast from 'react-bootstrap/Toast';
import ToastContainer from 'react-bootstrap/ToastContainer';

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** Where the server and extension are remembered. Never the password. */
const SETTINGS_KEY = 'ivrm:phone:settings';

function loadSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Private mode. Only costs convenience. */
  }
}

/**
 * Why the phone cannot work here, or null.
 *
 * Environmental, not configuration: no amount of correct SIP setup grants a
 * microphone on an insecure origin, so this is checked before anything else.
 */
function prerequisiteProblem() {
  if (!window.isSecureContext) {
    return (
      `This page is open at ${window.location.origin}, which the browser does not treat as a ` +
      'secure context, so it will not grant microphone access. Open it at ' +
      'http://127.0.0.1:5173 instead, or serve the site over HTTPS.'
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support getUserMedia, so it cannot place calls.';
  }
  if (!window.RTCPeerConnection) return 'This browser does not support WebRTC.';
  return null;
}

/** mm:ss since the call was answered, ticking once a second. */
function useCallDuration(answeredAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!answeredAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [answeredAt]);

  return answeredAt ? formatDuration((now - answeredAt) / 1000) : '';
}

export default function Phone() {
  const state = usePhone();

  // Recording is driven by the call, not by this page — the indicator only
  // reports what services/recorder.js is doing.
  const [rec, setRec] = useState(() => recorder.current());
  useEffect(() => recorder.subscribe(setRec), []);
  const blocked = useRef(prerequisiteProblem()).current;

  const saved = useRef(loadSettings()).current;
  const [server, setServer] = useState(saved.server ?? '10.140.28.15:8089');
  const [extension, setExtension] = useState(saved.extension ?? '');
  const [password, setPassword] = useState('');
  const [number, setNumber] = useState('');
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState(null);

  const registered = state.status === 'registered';
  const callState = state.call ?? 'idle';
  const duration = useCallDuration(callState === 'active' ? state.answeredAt : 0);

  // A restored session repopulates the form, so returning to this page looks the
  // way it did when it was left.
  useEffect(() => {
    if (state.extension && !extension) setExtension(state.extension);
    if (state.server && !server) setServer(state.server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.extension, state.server]);

  async function onRegister() {
    if (!server.trim() || !extension.trim() || !password) {
      setNotice({ tone: 'warn', title: 'Missing details', text: 'Server, extension and password are all required.' });
      return;
    }
    const result = await phone.register({ server: server.trim(), extension: extension.trim(), password });
    if (result.ok) {
      saveSettings({ server: server.trim(), extension: extension.trim() });
      setPassword('');
      return;
    }
    setNotice({ tone: 'danger', title: 'Could not register', text: result.message });
  }

  async function onCall() {
    if (!number.trim()) {
      setNotice({ tone: 'warn', title: 'No number', text: 'Enter an extension to call.' });
      return;
    }
    try {
      await phone.call(number.trim(), server);
    } catch (error) {
      setNotice({ tone: 'danger', title: 'Call failed', text: error.message ?? 'Asterisk rejected the call.' });
    }
  }

  function onKey(key) {
    if (callState === 'active') {
      phone.sendDTMF(key)?.catch?.(() => {});
      return;
    }
    setNumber((current) => current + key);
  }

  function onMute() {
    const next = !muted;
    setMuted(next);
    if (next) phone.mute();
    else phone.unmute();
  }

  const registrationBadge = {
    registered: ['ok', 'Registered'],
    connecting: ['warn', 'Connecting…'],
    failed: ['danger', 'Not registered'],
  }[state.status] ?? ['neutral', 'Not registered'];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Phone</h1>
          <p className="page-header__subtitle">
            Register one of your existing extensions in this browser and place real calls through
            Asterisk.
          </p>
        </div>
      </div>

      {blocked && (
        <div className="alert alert-warning" role="alert">
          <strong>This phone cannot run here.</strong> {blocked}
        </div>
      )}

      <div className="row g-3">
        <div className="col-12 col-lg-5">
          <section className="card h-100" aria-labelledby="phoneAccountHeading">
            <div className="card-header">
              <div>
                <h2 id="phoneAccountHeading">SIP account</h2>
                <p className="card-header__hint">An extension already configured on Asterisk</p>
              </div>
            </div>
            <div className="card-body">
              <div className="mb-3">
                <label className="form-label" htmlFor="phoneServer">Asterisk server</label>
                <input
                  className="form-control num"
                  type="text"
                  id="phoneServer"
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  autoComplete="off"
                  aria-describedby="phoneServer-help"
                />
                <div className="form-text" id="phoneServer-help">
                  Host and WSS port. The phone connects to <span className="num">wss://host:port/ws</span>.
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label" htmlFor="phoneExtension">Extension</label>
                <input
                  className="form-control num"
                  type="text"
                  id="phoneExtension"
                  placeholder="9001"
                  inputMode="numeric"
                  value={extension}
                  onChange={(event) => setExtension(event.target.value)}
                  autoComplete="off"
                  aria-describedby="phoneExtension-help"
                />
                <div className="form-text" id="phoneExtension-help">
                  Must be a WebRTC-enabled endpoint. 9001-9003 are; 1001-1004 are UDP only and will
                  not register from a browser.
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label" htmlFor="phonePassword">SIP password</label>
                <input
                  className="form-control"
                  type="password"
                  id="phonePassword"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  aria-describedby="phonePassword-help"
                />
                <div className="form-text" id="phonePassword-help">
                  Never stored. The server and extension are remembered; this is not.
                </div>
              </div>

              <div className="tw-flex tw-items-center tw-gap-2">
                {!registered && (
                  <button className="btn btn-primary" type="button" onClick={onRegister} disabled={Boolean(blocked)}>
                    <i className="bi bi-box-arrow-in-right" aria-hidden="true" /> Register
                  </button>
                )}
                {registered && (
                  <button className="btn btn-outline-secondary" type="button" onClick={() => phone.unregister()}>
                    <i className="bi bi-box-arrow-left" aria-hidden="true" /> Unregister
                  </button>
                )}
              </div>

              <hr className="tw-my-4" />

              <dl className="asterisk-facts">
                <div>
                  <dt>Registration</dt>
                  <dd>
                    <span className={`status status--${registrationBadge[0]}`}>
                      <span className="status__dot" aria-hidden="true" />
                      {registrationBadge[1]}
                    </span>
                  </dd>
                </div>
              </dl>
              <p className="tw-mt-2 tw-mb-0 tw-text-xs tw-text-muted">{state.detail}</p>
            </div>
          </section>
        </div>

        <div className="col-12 col-lg-7">
          <section
            className="card h-100"
            aria-labelledby="phoneDialerHeading"
            data-call-state={callState}
          >
            <div className="card-header">
              <div>
                <h2 id="phoneDialerHeading">Dialer</h2>
                <p className="card-header__hint">Call any extension on the PBX</p>
              </div>
              <span className="tw-flex tw-items-center tw-gap-3">
                {/* Visible while a call is being recorded, so nobody is recorded
                    without the operator being able to see it. */}
                {rec.recording ? (
                  <span className="phone-recording" title="This call is being recorded">
                    <span className="phone-recording__dot" aria-hidden="true" />
                    Recording
                  </span>
                ) : null}
                {rec.uploading ? (
                  <span className="tw-text-xs tw-text-muted">Saving recording…</span>
                ) : null}
                <span className="phone-duration num">{duration}</span>
              </span>
            </div>
            <div className="card-body">
              <p className="phone-state">
                {{
                  idle: 'No active call',
                  outgoing: `Calling ${state.remote}…`,
                  ringing: `Incoming call from ${state.remote}`,
                  active: `In call with ${state.remote}`,
                }[callState]}
              </p>

              {rec.lastError ? (
                <p className="tw-mb-3 tw-text-xs" style={{ color: 'var(--ivr-danger)' }}>
                  {rec.lastError}
                </p>
              ) : null}

              {callState === 'ringing' && (
                <div className="phone-incoming">
                  <i className="bi bi-telephone-inbound-fill" aria-hidden="true" /> Incoming call
                </div>
              )}

              <div className="input-group tw-mb-3">
                <input
                  className="form-control num phone-number"
                  type="text"
                  placeholder="1002"
                  inputMode="numeric"
                  aria-label="Number to call"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && registered && callState === 'idle') onCall();
                  }}
                  disabled={!registered}
                />
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  onClick={() => setNumber('')}
                  aria-label="Clear number"
                >
                  <i className="bi bi-backspace" aria-hidden="true" />
                </button>
              </div>

              <div className="keypad" role="group" aria-label="Dial pad">
                {KEYPAD.map((key) => (
                  <button className="keypad__key" type="button" key={key} onClick={() => onKey(key)}>
                    {key}
                  </button>
                ))}
              </div>

              <div className="phone-actions">
                {callState === 'idle' && (
                  <button className="btn btn-success" type="button" onClick={onCall} disabled={!registered}>
                    <i className="bi bi-telephone-fill" aria-hidden="true" /> Call
                  </button>
                )}
                {callState === 'ringing' && (
                  <>
                    <button className="btn btn-success" type="button" onClick={() => phone.answer()}>
                      <i className="bi bi-telephone-inbound-fill" aria-hidden="true" /> Answer
                    </button>
                    <button className="btn btn-outline-danger" type="button" onClick={() => phone.decline()}>
                      <i className="bi bi-telephone-x-fill" aria-hidden="true" /> Reject
                    </button>
                  </>
                )}
                {(callState === 'outgoing' || callState === 'active') && (
                  <button className="btn btn-danger" type="button" onClick={() => phone.hangup()}>
                    <i className="bi bi-telephone-x-fill" aria-hidden="true" /> Hang up
                  </button>
                )}
                {callState === 'active' && (
                  <button
                    className={`btn btn-outline-secondary${muted ? ' is-active' : ''}`}
                    type="button"
                    onClick={onMute}
                    aria-pressed={muted}
                  >
                    <i className={`bi ${muted ? 'bi-mic-mute-fill' : 'bi-mic-fill'}`} aria-hidden="true" />{' '}
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      <ToastContainer position="bottom-end" className="tw-p-3">
        <Toast show={Boolean(notice)} onClose={() => setNotice(null)} delay={9000} autohide>
          <Toast.Header>
            <strong className="me-auto">{notice?.title}</strong>
          </Toast.Header>
          <Toast.Body>{notice?.text}</Toast.Body>
        </Toast>
      </ToastContainer>
    </>
  );
}
