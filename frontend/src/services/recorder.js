/**
 * Recording both sides of a browser call.
 *
 * WHY THIS IS IN THE BROWSER AND NOT ON THE PBX
 *
 * Asterisk is the obvious place to record a call, and it is not available to us.
 * The AMI account is refused MixMonitor, Monitor and every other recording
 * action; and even with those granted, Asterisk writes to
 * /var/spool/asterisk/monitor on the Ubuntu machine while this app runs on
 * Windows, with no SSH, SMB or NFS between them. A recording made there would be
 * stranded there.
 *
 * The page, meanwhile, already holds both legs of the call: the microphone track
 * it is sending and the track it is receiving. Web Audio can mix those into one
 * stream and MediaRecorder can encode it. So the recording is made here and
 * uploaded to the API, which stores it beside the audio prompts.
 *
 * A module, not a component, for the same reason as the phone itself: it has to
 * survive navigation. Recording must not stop because somebody opened the IVR
 * list mid-call.
 *
 * WHAT THIS CANNOT DO
 *
 * It only sees calls made through this browser — MicroSIP-to-MicroSIP calls are
 * invisible to it. And if the tab is closed or crashes mid-call, that recording
 * is lost: the audio only exists in memory until the call ends.
 */

import * as phone from './phone-service.js';

/** Formats a browser might give us, best first. */
const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

let recorder = null;
let chunks = [];
let context = null;
let started = null;
let call = null;

let state = { recording: false, uploading: false, lastError: '' };
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
      console.error('[recorder] listener failed', error);
    }
  });
}

export function current() {
  return state;
}

function supportedType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? null;
}

/**
 * Start recording the live call.
 *
 * Both directions are mixed into one track through a Web Audio graph. Recording
 * the microphone alone would capture half a conversation, and MediaRecorder
 * cannot take two streams at once — so the two sources are connected to a single
 * destination and that is what gets encoded.
 */
function start() {
  const local = phone.localStream();
  const remote = phone.remoteStream();
  const type = supportedType();

  if (!type || !local || !remote) {
    // Not fatal: the call is more important than the recording of it.
    emit({ recording: false, lastError: type ? 'Call audio was not available to record.' : 'This browser cannot record audio.' });
    return;
  }

  try {
    context = new (window.AudioContext ?? window.webkitAudioContext)();
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(local).connect(destination);
    context.createMediaStreamSource(remote).connect(destination);

    chunks = [];
    recorder = new MediaRecorder(destination.stream, { mimeType: type });
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    // A timeslice, so a long call is not held as one growing blob and a crash
    // costs at most the last few seconds rather than everything.
    recorder.start(5000);

    started = new Date();
    const snapshot = phone.current();
    call = {
      from: snapshot.extension || 'unknown',
      to: snapshot.remote || 'unknown',
      direction: snapshot.callDirection ?? 'outbound',
    };
    emit({ recording: true, lastError: '' });
  } catch (error) {
    console.error('[recorder] could not start', error);
    emit({ recording: false, lastError: 'Recording could not be started.' });
  }
}

/** Stop, then upload whatever was captured. */
function stop() {
  if (!recorder) return;

  const active = recorder;
  const meta = { ...call, started, type: active.mimeType };
  recorder = null;
  call = null;

  active.onstop = async () => {
    const blob = new Blob(chunks, { type: meta.type });
    chunks = [];
    context?.close().catch(() => {});
    context = null;

    // A call that never really connected leaves a blob of nothing. Storing it
    // would fill Call History with unplayable rows.
    if (blob.size < 1024) {
      emit({ recording: false });
      return;
    }

    emit({ recording: false, uploading: true });
    try {
      await upload(blob, meta);
      emit({ uploading: false, lastError: '' });
    } catch (error) {
      console.error('[recorder] upload failed', error);
      emit({ uploading: false, lastError: 'The recording could not be saved.' });
    }
  };

  try {
    active.stop();
  } catch (error) {
    console.warn('[recorder] stop failed', error);
    emit({ recording: false });
  }
}

async function upload(blob, meta) {
  const seconds = Math.max(0, Math.round((Date.now() - meta.started.getTime()) / 1000));
  const response = await fetch('/api/recordings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Recording-Mime': meta.type,
      // Percent-encoded: HTTP headers are latin-1, and an extension is not
      // guaranteed to be digits.
      'X-Recording-From': encodeURIComponent(meta.from),
      'X-Recording-To': encodeURIComponent(meta.to),
      'X-Recording-Direction': meta.direction,
      'X-Recording-Duration': String(seconds),
      'X-Recording-Started': meta.started.toISOString().slice(0, 19),
    },
    body: blob,
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json();
}

/**
 * Follow the call.
 *
 * Recording begins when a call becomes active — not when it starts ringing,
 * because there is no remote audio to mix until the far end answers — and ends
 * the moment it does.
 */
let attached = false;

export function attach() {
  if (attached) return;
  attached = true;

  let previous = phone.current().call ?? 'idle';
  phone.subscribe((next) => {
    const now = next.call ?? 'idle';
    if (now === previous) return;

    if (now === 'active' && !recorder) start();
    else if (previous === 'active' && now !== 'active') stop();

    previous = now;
  });
}