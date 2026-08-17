/**
 * Demo audio generator — AUTHORING TIME ONLY.
 *
 * Writes the three seed prompts into ../assets/audio/ as real 16-bit PCM WAV files,
 * so the Audio Files page exercises the genuine HTML5 Audio code path (duration,
 * seeking, ended events) rather than simulating playback.
 *
 * These stand in for recorded voice prompts until a backend serves real ones.
 *
 * Run from the project root:
 *   node tools/make-demo-audio.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'audio');
const SAMPLE_RATE = 44100;
const CHANNELS = 2;

/** Cosine ramp at both ends of a note; prevents the click a hard cut produces. */
function envelope(position, total) {
  const ramp = Math.min(0.02 * SAMPLE_RATE, total / 4);
  if (position < ramp) return 0.5 - 0.5 * Math.cos((Math.PI * position) / ramp);
  if (position > total - ramp) return 0.5 - 0.5 * Math.cos((Math.PI * (total - position)) / ramp);
  return 1;
}

/**
 * Render a sequence of notes to interleaved stereo Float samples.
 * A note is { freq, start, duration, gain }, all times in seconds.
 * freq may be an array, in which case the tones are summed (as DTMF does).
 */
function render(notes, totalSeconds) {
  const frameCount = Math.round(totalSeconds * SAMPLE_RATE);
  const samples = new Float32Array(frameCount);

  for (const note of notes) {
    const startFrame = Math.round(note.start * SAMPLE_RATE);
    const noteFrames = Math.round(note.duration * SAMPLE_RATE);
    const freqs = Array.isArray(note.freq) ? note.freq : [note.freq];

    for (let i = 0; i < noteFrames && startFrame + i < frameCount; i++) {
      let value = 0;
      for (const freq of freqs) value += Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
      samples[startFrame + i] += (value / freqs.length) * note.gain * envelope(i, noteFrames);
    }
  }
  return samples;
}

/** Wrap mono float samples in a standard 44-byte RIFF/WAVE header, duplicated to stereo. */
function toWav(samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * CHANNELS * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = Math.round(clamped * 32767);
    for (let channel = 0; channel < CHANNELS; channel++) {
      buffer.writeInt16LE(pcm, offset);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

// A major pentatonic set, so any ordering of these sounds intentional.
const A4 = 440, C5 = 523.25, D5 = 587.33, E5 = 659.25, A5 = 880, A3 = 220;

const PROMPTS = {
  // Rising chime: the greeting a caller hears first.
  'welcome.wav': {
    seconds: 5,
    notes: [
      { freq: A4, start: 0.15, duration: 0.5, gain: 0.32 },
      { freq: C5, start: 0.55, duration: 0.5, gain: 0.3 },
      { freq: E5, start: 0.95, duration: 0.5, gain: 0.28 },
      { freq: A5, start: 1.35, duration: 1.1, gain: 0.26 },
      { freq: [A4, E5], start: 2.7, duration: 1.9, gain: 0.16 },
    ],
  },
  // Flat repeated low tone: the standard "that was not a valid option" texture.
  'invalid.wav': {
    seconds: 3,
    notes: [
      { freq: A3, start: 0.2, duration: 0.45, gain: 0.34 },
      { freq: A3, start: 0.85, duration: 0.45, gain: 0.34 },
      { freq: [A3, 233.08], start: 1.6, duration: 1.0, gain: 0.22 },
    ],
  },
  // Falling chime: the mirror of welcome, so hang-up feels like a close.
  'goodbye.wav': {
    seconds: 4,
    notes: [
      { freq: A5, start: 0.15, duration: 0.45, gain: 0.3 },
      { freq: E5, start: 0.5, duration: 0.45, gain: 0.29 },
      { freq: D5, start: 0.85, duration: 0.45, gain: 0.28 },
      { freq: A4, start: 1.2, duration: 1.4, gain: 0.26 },
    ],
  },
};

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, prompt] of Object.entries(PROMPTS)) {
  const wav = toWav(render(prompt.notes, prompt.seconds));
  writeFileSync(join(OUT_DIR, name), wav);
  console.log(`${name.padEnd(14)} ${prompt.seconds}s  ${wav.length} bytes`);
}
