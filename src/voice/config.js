// ─────────────────────────────────────────────────────────────────────────────
// Voice-delivery configuration (browser side).
//
// SECURITY: the browser never holds the TTS or Deepgram keys. TTS synthesis goes
// through the local server route /api/tts/synthesize (server/groqApi.js), which
// reads TTS_PROVIDER / TTS_API_KEY / TTS_MODEL / TTS_VOICE from the server
// environment or the gitignored `.env`. Deepgram streaming goes through the
// local proxy /api/deepgram/stream (server-side key). Do NOT reintroduce a VITE_-
// prefixed TTS or Deepgram key in client code — a referenced VITE_ var gets
// inlined into the public bundle and the security test fails.
// ─────────────────────────────────────────────────────────────────────────────

export const voiceConfig = {
  tts: {
    endpoint: '/api/tts/synthesize',
    timeoutMs: 15000,
    format: 'wav',
  },
  // Conversational-gap detection for speak_when_convenient.
  gap: {
    minGapMs: Number(import.meta.env?.VITE_SPEECH_GAP_MIN_MS) || 700,
    maxWaitMs: Number(import.meta.env?.VITE_SPEECH_GAP_MAX_WAIT_MS) || 5000,
  },
  // Minimum genuine-speech duration before a barge-in stops playback — avoids a
  // single noise spike interrupting Roma.
  bargeInMinMs: Number(import.meta.env?.VITE_BARGE_IN_MIN_MS) || 200,
  // Spoken text length caps (characters). Direct answers are brief; unsolicited
  // coaching is briefer still.
  maxSpeechChars: 320,
  maxCoachingChars: 140,
  // Authorization lifetimes (ms) — a speak_now authorization that never plays
  // must eventually expire so it can't fire later out of context.
  directAuthorizationMs: 10000,
  convenientAuthorizationMs: 15000,
};

// Phrases that stop Roma immediately, WITHOUT waiting for an LLM. Kept
// configurable and lowercase; matched against normalized transcript text.
export const DEFAULT_STOP_PHRASES = [
  'stop',
  'stop talking',
  'stop it',
  'be quiet',
  'quiet',
  'cancel',
  'never mind',
  'nevermind',
  'wait',
  'hold on',
  'shush',
  'shut up',
];
