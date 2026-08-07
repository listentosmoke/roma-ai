// React glue around the voice-delivery layer. Builds ONE createVoiceDelivery
// instance (shared by the reactive agent runtime AND the Opportunity Engine, so
// direct answers and proactive coaching pass the same Turn Manager / playback /
// gate-authorization path). Owns the browser TTS proxy provider, subscribes to
// delivery events, and exposes the feed methods App wires to the mic pipeline —
// plus audio-readiness, voice selection, and pending speak_when_convenient
// details for the Voice panel.
//
// SECURITY: the TTS key lives only on the server; synthesis goes through the
// /api/tts/synthesize proxy. If the server has no TTS credentials the provider
// falls back to a silent mock so the UI still functions (text stays visible).
// The voice list is never hardcoded here — it is fetched from the server's
// /api/tts/voices route (server/voiceCatalog.js), which asks the real provider.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createVoiceDelivery } from './voice/delivery.js';
import { createTtsProvider } from './voice/ttsProvider.js';
import { createAudioReadiness, AUDIO_READY_STATE } from './voice/audioReadiness.js';
import { loadSelectedVoice, saveSelectedVoice } from './voice/voicePreferences.js';
import { pendingSpeechReducer } from './voice/pendingSpeechTracker.js';

const MAX_EVENTS = 80;

export function useVoiceDelivery() {
  const [turnState, setTurnState] = useState('listening');
  const [events, setEvents] = useState([]);
  const [lastSpoken, setLastSpoken] = useState(null);
  const [voiceActivity, setVoiceActivity] = useState({ speaking: false, romaSpeaking: false });
  const [health, setHealth] = useState(null);
  const [audioState, setAudioState] = useState(AUDIO_READY_STATE.LOCKED);
  const [voiceCatalog, setVoiceCatalog] = useState(null); // { provider, model, defaultVoice, voices, fallback }
  const [selectedVoice, setSelectedVoiceState] = useState(() => loadSelectedVoice());
  const [pendingSpeech, setPendingSpeech] = useState(null);
  const [, force] = useState(0);
  const activeTtsRef = useRef(createTtsProvider({ provider: 'proxy' }));
  const selectedVoiceRef = useRef(selectedVoice);
  selectedVoiceRef.current = selectedVoice;

  const audioReadiness = useMemo(() => createAudioReadiness(), []);

  const delivery = useMemo(() => {
    // Delegating provider so a health check can swap proxy → silent mock without
    // rebuilding the delivery graph.
    const ttsProvider = { synthesize: (request) => activeTtsRef.current.synthesize(request) };
    // Voice is a GETTER so a user's mid-session selection only ever affects the
    // NEXT authorization — an in-flight synthesis already resolved its voice.
    return createVoiceDelivery({ ttsProvider, voice: () => selectedVoiceRef.current || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (health && !health?.tts?.available) {
      // No server TTS key: keep the full pipeline but produce silent audio so
      // authorization / turn-management / echo logic still runs and is visible.
      activeTtsRef.current = createTtsProvider({ provider: 'mock' });
    }
  }, [health]);

  // Fetch the server's real voice catalog once TTS looks available. Never
  // hardcoded client-side — always asked of the server, which asks the
  // provider. Reconciles any saved selection against what's actually offered.
  useEffect(() => {
    if (!health?.tts?.available) return;
    let cancelled = false;
    fetch('/api/tts/voices')
      .then((response) => response.json())
      .then((body) => {
        if (cancelled || !body?.voices) return;
        setVoiceCatalog(body);
        setSelectedVoiceState((current) => {
          if (current && body.voices.some((v) => v.id === current)) return current;
          // Saved voice is unknown (stale, provider changed, tampered) — fall
          // back to the server-configured default rather than sending garbage.
          const fallback = body.defaultVoice ?? null;
          saveSelectedVoice(fallback);
          return fallback;
        });
      })
      .catch(() => { /* voice selector just won't populate; synthesis still uses the server default */ });
    return () => { cancelled = true; };
  }, [health?.tts?.available]);

  const selectVoice = useCallback((voiceId) => {
    if (voiceCatalog && voiceId && !voiceCatalog.voices.some((v) => v.id === voiceId)) return false; // reject unknown ids client-side too
    setSelectedVoiceState(voiceId);
    saveSelectedVoice(voiceId);
    return true;
  }, [voiceCatalog]);

  useEffect(() => delivery.subscribe((event) => {
    setEvents((existing) => [...existing, event].slice(-MAX_EVENTS));
    if (event.type === 'spoken') setLastSpoken(event);
    if (event.type === 'turn-state' && event.state) setTurnState(event.state);
    if (event.type === 'stopped-all' || event.type === 'speech-discarded') setTurnState('listening');

    // Audio readiness reacts to real playback outcomes, not just the unlock gesture.
    if (event.type === 'playback-started') audioReadiness.markReady();
    if (event.type === 'playback-blocked' && event.reason === 'autoplay blocked by the browser') audioReadiness.markBlocked();

    // Pending speak_when_convenient: pure derivation (src/voice/pendingSpeechTracker.js)
    // — single-slot, since the Turn Manager holds exactly one active turn/
    // authorization at a time.
    setPendingSpeech((current) => pendingSpeechReducer(current, event, delivery.registry));

    setVoiceActivity({ speaking: delivery.voiceActivity.isSpeaking(), romaSpeaking: delivery.voiceActivity.isRomaSpeaking() });
    force((n) => n + 1);
  }), [delivery, audioReadiness]);

  useEffect(() => audioReadiness.subscribe((state) => { setAudioState(state); force((n) => n + 1); }), [audioReadiness]);

  return {
    delivery, // pass as `speech` to useAgent + useProactive
    setHealth,
    turnState,
    events,
    lastSpoken,
    voiceActivity,
    metrics: () => delivery.metrics(),
    // ── audio readiness ──
    audioState,
    unlockAudio: () => audioReadiness.unlock(),
    // ── voice selection ──
    voiceCatalog,
    selectedVoice,
    selectVoice,
    // ── pending speak_when_convenient ──
    pendingSpeech,
    someoneElseSpeaking: () => delivery.voiceActivity.isSpeaking() && !delivery.voiceActivity.isRomaSpeaking(),
    cancelPendingSpeech: () => delivery.stopAll('user cancelled pending suggestion'),
    // ── feeds from the mic pipeline (App wires these) ──
    pushLevel: (level, at) => delivery.voiceActivity.pushLevel(level, at),
    pushInterim: (text, meta) => delivery.voiceActivity.pushInterim(text, meta),
    pushSegment: (meta) => delivery.voiceActivity.pushSegment(meta),
    handleUserSpeech: (utterance) => delivery.handleUserSpeech(utterance),
    classifyTranscript: (segment) => delivery.classifyTranscript(segment),
    // ── user controls ──
    stopAll: (reason) => delivery.stopAll(reason ?? 'user pressed Stop Roma'),
    clearPending: () => delivery.clearPending('user cleared pending speech'),
    testTts: (text) => delivery.testTts(text),
  };
}
