// Microphone capture for the streaming API engine. Taps the mic, resamples to
// 16 kHz mono, and pushes PCM frames to a callback for the WebSocket. Also
// reports a smoothed level for the meter.

export const TARGET_SAMPLE_RATE = 16000;

// Linear resample to 16 kHz mono. Pure and unit-tested.
export function downsample(input, inputRate, targetRate = TARGET_SAMPLE_RATE) {
  if (inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(input.length - 1, low + 1);
    const fraction = sourceIndex - low;
    output[index] = input[low] * (1 - fraction) + input[high] * fraction;
  }
  return output;
}

// Convert float [-1,1] samples to little-endian PCM16 (what Deepgram's
// encoding=linear16 expects).
export function toPcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

function rms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function createMicCapture() {
  let context = null;
  let stream = null;
  let source = null;
  let processor = null;
  let lastLevelAt = 0;

  // onFrame(pcm16 ArrayBuffer at 16 kHz); onLevel(0..1) throttled.
  async function start(onFrame, onLevel) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextClass();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = downsample(Float32Array.from(input), context.sampleRate);
      onFrame?.(toPcm16(resampled));
      if (onLevel) {
        const now = performance.now();
        if (now - lastLevelAt >= 90) {
          lastLevelAt = now;
          onLevel(Math.min(1, rms(input) * 6));
        }
      }
    };

    source.connect(processor);
    processor.connect(context.destination); // required for the callback to fire; output stays silent
  }

  function stop() {
    try { processor?.disconnect(); } catch { /* noop */ }
    try { source?.disconnect(); } catch { /* noop */ }
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== 'closed') context.close();
    context = null;
    stream = null;
    source = null;
    processor = null;
  }

  return { start, stop };
}
