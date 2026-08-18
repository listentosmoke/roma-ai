// Virtual-room audio engine — a REAL WebAudio signal chain whose output is a
// REAL MediaStreamTrack (MediaStreamAudioDestinationNode). Roma's unchanged
// microphone capture (src/audio.js) consumes this track exactly as it would a
// physical microphone: ScriptProcessor → 16 kHz resample → PCM16 → Deepgram
// proxy. Nothing here fabricates transcripts, detections, or events — only
// samples.
//
// Graph:
//   per-person: source → gain(distance,line) → lowpass(distance,walls) → pan(x)
//        └──────────────► dry ─┐
//                              ├─► speechBus ─► micGain ─► destination(track)
//   room reverb: speechBus → convolver(seeded IR) → wet ┘
//   noise loop:  seeded buffer → noiseGain ──────────────► micGain
//   Roma echo:   playback <audio> → MediaElementSource → echoGain → delay
//                → echoLowpass ─────────────────────────► micGain
//                (and → context.destination so normal playback is preserved)
//
// Dev-only module: only ever imported by src/simulation/index.js, which is
// itself gated on import.meta.env.DEV + an injected activation flag.

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoiseBuffer(context, { seconds = 4, gain = 1, lowpass = 0.2, seed = 1 }) {
  const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate);
  const data = buffer.getChannelData(0);
  const random = seededRandom(seed);
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = random() * 2 - 1;
    last += lowpass * (white - last);
    data[i] = last * gain;
  }
  return buffer;
}

function makeImpulseBuffer(context, { seconds = 0.4, decay = 5, seed = 3 }) {
  const length = Math.max(64, Math.round(seconds * context.sampleRate));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const random = seededRandom(seed + channel);
    for (let i = 0; i < length; i += 1) data[i] = (random() * 2 - 1) * Math.exp(-decay * (i / length)) * 0.6;
  }
  return buffer;
}

