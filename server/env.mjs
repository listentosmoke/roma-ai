// Server-side env loading. The GROQ key lives here — in the Node process that
// runs Vite — and is NEVER handed to the client bundle. (Vite only inlines
// import.meta.env.VITE_* variables that client code references; no client file
// references VITE_GROQ_API_KEY anymore, and test/security.test.js enforces that.)
//
// Preferred names:      GROQ_API_KEY, GROQ_MODEL, GROQ_BASE_URL, VISION_MODEL
// Legacy fallbacks:     VITE_GROQ_API_KEY / VITE_GROQ_MODEL / VITE_GROQ_BASE_URL
//                       (accepted with a warning so older .env files keep working —
//                       rename them to drop the VITE_ prefix.)

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseDotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#')) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

/**
 * The environment the background worker is CONFIGURED from: `process.env`
 * with `.env` filling in whatever it does not set (same precedence as
 * loadServerEnv's `get`). `.env` is deliberately never merged into the real
 * `process.env` — this returns a copy, and the worker's own allowlist
 * (server/agentEnv/workers/qwenProtocol.mjs) decides what little of it
 * actually reaches the child process.
 */
export function loadWorkerConfigEnv({ root = process.cwd() } = {}) {
  const path = resolve(root, '.env');
  const fileValues = existsSync(path) ? parseDotEnv(readFileSync(path, 'utf8')) : {};
  return { ...fileValues, ...process.env };
}

export function loadServerEnv({ root = process.cwd() } = {}) {
  const fileValues = (() => {
    const path = resolve(root, '.env');
    return existsSync(path) ? parseDotEnv(readFileSync(path, 'utf8')) : {};
  })();
  const get = (...names) => {
    for (const name of names) {
      const value = process.env[name] ?? fileValues[name];
      if (value) return value;
    }
    return '';
  };

  const warnings = [];
  let groqApiKey = get('GROQ_API_KEY');
  if (!groqApiKey) {
    groqApiKey = get('VITE_GROQ_API_KEY');
    if (groqApiKey) warnings.push('Using VITE_GROQ_API_KEY as the server key — rename it to GROQ_API_KEY (the VITE_ prefix marks variables as client-exposable).');
  }

  const agentModel = get('GROQ_MODEL', 'VITE_GROQ_MODEL') || 'openai/gpt-oss-20b';
  const baseUrl = get('GROQ_BASE_URL', 'VITE_GROQ_BASE_URL') || 'https://api.groq.com/openai/v1';

  // ── Deepgram (STT) — server-side key; the browser streams through the local
  // proxy /api/deepgram/stream (server/deepgramProxy.mjs), which authenticates
  // upstream with this key. Legacy VITE_DEEPGRAM_API_KEY is accepted (with
  // a warning) so old .env files keep working; rename it to DEEPGRAM_API_KEY.
  let deepgramApiKey = get('DEEPGRAM_API_KEY');
  if (!deepgramApiKey) {
    deepgramApiKey = get('VITE_DEEPGRAM_API_KEY');
    if (deepgramApiKey) warnings.push('Using VITE_DEEPGRAM_API_KEY as the server key — rename it to DEEPGRAM_API_KEY (the VITE_ prefix marks variables as client-exposable, and the client no longer reads it).');
  }

  // ── TTS — server-side key. Defaults to Deepgram Aura (the Deepgram key is
  // already provisioned for STT, and Groq's PlayAI TTS was decommissioned). Set
  // TTS_PROVIDER=groq to use an OpenAI-compatible /audio/speech endpoint instead.
  const ttsProvider = get('TTS_PROVIDER') || 'deepgram';
  const ttsIsDeepgram = ttsProvider === 'deepgram' || ttsProvider === 'deepgram-tts';
  const ttsApiKey = get('TTS_API_KEY') || (ttsIsDeepgram ? deepgramApiKey : groqApiKey);
  const ttsBaseUrl = get('TTS_BASE_URL') || (ttsIsDeepgram ? 'https://api.deepgram.com/v1' : baseUrl);
  const ttsModel = get('TTS_MODEL') || (ttsIsDeepgram ? 'aura-2-thalia-en' : 'playai-tts');
  const ttsVoice = get('TTS_VOICE') || (ttsIsDeepgram ? 'aura-2-thalia-en' : 'Fritz-PlayAI');
  return {
    groqApiKey,
    baseUrl,
    agentModel,
    visionModel: get('VISION_MODEL') || 'meta-llama/llama-4-scout-17b-16e-instruct',
    // The Opportunity Engine defaults to the main-agent model; override with
    // OPPORTUNITY_MODEL to run proactive evaluation on a different model.
    opportunityModel: get('OPPORTUNITY_MODEL') || agentModel,
    deepgramApiKey,
    tts: {
      provider: ttsProvider,
      apiKey: ttsApiKey,
      baseUrl: ttsBaseUrl,
      model: ttsModel,
      voice: ttsVoice,
    },
    warnings,
  };
}
