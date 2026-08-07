// Server-side Groq API layer, packaged as a Vite plugin so `npm run dev` (and
// `npm run preview`) serve it with no second process. The GROQ_API_KEY is read
// here, inside the Node process, and never enters the client bundle, client
// logs, or any response body.
//
// Routes (all JSON):
//   GET  /api/health          -> { ok, agent: {available, model}, vision: {available, model} }
//   POST /api/agent/infer     -> { decisionRaw, usage, latencyMs }        (body: { system, messages, schema })
//   POST /api/vision/analyze  -> { result, usage, latencyMs, model }      (body: { image, question, ... })
//
// The browser talks to these via createProxyProvider (agent) and
// createProxyVisionProvider (vision). Node scripts/tests skip this layer and
// call the Groq providers directly — they're already server-side.

import { loadServerEnv } from './env.mjs';
import { createGroqProvider } from '../src/agent/provider.js';
import { createGroqVisionProvider, VisionProviderError } from '../src/vision/provider.js';
import { createTtsProvider, TtsProviderError, bytesToBase64 } from '../src/voice/ttsProvider.js';
import { createVoiceCatalog } from '../src/voice/voiceCatalog.js';
import { attachDeepgramProxy } from './deepgramProxy.mjs';
import { getSharedVoiceIdentityService } from './voiceIdentity/service.mjs';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // vision payloads carry a base64 JPEG

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Request body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const VISION_ERROR_STATUS = { auth: 502, rate_limit: 429, timeout: 504, network: 502, server: 502, invalid_request: 400, invalid_response: 502 };
const TTS_ERROR_STATUS = { auth: 502, rate_limit: 429, timeout: 504, network: 502, server: 502, invalid_request: 400, invalid_response: 502, unauthorized: 403 };