export function createAudioEngine({ sampleRate = 48000, seed = 1 } = {}) {
  const context = new AudioContext({ sampleRate });
  const destination = context.createMediaStreamDestination();

  const micGain = context.createGain();
  micGain.gain.value = 1;
  micGain.connect(destination);

  const speechBus = context.createGain();
  speechBus.connect(micGain);

  // Reverb (wet path) — rebuilt when the room profile changes.
  let convolver = null;
  let wetGain = null;

  // Background noise loop.
  let noiseSource = null;
  let noiseGainNode = null;

  // Roma-playback echo path.
  const echo = { enabled: false, gain: 0.3, delayMs: 120, lowpassHz: 4000 };
  let echoInput = null; // MediaElementSource for the CURRENT playback element
  const echoGainNode = context.createGain();
  const echoDelayNode = context.createDelay(2);
  const echoFilterNode = context.createBiquadFilter();
  echoFilterNode.type = 'lowpass';
  echoGainNode.gain.value = 0;
  echoGainNode.connect(echoDelayNode);
  echoDelayNode.connect(echoFilterNode);
  echoFilterNode.connect(micGain);

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  micGain.connect(analyser);
  const levelData = new Float32Array(analyser.fftSize);

  const people = new Map(); // simulationId -> { pan, distance, chain nodes }
  const activeSources = new Map(); // playbackId -> { source, person }
  let playbackCounter = 0;
  let acoustics = { speechLowpassHz: 8000, reverbMix: 0.1 };

  function applyRoomProfile(config) {
    acoustics = { ...config };
    if (convolver) { try { convolver.disconnect(); wetGain.disconnect(); } catch { /* rebuilt */ } convolver = null; }
    if ((config.reverbSeconds ?? 0) > 0.01) {
      convolver = context.createConvolver();
      convolver.buffer = makeImpulseBuffer(context, { seconds: config.reverbSeconds, decay: config.reverbDecay ?? 5, seed: seed + 3 });
      wetGain = context.createGain();
      wetGain.gain.value = config.reverbMix ?? 0.1;
      speechBus.connect(convolver);
      convolver.connect(wetGain);
      wetGain.connect(micGain);
    }
    if (noiseSource) { try { noiseSource.stop(); } catch { /* stopped */ } noiseSource = null; }
    if ((config.noiseGain ?? 0) > 0) {
      noiseSource = context.createBufferSource();
      noiseSource.buffer = makeNoiseBuffer(context, { gain: 1, lowpass: config.noiseLowpass ?? 0.2, seed: seed + 11 });
      noiseSource.loop = true;
      noiseGainNode = context.createGain();
      noiseGainNode.gain.value = config.noiseGain;
      noiseSource.connect(noiseGainNode);
      noiseGainNode.connect(micGain);
      noiseSource.start();
    }
  }

  function personChain(simulationId) {
    let entry = people.get(simulationId);
    if (entry) return entry;
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = acoustics.speechLowpassHz ?? 8000;
    const panner = context.createStereoPanner();
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(speechBus);
    entry = { gain, filter, panner, distance: 1, x: 0, speaking: 0 };
    people.set(simulationId, entry);
    positionPerson(simulationId, { distance: 1, x: 0 });
    return entry;
  }

  /** Distance/direction change the SIGNAL: 1/d amplitude and progressive high-frequency loss. */
  function positionPerson(simulationId, { distance, x }) {
    const entry = personChain(simulationId);
    if (typeof distance === 'number' && distance > 0) {
      entry.distance = distance;
      entry.gain.gain.value = Math.min(1.5, 1 / Math.max(0.3, distance));
      const base = acoustics.speechLowpassHz ?? 8000;
      entry.filter.frequency.value = Math.max(800, base / (1 + (distance - 0.5) * 0.6));
    }
    if (typeof x === 'number') {
      entry.x = x;
      entry.panner.pan.value = Math.max(-1, Math.min(1, x / 4));
    }
  }

  /** Play decoded speech through a person's chain. Returns a handle; resolves when finished or stopped. */
  async function speak(simulationId, wavArrayBuffer, { gainDb = 0, rate = 1 } = {}) {
    const entry = personChain(simulationId);
    const audioBuffer = await context.decodeAudioData(wavArrayBuffer.slice(0));
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = rate;
    const lineGain = context.createGain();
    lineGain.gain.value = 10 ** (gainDb / 20);
    source.connect(lineGain);
    lineGain.connect(entry.gain);
    playbackCounter += 1;
    const playbackId = `speak_${playbackCounter}`;
    entry.speaking += 1;
    activeSources.set(playbackId, { source, simulationId });
    const done = new Promise((resolve) => {
      source.onended = () => {
        entry.speaking = Math.max(0, entry.speaking - 1);
        activeSources.delete(playbackId);
        resolve();
      };
    });
    source.start();
    return { playbackId, durationMs: (audioBuffer.duration / rate) * 1000, done };
  }

  function stopSpeaking(simulationId = null) {
    for (const [playbackId, active] of activeSources) {
      if (simulationId && active.simulationId !== simulationId) continue;
      try { active.source.stop(); } catch { /* already stopped */ }
      activeSources.delete(playbackId);
    }
  }

  /**
   * Attach Roma's REAL playback element so its decoded output can feed the
   * echo path. The element keeps playing normally (also routed to
   * context.destination). Never creates/initiates/authorizes playback.
   */
  function attachPlaybackElement(element) {
    try {
      echoInput = context.createMediaElementSource(element);
      echoInput.connect(context.destination); // preserve audible playback
      echoInput.connect(echoGainNode);        // feed the echo path (gated by echo.enabled via gain)
    } catch { /* an element can only be captured once; later duplicates are ignored */ }
  }

  function configureEcho({ enabled, gain, delayMs, lowpassHz } = {}) {
    if (typeof enabled === 'boolean') echo.enabled = enabled;
    if (typeof gain === 'number') echo.gain = gain;
    if (typeof delayMs === 'number') echo.delayMs = delayMs;
    if (typeof lowpassHz === 'number') echo.lowpassHz = lowpassHz;
    echoGainNode.gain.value = echo.enabled ? echo.gain : 0;
    echoDelayNode.delayTime.value = Math.min(2, echo.delayMs / 1000);
    echoFilterNode.frequency.value = echo.lowpassHz;
  }

  function setMicGain(gain) { micGain.gain.value = gain; }

  /** Real signal dropout: mute the mic bus for durationMs. */
  function dropout(durationMs = 500) {
    const previous = micGain.gain.value;
    micGain.gain.value = 0;
    setTimeout(() => { micGain.gain.value = previous; }, durationMs);
  }

  function endTrack() { destination.stream.getAudioTracks().forEach((track) => track.stop()); }

  function level() {
    analyser.getFloatTimeDomainData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i += 1) sum += levelData[i] * levelData[i];
    return Math.sqrt(sum / levelData.length);
  }

  return {
    context,
    /** The virtual microphone track — handed out (cloned) by devices.js. */
    stream: destination.stream,
    applyRoomProfile,
    positionPerson,
    speak,
    stopSpeaking,
    attachPlaybackElement,
    configureEcho,
    echoState: () => ({ ...echo }),
    setMicGain,
    dropout,
    endTrack,
    level,
    speakingCount: () => [...people.values()].reduce((n, p) => n + p.speaking, 0),
    resume: () => context.resume(),
  };
}
