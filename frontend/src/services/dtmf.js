/**
 * The DTMF tone generator, lifted verbatim from js/test-ivr.js.
 *
 * DTMF encodes each key as one low (row) tone plus one high (column) tone.
 * These are the ITU-T Q.23 frequencies, which is what makes the pad sound like a
 * telephone rather than like a synthesiser.
 *
 * Its own module because it is pure audio with no React in it, and because the
 * AudioContext must outlive any component: browsers refuse to start one without
 * a user gesture, and creating a fresh one per mount would waste that gesture.
 */

const ROW_FREQUENCIES = [697, 770, 852, 941];
const COLUMN_FREQUENCIES = [1209, 1336, 1477];

/** Grid order, with the letter groups that make a keypad read as a keypad. */
export const KEYPAD = [
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

function tonesFor(digit) {
  const index = KEYPAD.findIndex((key) => key.digit === digit);
  if (index === -1) return null;
  return [ROW_FREQUENCIES[Math.floor(index / 3)], COLUMN_FREQUENCIES[index % 3]];
}

/**
 * Created on the first key press, not on import: browsers refuse to start an
 * AudioContext without a user gesture, and one created too early sits suspended.
 */
let audioContext = null;

export function playDtmf(digit) {
  const tones = tonesFor(digit);
  if (!tones) return;

  try {
    audioContext ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
  } catch {
    return; // No Web Audio available; the simulator still works silently.
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