export function createApiHandlers({ env = loadServerEnv(), log = console, voiceIdentity = getSharedVoiceIdentityService() } = {}) {
  for (const warning of env.warnings) log.warn(`[groq-api] ${warning}`);
  if (!env.groqApiKey) log.warn('[groq-api] No GROQ_API_KEY found (env or .env) — /api/agent and /api/vision will return 503; the app falls back to mock providers.');

  let agentProvider = null;
  let visionProvider = null;
  let opportunityProvider = null;
  let ttsProvider = null;
  const voiceCatalog = createVoiceCatalog();
  function getAgentProvider() {
    agentProvider ??= createGroqProvider({ apiKey: env.groqApiKey, model: env.agentModel, baseUrl: env.baseUrl });
    return agentProvider;
  }
  function getVisionProvider() {
    visionProvider ??= createGroqVisionProvider({ apiKey: env.groqApiKey, model: env.visionModel, baseUrl: env.baseUrl });
    return visionProvider;
  }
  function getOpportunityProvider() {
    opportunityProvider ??= createGroqProvider({ apiKey: env.groqApiKey, model: env.opportunityModel, baseUrl: env.baseUrl });
    return opportunityProvider;
  }
  function getTtsProvider() {
    ttsProvider ??= createTtsProvider({ provider: env.tts.provider, apiKey: env.tts.apiKey, model: env.tts.model, voice: env.tts.voice, baseUrl: env.tts.baseUrl });
    return ttsProvider;
  }

  return {
    health(_req, res) {
      sendJson(res, 200, {
        ok: true,
        agent: { available: Boolean(env.groqApiKey), model: env.agentModel },
        vision: { available: Boolean(env.groqApiKey), model: env.visionModel },
        opportunity: { available: Boolean(env.groqApiKey), model: env.opportunityModel },
        tts: { available: Boolean(env.tts.apiKey), provider: env.tts.provider, model: env.tts.model, voice: env.tts.voice },
        deepgram: { available: Boolean(env.deepgramApiKey) },
        voiceIdentity: voiceIdentity.getProviderStatus(),
      });
    },

    async agentInfer(req, res) {
      if (!env.groqApiKey) { sendJson(res, 503, { error: 'No GROQ_API_KEY configured on the server.', code: 'auth' }); return; }
      try {
        const { system, messages, schema } = await readJsonBody(req);
        if (typeof system !== 'string' || !Array.isArray(messages)) { sendJson(res, 400, { error: 'Body must include { system, messages, schema }.' }); return; }
        const outcome = await getAgentProvider().infer({ system, messages, schema });
        sendJson(res, 200, outcome);
      } catch (error) {
        // Provider errors never include the key; message text is safe to relay.
        sendJson(res, 502, { error: error?.message ?? 'Agent inference failed.' });
      }
    },

    async opportunityEvaluate(req, res) {
      if (!env.groqApiKey) { sendJson(res, 503, { error: 'No GROQ_API_KEY configured on the server.', code: 'auth' }); return; }
      try {
        const { system, messages, schema } = await readJsonBody(req);
        if (typeof system !== 'string' || !Array.isArray(messages)) { sendJson(res, 400, { error: 'Body must include { system, messages, schema }.' }); return; }
        const outcome = await getOpportunityProvider().infer({ system, messages, schema });
        sendJson(res, 200, outcome);
      } catch (error) {
        sendJson(res, 502, { error: error?.message ?? 'Opportunity evaluation failed.' });
      }
    },

    // Server-side provider metadata: the client never hardcodes a voice list —
    // it always asks here, and the server always asks the real provider (with
    // the key it never releases). No credentials in the response.
    async ttsVoices(_req, res) {
      if (!env.tts.apiKey) { sendJson(res, 503, { error: 'No TTS credentials configured on the server.', code: 'auth' }); return; }
      try {
        const { voices, fallback } = await voiceCatalog.listVoices({ provider: env.tts.provider, apiKey: env.tts.apiKey, defaultVoice: env.tts.voice });
        sendJson(res, 200, { provider: env.tts.provider, model: env.tts.model, defaultVoice: env.tts.voice, voices, fallback });
      } catch (error) {
        sendJson(res, 502, { error: error?.message ?? 'Could not load the voice catalog.', code: 'server' });
      }
    },

    async ttsSynthesize(req, res) {
      if (!env.tts.apiKey) { sendJson(res, 503, { error: 'No TTS credentials configured on the server (TTS_API_KEY / GROQ_API_KEY).', code: 'auth' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body?.text !== 'string' || !body.text.trim()) { sendJson(res, 400, { error: 'Body must include non-empty { text }.', code: 'invalid_request' }); return; }

        // Validate a client-selected voice against the real catalog. An
        // unrecognized voice (stale localStorage, provider swap, tampering)
        // silently falls back to the server-configured default rather than
        // being passed through to the provider unchecked.
        let voice = env.tts.voice;
        let voiceFallback = false;
        if (typeof body.voice === 'string' && body.voice && body.voice !== env.tts.voice) {
          const { voices } = await voiceCatalog.listVoices({ provider: env.tts.provider, apiKey: env.tts.apiKey, defaultVoice: env.tts.voice });
          if (voices.some((v) => v.id === body.voice)) voice = body.voice;
          else voiceFallback = true;
        }

        const outcome = await getTtsProvider().synthesize({ text: body.text, voice, model: body.model, format: body.format });
        // Audio bytes travel as base64 (never the key). No secrets in the body.
        sendJson(res, 200, {
          audioBase64: bytesToBase64(outcome.audio),
          contentType: outcome.contentType,
          provider: outcome.provider,
          model: outcome.model,
          voice: outcome.voice,
          voiceFallback,
          byteLength: outcome.byteLength,
          durationMs: outcome.durationMs,
          providerLatencyMs: outcome.providerLatencyMs,
        });
      } catch (error) {
        if (error instanceof TtsProviderError) sendJson(res, TTS_ERROR_STATUS[error.code] ?? 502, { error: error.message, code: error.code });
        else sendJson(res, 502, { error: error?.message ?? 'TTS synthesis failed.', code: 'server' });
      }
    },

    async visionAnalyze(req, res) {
      if (!env.groqApiKey) { sendJson(res, 503, { error: 'No GROQ_API_KEY configured on the server.', code: 'auth' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body?.image !== 'string' || typeof body?.question !== 'string') {
          sendJson(res, 400, { error: 'Body must include { image (data URL), question }.', code: 'invalid_request' });
          return;
        }
        const outcome = await getVisionProvider().analyze({
          image: body.image,
          question: body.question,
          sceneContext: body.sceneContext,
          transcriptContext: body.transcriptContext,
          target: body.target,
          capturedAt: body.capturedAt,
          requestedAt: body.requestedAt ?? Date.now(),
        });
        sendJson(res, 200, outcome);
      } catch (error) {
        if (error instanceof VisionProviderError) {
          sendJson(res, VISION_ERROR_STATUS[error.code] ?? 502, { error: error.message, code: error.code });
        } else {
          sendJson(res, 502, { error: error?.message ?? 'Vision analysis failed.', code: 'server' });
        }
      }
    },
  };
}

function attach(middlewares, handlers) {
  middlewares.use('/api/health', (req, res, next) => (req.method === 'GET' ? handlers.health(req, res) : next()));
  middlewares.use('/api/agent/infer', (req, res, next) => (req.method === 'POST' ? handlers.agentInfer(req, res) : next()));
  middlewares.use('/api/opportunity/evaluate', (req, res, next) => (req.method === 'POST' ? handlers.opportunityEvaluate(req, res) : next()));
  middlewares.use('/api/vision/analyze', (req, res, next) => (req.method === 'POST' ? handlers.visionAnalyze(req, res) : next()));
  middlewares.use('/api/tts/synthesize', (req, res, next) => (req.method === 'POST' ? handlers.ttsSynthesize(req, res) : next()));
  middlewares.use('/api/tts/voices', (req, res, next) => (req.method === 'GET' ? handlers.ttsVoices(req, res) : next()));
}

export function groqApiPlugin({ voiceIdentity = getSharedVoiceIdentityService() } = {}) {
  const env = loadServerEnv();
  let handlers;
  const setup = (server) => {
    handlers ??= createApiHandlers({ env, voiceIdentity });
    attach(server.middlewares, handlers);
    // The Deepgram key stays server-side: the browser streams to us and we proxy
    // to Deepgram. Attached to the underlying Node httpServer's 'upgrade' event.
    if (server.httpServer) attachDeepgramProxy(server.httpServer, { apiKey: env.deepgramApiKey, voiceIdentity });
  };
  return {
    name: 'roma-groq-api',
    configureServer(server) { setup(server); },
    configurePreviewServer(server) { setup(server); },
  };
}
