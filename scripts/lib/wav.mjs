// PCM/WAV utilities for the virtual-hardware lab. Pure Node, no ffmpeg.
// Everything here produces or transforms ACTUAL sample data — environmental
// conditions in the lab are signal transformations, never labels.

/** Encode mono Float32 [-1,1] samples as a 16-bit PCM WAV file buffer. */
export function encodeWav(samples, sampleRate = 48000) {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

/** Decode s16le mono PCM bytes to Float32 samples. */
export function pcm16ToFloat32(pcmBuffer) {
  const samples = new Float32Array(Math.floor(pcmBuffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = pcmBuffer.readInt16LE(i * 2) / 0x8000;
  return samples;
}

export function float32ToPcm16(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), i * 2);
  }
  return buffer;
}

/** Mulberry32 — deterministic seeded PRNG so every generated fixture is reproducible. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Deterministic seeded white/pink-ish noise. */
export function generateNoise({ seconds = 1, sampleRate = 48000, gain = 0.05, seed = 1, lowpass = 0.2 }) {
  const random = seededRandom(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let last = 0;
  for (let i = 0; i < out.length; i += 1) {
    const white = random() * 2 - 1;
    last += lowpass * (white - last); // one-pole lowpass — rumbling HVAC-ish spectrum
    out[i] = last * gain;
  }
  return out;
}

/**
 * Deterministic vowel-like signal ("synthetic talker"). NOT intelligible
 * speech — used for signal-level tests (levels, mixing, VAD, diarization
 * energy) where transcribable words are not required. Real transcribable
 * speech comes from Aura TTS or the recorded fixtures (scripts/lib/voices.mjs).
 */
export function generateSyntheticVoice({ seconds = 2, sampleRate = 48000, pitchHz = 120, gain = 0.3, seed = 7, syllableHz = 3 }) {
  const random = seededRandom(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const formants = [pitchHz * 5 + random() * 200, pitchHz * 9 + random() * 300];
  for (let i = 0; i < out.length; i += 1) {
    const t = i / sampleRate;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * syllableHz * t + random() * 0.01);
    const glottal = Math.sin(2 * Math.PI * pitchHz * t) + 0.5 * Math.sin(2 * Math.PI * pitchHz * 2 * t);
    const f1 = 0.3 * Math.sin(2 * Math.PI * formants[0] * t);
    const f2 = 0.15 * Math.sin(2 * Math.PI * formants[1] * t);
    out[i] = gain * syllable * (glottal * 0.5 + f1 + f2) * 0.5;
  }
  return out;
}

/** Simple exponential-decay impulse response for the browser ConvolverNode (reverb). */
export function generateImpulseResponse({ seconds = 0.6, sampleRate = 48000, decay = 4, seed = 3, gain = 0.5 }) {
  const random = seededRandom(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (random() * 2 - 1) * Math.exp(-decay * (i / out.length)) * gain;
  }
  return out;
}

/** Linear resample (same algorithm shape as src/audio.js downsample, any direction). */
export function resample(input, inputRate, targetRate) {
  if (inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const src = i * ratio;
    const low = Math.floor(src);
    const high = Math.min(input.length - 1, low + 1);
    const fraction = src - low;
    output[i] = input[low] * (1 - fraction) + input[high] * fraction;
  }
  return output;
}

/** Mix b into a at offsetSamples with gain (in place on a copy). */
export function mixInto(a, b, offsetSamples = 0, gain = 1) {
  const out = Float32Array.from(a);
  for (let i = 0; i < b.length && offsetSamples + i < out.length; i += 1) {
    out[offsetSamples + i] += b[i] * gain;
  }
  return out;
}
