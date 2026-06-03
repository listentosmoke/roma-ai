import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, BarChart3, Brain, Download, FileText, Mic, MicOff, PauseCircle, Radio, Server, Sparkles, Timer, Upload, Users } from 'lucide-react';
import { BENCHMARK_PRESETS, benchmarkTranscript, formatPercent, summarizeBenchmarkCases } from './benchmark.js';
import './styles.css';

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const RMS_SMOOTHING = 0.82;
const PAUSE_MS = 700;
const SPEAKER_SWITCH_PAUSE_MS = 1250;
const SPEAKER_ENERGY_DELTA = 0.16;
const MAX_SPEAKERS = 6;

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function confidenceLabel(value) {
  if (!Number.isFinite(value)) return 'live';
  if (value >= 0.86) return 'high';
  if (value >= 0.68) return 'good';
  return 'draft';
}

function downloadTranscript(segments) {
  const body = segments
    .map((segment) => `[${formatTime(segment.startedAt)}–${formatTime(segment.endedAt || segment.startedAt)}] ${segment.speaker}: ${segment.text}`)
    .join('\n');
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `roma-ai-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function useVoiceEngine({ language, continuous, interimResults, maxAlternatives }) {
  const recognitionRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const baseTimeRef = useRef(0);
  const energyRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const lastSegmentAtRef = useRef(0);
  const speakerProfilesRef = useRef([{ id: 'Speaker 1', meanEnergy: 0.1, samples: 1 }]);
  const currentSpeakerRef = useRef('Speaker 1');
  const restartRequestedRef = useRef(false);

  const [isListening, setIsListening] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pauseMs, setPauseMs] = useState(0);
  const [interimText, setInterimText] = useState('');
  const [segments, setSegments] = useState([]);
  const [speakers, setSpeakers] = useState(['Speaker 1']);

  const chooseSpeaker = useCallback((energy, now) => {
    const profiles = speakerProfilesRef.current;
    const silentGap = now - lastSegmentAtRef.current;
    let best = profiles[0];
    let bestDistance = Math.abs(energy - best.meanEnergy);

    for (const profile of profiles) {
      const distance = Math.abs(energy - profile.meanEnergy);
      if (distance < bestDistance) {
        best = profile;
        bestDistance = distance;
      }
    }

    const shouldCreateSpeaker =
      silentGap > SPEAKER_SWITCH_PAUSE_MS &&
      bestDistance > SPEAKER_ENERGY_DELTA &&
      profiles.length < MAX_SPEAKERS;

    if (shouldCreateSpeaker) {
      const next = { id: `Speaker ${profiles.length + 1}`, meanEnergy: energy, samples: 1 };
      profiles.push(next);
      speakerProfilesRef.current = profiles;
      setSpeakers(profiles.map((profile) => profile.id));
      currentSpeakerRef.current = next.id;
      return next.id;
    }

    best.meanEnergy = (best.meanEnergy * best.samples + energy) / (best.samples + 1);
    best.samples += 1;
    currentSpeakerRef.current = best.id;
    return best.id;
  }, []);

  const addFinalText = useCallback((text, confidence) => {
    const cleanText = text.trim();
    if (!cleanText) return;

    const now = performance.now();
    const timelineMs = now - baseTimeRef.current;
    const energy = energyRef.current;
    const speaker = chooseSpeaker(energy, now);
    lastSegmentAtRef.current = now;

    setSegments((existing) => {
      const previous = existing.at(-1);
      const canMerge = previous && previous.speaker === speaker && timelineMs - previous.endedAt < PAUSE_MS;

      if (canMerge) {
        return existing.map((segment, index) =>
          index === existing.length - 1
            ? {
                ...segment,
                text: `${segment.text} ${cleanText}`.trim(),
                endedAt: timelineMs,
                confidence: Math.max(segment.confidence ?? 0, confidence ?? 0),
              }
            : segment,
        );
      }

      return [
        ...existing,
        {
          id: crypto.randomUUID(),
          speaker,
          text: cleanText,
          confidence,
          startedAt: Math.max(0, timelineMs - 900),
          endedAt: timelineMs,
        },
      ];
    });
  }, [chooseSpeaker]);

  const stopAudio = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
  }, []);

  const monitorAudio = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / samples.length);
      const smoothed = energyRef.current * RMS_SMOOTHING + rms * (1 - RMS_SMOOTHING);
      energyRef.current = smoothed;
      setLevel(Math.min(1, smoothed * 5));

      const now = performance.now();
      setElapsedMs(now - baseTimeRef.current);
      if (smoothed > 0.035) lastVoiceAtRef.current = now;
      setPauseMs(Math.max(0, now - lastVoiceAtRef.current));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const start = useCallback(async () => {
    if (!SpeechRecognition) {
      setError('This browser does not expose the Web Speech API. Use Chrome or Edge for native real-time STT, or wire this UI to a streaming STT service.');
      return;
    }

    setIsStarting(true);
    setError('');
    setInterimText('');
    setSegments([]);
    setSpeakers(['Speaker 1']);
    speakerProfilesRef.current = [{ id: 'Speaker 1', meanEnergy: 0.1, samples: 1 }];
    currentSpeakerRef.current = 'Speaker 1';

    try {
      baseTimeRef.current = performance.now();
      lastVoiceAtRef.current = baseTimeRef.current;
      lastSegmentAtRef.current = baseTimeRef.current;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext({ latencyHint: 'interactive' });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const recognition = new SpeechRecognition();
      recognition.lang = language;
      recognition.continuous = continuous;
      recognition.interimResults = interimResults;
      recognition.maxAlternatives = maxAlternatives;

      recognition.onstart = () => {
        restartRequestedRef.current = true;
        setIsListening(true);
        setIsStarting(false);
        monitorAudio();
      };

      recognition.onresult = (event) => {
        let interim = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0]?.transcript ?? '';
          if (result.isFinal) {
            addFinalText(transcript, result[0]?.confidence);
          } else {
            interim += transcript;
          }
        }
        setInterimText(interim.trim());
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech') return;
        setError(`Speech recognition error: ${event.error}`);
      };

      recognition.onend = () => {
        if (restartRequestedRef.current && continuous) {
          try {
            recognition.start();
            return;
          } catch {
            // Recognition may already be starting; allow the visible state to settle.
          }
        }
        setIsListening(false);
        setIsStarting(false);
        stopAudio();
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (caughtError) {
      setIsStarting(false);
      setIsListening(false);
      stopAudio();
      setError(caughtError?.message || 'Unable to start microphone capture.');
    }
  }, [addFinalText, continuous, interimResults, language, maxAlternatives, monitorAudio, stopAudio]);

  const stop = useCallback(() => {
    restartRequestedRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    setIsStarting(false);
    setInterimText('');
    baseTimeRef.current = 0;
    stopAudio();
  }, [stopAudio]);

  useEffect(() => () => stop(), [stop]);

  return {
    isListening,
    isStarting,
    error,
    level,
    elapsedMs,
    pauseMs,
    interimText,
    segments,
    speakers,
    start,
    stop,
    supported: Boolean(SpeechRecognition),
  };
}

function StatCard({ icon: Icon, label, value, detail }) {
  return (
    <div className="stat-card">
      <div className="stat-icon"><Icon size={20} /></div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}


function BenchmarkLab({ segments }) {
  const presetSummary = useMemo(() => summarizeBenchmarkCases(), []);
  const liveTranscript = useMemo(() => segments.map((segment) => segment.text).join(' '), [segments]);
  const [reference, setReference] = useState(BENCHMARK_PRESETS[0].reference);
  const [hypothesis, setHypothesis] = useState(BENCHMARK_PRESETS[0].hypothesis);
  const [durationSeconds, setDurationSeconds] = useState(BENCHMARK_PRESETS[0].durationSeconds);
  const [processingSeconds, setProcessingSeconds] = useState(BENCHMARK_PRESETS[0].durationSeconds);
  const [referenceSegments, setReferenceSegments] = useState(BENCHMARK_PRESETS[0].referenceSegments);
  const [hypothesisSegments, setHypothesisSegments] = useState(BENCHMARK_PRESETS[0].hypothesisSegments);
  const [backendUrl, setBackendUrl] = useState('http://127.0.0.1:8787');
  const [audioFile, setAudioFile] = useState(null);
  const [backendStatus, setBackendStatus] = useState('');
  const [isBackendBusy, setIsBackendBusy] = useState(false);

  const metrics = useMemo(
    () => benchmarkTranscript({ reference, hypothesis, audioDurationSeconds: durationSeconds, processingSeconds, referenceSegments, hypothesisSegments }),
    [durationSeconds, hypothesis, hypothesisSegments, processingSeconds, reference, referenceSegments],
  );

  const loadPreset = (preset) => {
    setReference(preset.reference);
    setHypothesis(preset.hypothesis);
    setDurationSeconds(preset.durationSeconds);
    setProcessingSeconds(preset.processingSeconds ?? preset.durationSeconds);
    setReferenceSegments(preset.referenceSegments ?? []);
    setHypothesisSegments(preset.hypothesisSegments ?? []);
    setBackendStatus('');
  };

  const useLiveTranscript = () => {
    setHypothesis(liveTranscript);
    setHypothesisSegments(segments);
    setProcessingSeconds(Math.max(0.1, durationSeconds));
  };

  const sendAudioToBackend = async () => {
    if (!audioFile) return;
    setIsBackendBusy(true);
    setBackendStatus('Sending audio to backend model…');

    try {
      const startedAt = performance.now();
      const response = await fetch(`${backendUrl.replace(/\/$/, '')}/api/transcribe-diarize`, {
        method: 'POST',
        headers: { 'Content-Type': audioFile.type || 'application/octet-stream' },
        body: audioFile,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Backend diarization failed.');
      }

      setHypothesis(payload.text || payload.segments?.map((segment) => segment.text).join(' ') || '');
      setHypothesisSegments(payload.segments ?? []);
      setProcessingSeconds(payload.processingSeconds ?? (performance.now() - startedAt) / 1000);
      setBackendStatus(`Backend returned ${payload.segments?.length ?? 0} diarized segments via ${payload.provider ?? 'configured model'}.`);
    } catch (error) {
      setBackendStatus(error.message);
    } finally {
      setIsBackendBusy(false);
    }
  };

  return (
    <section className="benchmark-panel" aria-labelledby="benchmark-heading">
      <div className="panel-heading benchmark-heading-row">
        <div><BarChart3 size={20} /> <span id="benchmark-heading">STT benchmark lab</span></div>
        <span>WER / CER / RTF scoring</span>
      </div>

      <div className="benchmark-intro">
        <FileText size={28} />
        <p>
          Evaluate the browser transcript the same way speech-recognition systems are commonly reported: compare a ground-truth reference to a hypothesis and track word error rate, character error rate, edit counts, and real-time factor.
        </p>
      </div>

      <div className="preset-row">
        {BENCHMARK_PRESETS.map((preset) => (
          <button key={preset.id} className="chip" type="button" onClick={() => loadPreset(preset)}>
            {preset.name}
          </button>
        ))}
        <button className="chip" type="button" onClick={useLiveTranscript} disabled={!liveTranscript}>
          Use live transcript
        </button>
      </div>

      <div className="benchmark-grid">
        <label>
          Reference transcript
          <textarea value={reference} onChange={(event) => setReference(event.target.value)} rows="5" />
        </label>
        <label>
          Hypothesis transcript
          <textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} rows="5" />
        </label>
      </div>

      <div className="benchmark-timing">
        <label>
          Audio duration (seconds)
          <input type="number" min="0" step="0.1" value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} />
        </label>
        <label>
          Processing / wall time (seconds)
          <input type="number" min="0" step="0.1" value={processingSeconds} onChange={(event) => setProcessingSeconds(Number(event.target.value))} />
        </label>
      </div>

      <div className="backend-card">
        <div className="backend-card-copy">
          <Server size={22} />
          <div>
            <strong>True diarization backend</strong>
            <p>Upload audio to the Node backend, which can call WhisperX + pyannote (or another configured command) and return speaker-attributed segments instead of using the browser heuristic.</p>
          </div>
        </div>
        <div className="backend-controls">
          <label>
            Backend URL
            <input type="url" value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} />
          </label>
          <label>
            Audio file
            <input type="file" accept="audio/*" onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)} />
          </label>
          <button className="secondary" type="button" onClick={sendAudioToBackend} disabled={!audioFile || isBackendBusy}>
            <Upload size={18} /> {isBackendBusy ? 'Running backend…' : 'Run backend diarization'}
          </button>
        </div>
        {backendStatus && <div className="backend-status">{backendStatus}</div>}
      </div>

      <div className="benchmark-results">
        <StatCard icon={BarChart3} label="Word error rate" value={formatPercent(metrics.wer)} detail={`${metrics.wordEdits.substitutions} sub · ${metrics.wordEdits.insertions} ins · ${metrics.wordEdits.deletions} del`} />
        <StatCard icon={FileText} label="Character error rate" value={formatPercent(metrics.cer)} detail={`${metrics.characterEdits.distance} character edits`} />
        <StatCard icon={Brain} label="Word accuracy" value={formatPercent(Math.max(0, metrics.accuracy))} detail={`${metrics.referenceWordCount} reference words`} />
        <StatCard icon={Timer} label="Real-time factor" value={metrics.realTimeFactor === null ? 'n/a' : metrics.realTimeFactor.toFixed(2)} detail="lower than 1.0 is faster than audio" />
        <StatCard icon={Users} label="Diarization error" value={formatPercent(metrics.diarization.der)} detail={`${Math.round(metrics.diarization.speakerConfusionMs)}ms speaker confusion`} />
      </div>

      <div className="benchmark-baseline">
        Built-in fixture baseline: {formatPercent(presetSummary.averageWer)} average WER and {formatPercent(presetSummary.averageDer)} average DER over {presetSummary.totalReferenceWords} reference words. Use a labeled audio corpus and paste the Web Speech API output here for real quality comparisons across browsers, microphones, noise levels, and languages.
      </div>
    </section>
  );
}

function App() {
  const [language, setLanguage] = useState('en-US');
  const [continuous, setContinuous] = useState(true);
  const [interimResults, setInterimResults] = useState(true);
  const [maxAlternatives, setMaxAlternatives] = useState(1);
  const engine = useVoiceEngine({ language, continuous, interimResults, maxAlternatives });

  const words = useMemo(() => engine.segments.reduce((count, segment) => count + segment.text.split(/\s+/).filter(Boolean).length, 0), [engine.segments]);
  const pauseState = engine.pauseMs > PAUSE_MS ? 'pause detected' : 'speech active';

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={18} /> Roma AI realtime speech lab</div>
          <h1>Ultra-low-latency voice recognition with live transcription, pauses, and speaker turns.</h1>
          <p>
            Capture microphone audio, stream interim speech-to-text, split turns after pauses, and benchmark output against a backend path that can run true diarization models.
          </p>
          <div className="actions">
            <button className="primary" onClick={engine.isListening ? engine.stop : engine.start} disabled={engine.isStarting}>
              {engine.isListening ? <MicOff size={20} /> : <Mic size={20} />}
              {engine.isStarting ? 'Starting…' : engine.isListening ? 'Stop transcription' : 'Start real-time STT'}
            </button>
            <button className="secondary" onClick={() => downloadTranscript(engine.segments)} disabled={!engine.segments.length}>
              <Download size={19} /> Export transcript
            </button>
          </div>
        </div>
        <div className="signal-card">
          <div className="orb" style={{ '--level': engine.level }}>
            <Radio size={44} />
          </div>
          <p>{engine.supported ? 'Web Speech API ready' : 'STT unsupported in this browser'}</p>
          <div className="meter"><span style={{ width: `${Math.round(engine.level * 100)}%` }} /></div>
          <small>{pauseState} · {Math.round(engine.pauseMs)}ms silence</small>
        </div>
      </section>

      {engine.error && <div className="error-banner">{engine.error}</div>}

      <section className="controls-grid">
        <label>
          Language
          <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={engine.isListening}>
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="es-ES">Spanish</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="it-IT">Italian</option>
            <option value="pt-BR">Portuguese (BR)</option>
            <option value="ja-JP">Japanese</option>
          </select>
        </label>
        <label className="toggle"><input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} disabled={engine.isListening} /> Continuous restart</label>
        <label className="toggle"><input type="checkbox" checked={interimResults} onChange={(event) => setInterimResults(event.target.checked)} disabled={engine.isListening} /> Interim text</label>
        <label>
          Alternatives
          <input type="number" min="1" max="5" value={maxAlternatives} onChange={(event) => setMaxAlternatives(Number(event.target.value))} disabled={engine.isListening} />
        </label>
      </section>

      <section className="stats-grid">
        <StatCard icon={Timer} label="Session time" value={formatTime(engine.elapsedMs)} detail="from microphone start" />
        <StatCard icon={PauseCircle} label="Pause detector" value={pauseState} detail={`${Math.round(engine.pauseMs)}ms current gap`} />
        <StatCard icon={Users} label="Speakers" value={engine.speakers.length} detail={engine.speakers.join(', ')} />
        <StatCard icon={Brain} label="Words captured" value={words} detail="final transcript words" />
      </section>

      <BenchmarkLab segments={engine.segments} />

      <section className="workspace">
        <div className="transcript-panel">
          <div className="panel-heading">
            <div><Activity size={20} /> Live transcript</div>
            <span>{engine.segments.length} finalized turns</span>
          </div>
          <div className="interim-box">
            <span>Interim</span>
            <p>{engine.interimText || 'Start speaking to see low-latency draft text here…'}</p>
          </div>
          <div className="segments">
            {engine.segments.length === 0 ? (
              <div className="empty-state">No finalized speech yet. The app will create a new turn when speech finalizes or a pause is detected.</div>
            ) : (
              engine.segments.map((segment) => (
                <article key={segment.id} className="segment">
                  <header>
                    <strong>{segment.speaker}</strong>
                    <span>{formatTime(segment.startedAt)} → {formatTime(segment.endedAt)}</span>
                    <em>{confidenceLabel(segment.confidence)}</em>
                  </header>
                  <p>{segment.text}</p>
                </article>
              ))
            )}
          </div>
        </div>

        <aside className="design-notes">
          <h2>Built for speed</h2>
          <ul>
            <li>Native browser STT avoids shipping heavy models to the client.</li>
            <li>512-sample audio analysis keeps voice activity detection responsive.</li>
            <li>Pause segmentation runs in requestAnimationFrame with smoothed RMS energy.</li>
            <li>For true diarization, run the backend with WhisperX + pyannote and upload audio in the benchmark lab.</li>
          </ul>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
