import './styles.css';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  listening: false,
  recognition: null,
  stream: null,
  audioContext: null,
  analyser: null,
  data: null,
  vadFrame: 0,
  lastVoiceAt: 0,
  currentSpeechStartedAt: 0,
  pauseThresholdMs: 700,
  silenceThreshold: 0.035,
  speakerSensitivity: 0.18,
  interimText: '',
  activeSpeakerId: 1,
  nextSpeakerId: 2,
  speakers: new Map([[1, { id: 1, name: 'Speaker 1', centroid: null, samples: 0 }]]),
  segments: [],
  pauseEvents: [],
  currentFeatures: [],
  startedAt: 0,
  stats: {
    words: 0,
    finalSegments: 0,
    avgLatencyMs: 0,
  },
};

const app = document.querySelector('#app');

function render() {
  app.innerHTML = `
    <section class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Roma AI realtime speech workspace</p>
          <h1>Fast realtime speech-to-text with pauses and speaker separation</h1>
          <p class="lede">
            Streams microphone audio through the browser's lowest-latency speech engine while a lightweight voice activity detector
            detects pauses and an online acoustic clusterer assigns speaker labels without sending audio through this app.
          </p>
        </div>
        <div class="status-card ${state.listening ? 'live' : ''}">
          <span class="pulse"></span>
          <strong>${state.listening ? 'Listening live' : 'Ready'}</strong>
          <small>${SpeechRecognition ? 'Speech API available' : 'Speech API unavailable'}</small>
        </div>
      </header>

      <section class="controls panel">
        <button id="toggle" class="primary">${state.listening ? 'Stop transcription' : 'Start transcription'}</button>
        <button id="clear" class="ghost">Clear transcript</button>
        <button id="download" class="ghost">Download JSON</button>
        <label>
          Language
          <select id="language">
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="es-ES">Spanish</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="it-IT">Italian</option>
          </select>
        </label>
        <label>
          Pause split: <output>${state.pauseThresholdMs}ms</output>
          <input id="pause" type="range" min="250" max="1800" step="50" value="${state.pauseThresholdMs}" />
        </label>
        <label>
          Mic sensitivity: <output>${state.silenceThreshold.toFixed(3)}</output>
          <input id="sensitivity" type="range" min="0.010" max="0.120" step="0.005" value="${state.silenceThreshold}" />
        </label>
        <label>
          Speaker separation: <output>${state.speakerSensitivity.toFixed(2)}</output>
          <input id="speakerSensitivity" type="range" min="0.08" max="0.42" step="0.01" value="${state.speakerSensitivity}" />
        </label>
      </section>

      <section class="grid">
        <article class="panel transcript-panel">
          <div class="panel-title">
            <h2>Live transcript</h2>
            <span>${state.stats.words} words · ${state.pauseEvents.length} pauses · ${state.speakers.size} speakers</span>
          </div>
          <div class="transcript" aria-live="polite">
            ${state.segments.length || state.interimText ? renderSegments() : '<p class="empty">Press Start and begin speaking. Pauses are detected automatically.</p>'}
          </div>
        </article>

        <aside class="panel sidebar">
          <h2>Realtime signal</h2>
          <div class="meter"><div id="meterFill" style="width: 0%"></div></div>
          <div class="stats">
            <div><strong>${state.stats.finalSegments}</strong><span>final chunks</span></div>
            <div><strong>${Math.round(state.stats.avgLatencyMs)}ms</strong><span>avg final latency</span></div>
            <div><strong>${state.activeSpeakerId}</strong><span>active speaker</span></div>
          </div>
          <h3>Speakers</h3>
          <div class="speaker-list">
            ${[...state.speakers.values()].map(renderSpeaker).join('')}
          </div>
          <button id="newSpeaker" class="ghost full">Force new speaker</button>
          <h3>Detected pauses</h3>
          <ol class="pauses">
            ${state.pauseEvents.slice(-8).reverse().map((pause) => `<li>${formatTime(pause.at)} · ${pause.duration}ms</li>`).join('') || '<li>No pauses yet</li>'}
          </ol>
          <p class="note">Tip: use longer pause splits in noisy rooms. Speaker labels can be renamed after capture.</p>
        </aside>
      </section>
    </section>
  `;

  document.querySelector('#toggle').addEventListener('click', toggleListening);
  document.querySelector('#clear').addEventListener('click', clearTranscript);
  document.querySelector('#download').addEventListener('click', downloadTranscript);
  document.querySelector('#pause').addEventListener('input', (event) => {
    state.pauseThresholdMs = Number(event.target.value);
    render();
  });
  document.querySelector('#sensitivity').addEventListener('input', (event) => {
    state.silenceThreshold = Number(event.target.value);
    render();
  });
  document.querySelector('#speakerSensitivity').addEventListener('input', (event) => {
    state.speakerSensitivity = Number(event.target.value);
    render();
  });
  document.querySelector('#newSpeaker').addEventListener('click', forceNewSpeaker);
  document.querySelectorAll('[data-speaker-name]').forEach((input) => {
    input.addEventListener('change', (event) => renameSpeaker(Number(event.target.dataset.speakerName), event.target.value));
  });
}

function renderSegments() {
  const final = state.segments.map((segment) => `
    <div class="segment speaker-${segment.speakerId % 6}">
      <div class="segment-meta">
        <strong>${speakerName(segment.speakerId)}</strong>
        <span>${formatTime(segment.startedAt)} → ${formatTime(segment.endedAt)}</span>
        <small>${segment.pauseBefore ? `pause ${segment.pauseBefore}ms` : 'continuous'}</small>
      </div>
      <p>${escapeHtml(segment.text)}</p>
    </div>
  `).join('');

  const interim = state.interimText ? `
    <div class="segment interim speaker-${state.activeSpeakerId % 6}">
      <div class="segment-meta"><strong>${speakerName(state.activeSpeakerId)}</strong><span>live</span><small>interim</small></div>
      <p>${escapeHtml(state.interimText)}</p>
    </div>
  ` : '';

  return final + interim;
}

function renderSpeaker(speaker) {
  return `
    <label class="speaker-row">
      <span class="dot speaker-${speaker.id % 6}"></span>
      <input data-speaker-name="${speaker.id}" value="${escapeHtml(speaker.name)}" aria-label="Speaker ${speaker.id} name" />
      <small>${speaker.samples} samples</small>
    </label>
  `;
}

async function toggleListening() {
  if (state.listening) {
    stopListening();
  } else {
    await startListening();
  }
}

async function startListening() {
  if (!SpeechRecognition) {
    alert('This browser does not expose the Web Speech API. Try Chrome or Edge for realtime STT.');
    return;
  }

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  state.audioContext = new AudioContext({ latencyHint: 'interactive' });
  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  state.analyser.smoothingTimeConstant = 0.22;
  state.data = new Uint8Array(state.analyser.frequencyBinCount);
  source.connect(state.analyser);

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = document.querySelector('#language')?.value || 'en-US';
  recognition.onresult = handleSpeechResult;
  recognition.onerror = (event) => console.warn('Speech recognition error', event.error);
  recognition.onend = () => {
    if (state.listening) recognition.start();
  };

  state.recognition = recognition;
  state.listening = true;
  state.startedAt = performance.now();
  state.lastVoiceAt = performance.now();
  recognition.start();
  monitorVoiceActivity();
  render();
}

function stopListening() {
  state.listening = false;
  cancelAnimationFrame(state.vadFrame);
  state.recognition?.stop();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.audioContext?.close();
  state.recognition = null;
  state.stream = null;
  state.audioContext = null;
  state.analyser = null;
  state.data = null;
  state.interimText = '';
  state.currentFeatures = [];
  render();
}

function monitorVoiceActivity() {
  if (!state.listening || !state.analyser || !state.data) return;

  state.analyser.getByteFrequencyData(state.data);
  const feature = extractFeature(state.data);
  updateMeter(feature.rms);

  const now = performance.now();
  if (feature.rms > state.silenceThreshold) {
    if (!state.currentSpeechStartedAt) state.currentSpeechStartedAt = now;
    state.lastVoiceAt = now;
    state.currentFeatures.push(feature);
    if (state.currentFeatures.length > 90) state.currentFeatures.shift();
  } else if (state.currentSpeechStartedAt && now - state.lastVoiceAt > state.pauseThresholdMs) {
    const duration = Math.round(now - state.lastVoiceAt);
    state.pauseEvents.push({ at: Date.now(), duration });
    state.currentSpeechStartedAt = 0;
    maybeSwitchSpeaker();
    render();
  }

  state.vadFrame = requestAnimationFrame(monitorVoiceActivity);
}

function handleSpeechResult(event) {
  let interim = '';

  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result[0].transcript.trim();
    if (!transcript) continue;

    if (result.isFinal) {
      const now = Date.now();
      const previous = state.segments.at(-1);
      const pauseBefore = previous ? Math.max(0, now - previous.endedAt) : 0;
      const segment = {
        id: crypto.randomUUID(),
        speakerId: state.activeSpeakerId,
        text: transcript,
        confidence: result[0].confidence || null,
        startedAt: previous?.endedAt || now,
        endedAt: now,
        pauseBefore: pauseBefore > state.pauseThresholdMs ? pauseBefore : 0,
      };
      state.segments.push(segment);
      updateSpeakerModel(segment.speakerId);
      state.stats.finalSegments += 1;
      state.stats.words += transcript.split(/\s+/).length;
      state.stats.avgLatencyMs = rollingAverage(state.stats.avgLatencyMs, pauseBefore, state.stats.finalSegments);
      state.interimText = '';
    } else {
      interim += `${transcript} `;
    }
  }

  state.interimText = interim.trim();
  render();
}

function extractFeature(frequencies) {
  let energy = 0;
  let weighted = 0;
  let total = 0;
  const bands = [0, 0, 0, 0];

  frequencies.forEach((value, index) => {
    const normalized = value / 255;
    energy += normalized * normalized;
    weighted += normalized * index;
    total += normalized;
    const band = Math.min(3, Math.floor(index / (frequencies.length / 4)));
    bands[band] += normalized;
  });

  const rms = Math.sqrt(energy / frequencies.length);
  const centroid = total ? weighted / total / frequencies.length : 0;
  const bandTotal = bands.reduce((sum, value) => sum + value, 0) || 1;
  return {
    rms,
    centroid,
    bands: bands.map((band) => band / bandTotal),
  };
}

function averageFeature(features) {
  if (!features.length) return null;
  return features.reduce((avg, feature, index) => ({
    rms: avg.rms + (feature.rms - avg.rms) / (index + 1),
    centroid: avg.centroid + (feature.centroid - avg.centroid) / (index + 1),
    bands: avg.bands.map((band, bandIndex) => band + (feature.bands[bandIndex] - band) / (index + 1)),
  }), { rms: 0, centroid: 0, bands: [0, 0, 0, 0] });
}

function maybeSwitchSpeaker() {
  const feature = averageFeature(state.currentFeatures);
  state.currentFeatures = [];
  if (!feature) return;

  let bestSpeaker = null;
  let bestDistance = Infinity;
  for (const speaker of state.speakers.values()) {
    if (!speaker.centroid) continue;
    const distance = featureDistance(feature, speaker.centroid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSpeaker = speaker;
    }
  }

  if (!bestSpeaker || bestDistance > state.speakerSensitivity) {
    const id = state.nextSpeakerId++;
    state.speakers.set(id, { id, name: `Speaker ${id}`, centroid: feature, samples: 1 });
    state.activeSpeakerId = id;
  } else {
    state.activeSpeakerId = bestSpeaker.id;
  }
}

function updateSpeakerModel(speakerId) {
  const speaker = state.speakers.get(speakerId);
  const feature = averageFeature(state.currentFeatures);
  if (!speaker || !feature) return;

  if (!speaker.centroid) {
    speaker.centroid = feature;
  } else {
    const weight = Math.min(0.28, 1 / (speaker.samples + 1));
    speaker.centroid = blendFeature(speaker.centroid, feature, weight);
  }
  speaker.samples += 1;
}

function blendFeature(a, b, weight) {
  return {
    rms: a.rms * (1 - weight) + b.rms * weight,
    centroid: a.centroid * (1 - weight) + b.centroid * weight,
    bands: a.bands.map((band, index) => band * (1 - weight) + b.bands[index] * weight),
  };
}

function featureDistance(a, b) {
  const bandDistance = Math.sqrt(a.bands.reduce((sum, band, index) => sum + (band - b.bands[index]) ** 2, 0));
  return Math.abs(a.centroid - b.centroid) + Math.abs(a.rms - b.rms) * 0.75 + bandDistance;
}

function updateMeter(rms) {
  const fill = document.querySelector('#meterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.round((rms / 0.18) * 100))}%`;
}

function forceNewSpeaker() {
  const id = state.nextSpeakerId++;
  state.speakers.set(id, { id, name: `Speaker ${id}`, centroid: averageFeature(state.currentFeatures), samples: 0 });
  state.activeSpeakerId = id;
  render();
}

function renameSpeaker(id, name) {
  const speaker = state.speakers.get(id);
  if (speaker) speaker.name = name.trim() || `Speaker ${id}`;
  render();
}

function clearTranscript() {
  state.segments = [];
  state.pauseEvents = [];
  state.interimText = '';
  state.stats = { words: 0, finalSegments: 0, avgLatencyMs: 0 };
  render();
}

function downloadTranscript() {
  const payload = {
    exportedAt: new Date().toISOString(),
    speakers: [...state.speakers.values()].map(({ id, name, samples }) => ({ id, name, samples })),
    pauses: state.pauseEvents,
    segments: state.segments,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `roma-ai-transcript-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function speakerName(id) {
  return state.speakers.get(id)?.name || `Speaker ${id}`;
}

function rollingAverage(current, next, count) {
  return current + (next - current) / count;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

render();
