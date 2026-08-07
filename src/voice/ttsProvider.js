// TTS-provider abstraction. Everything above this file (voice delivery, the
// server route) depends only on the common contract:
//
//   ttsProvider.synthesize({ text, voice, model, format, sampleRate,
//                            authorizationId, turnId, signal })
//     -> Promise<{ audio, contentType, provider, model, voice, byteLength,
//                  durationMs, providerLatencyMs }>
//
// Implementations:
//  - createGroqTtsProvider  — real: Groq's OpenAI-compatible /audio/speech
//    endpoint (PlayAI TTS). Runs SERVER-side (or in Node scripts); the key never
//    reaches the browser.
//  - createProxyTtsProvider — browser: POSTs to the local /api/tts/synthesize
//    route which holds the key; returns audio bytes as a base64 string.
//  - createMockTtsProvider  — tests / offline simulation (silent PCM/wav).
//
// Errors are typed with a `code` so callers retry only transient failures
// (rate_limit / network / server), exactly once. Auth, validation, and
// too-long-text failures are never retried. The API key is never logged.

const TRANSIENT_CODES = new Set(['rate_limit', 'network', 'server']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TtsProviderError extends Error {
  /** @param {'auth'|'rate_limit'|'timeout'|'network'|'invalid_request'|'invalid_response'|'server'|'unauthorized'} code */
  constructor(code, message) {
    super(message);
    this.name = 'TtsProviderError';
    this.code = code;
  }
}

export const MAX_TTS_CHARS = 800;

function assertSynthesizable(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TtsProviderError('invalid_request', 'TTS requires non-empty text.');
  }
  if (text.length > MAX_TTS_CHARS) {
    throw new TtsProviderError('invalid_request', `TTS text exceeds the ${MAX_TTS_CHARS}-character maximum.`);
  }
}

/**
 * Real Groq PlayAI TTS. Groq's OpenAI-compatible speech route returns raw audio
 * bytes (not JSON), so we read an ArrayBuffer.
 *
 * @param {{ apiKey: string, model?: string, voice?: string, baseUrl?: string,
 *           timeoutMs?: number, format?: string, fetchImpl?: typeof fetch }} config
 */
export function createGroqTtsProvider({
  apiKey,
  model = 'playai-tts',
  voice = 'Fritz-PlayAI',
  baseUrl = 'https://api.groq.com/openai/v1',
  timeoutMs = 15000,
  format = 'wav',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new TtsProviderError('auth', 'TTS provider requires an API key (TTS_API_KEY / GROQ_API_KEY).');
  if (typeof fetchImpl !== 'function') throw new TtsProviderError('invalid_request', 'TTS provider requires a fetch implementation.');

  async function requestOnce(payload, signal) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const providerLatencyMs = Date.now() - startedAt;
      if (!response.ok) {
        let message = `TTS request failed with status ${response.status}`;
        try { message = (await response.json())?.error?.message ?? message; } catch { /* keep default */ }
        if (response.status === 401 || response.status === 403) throw new TtsProviderError('auth', message);
        if (response.status === 429) throw new TtsProviderError('rate_limit', message);
        if (response.status >= 500) throw new TtsProviderError('server', message);
        throw new TtsProviderError('invalid_request', message);
      }
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.byteLength) throw new TtsProviderError('invalid_response', 'TTS response contained no audio.');
      return { audio, providerLatencyMs, contentType: response.headers?.get?.('content-type') ?? `audio/${format}` };
    } catch (error) {
      if (error instanceof TtsProviderError) throw error;
      if (signal?.aborted) throw new TtsProviderError('timeout', 'TTS request was aborted by the caller.');
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new TtsProviderError('timeout', `TTS request timed out after ${timeoutMs}ms.`);
      throw new TtsProviderError('network', error?.message ?? 'Network failure during TTS request.');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    name: 'groq-tts',
    model,
    voice,
    async synthesize({ text, voice: voiceOverride, model: modelOverride, format: formatOverride, signal } = {}) {
      assertSynthesizable(text);
      const useVoice = voiceOverride || voice;
      const useModel = modelOverride || model;
      const useFormat = formatOverride || format;
      const payload = { model: useModel, voice: useVoice, input: text, response_format: useFormat };

      let attempt = 0;
      for (;;) {
        try {
          const { audio, providerLatencyMs, contentType } = await requestOnce(payload, signal);
          return {
            audio,
            contentType,
            provider: 'groq-tts',
            model: useModel,
            voice: useVoice,
            byteLength: audio.byteLength,
            durationMs: null, // container-dependent; the player reports real duration
            providerLatencyMs,
          };
        } catch (error) {
          if (error instanceof TtsProviderError && TRANSIENT_CODES.has(error.code) && attempt === 0 && !signal?.aborted) {
            attempt += 1;
            await sleep(400);
            continue;
          }
          throw error;
        }
      }
    },
  };
}

/**
 * Real Deepgram Aura TTS — the default in this project (the Deepgram key is
 * already provisioned for STT, and Groq's PlayAI TTS was decommissioned). Same
 * contract as the Groq provider; returns MP3 bytes by default.
 *
 * @param {{ apiKey: string, model?: string, baseUrl?: string, timeoutMs?: number,
 *           format?: string, fetchImpl?: typeof fetch }} config
 */
export function createDeepgramTtsProvider({
  apiKey,
  model = 'aura-2-thalia-en',
  baseUrl = 'https://api.deepgram.com/v1',
  timeoutMs = 15000,
  format = 'mp3',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new TtsProviderError('auth', 'Deepgram TTS provider requires an API key (TTS_API_KEY / DEEPGRAM_API_KEY).');
  if (typeof fetchImpl !== 'function') throw new TtsProviderError('invalid_request', 'TTS provider requires a fetch implementation.');
  const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
  // Deepgram selects the audio container via query params; MP3 is the default.
  const query = format === 'wav' ? `?model=${encodeURIComponent(model)}&encoding=linear16&container=wav&sample_rate=24000` : `?model=${encodeURIComponent(model)}`;

  async function requestOnce(text, signal) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}/speak${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const providerLatencyMs = Date.now() - startedAt;
      if (!response.ok) {
        let message = `Deepgram TTS request failed with status ${response.status}`;
        try { message = (await response.json())?.err_msg ?? message; } catch { /* keep default */ }
        if (response.status === 401 || response.status === 403) throw new TtsProviderError('auth', message);
        if (response.status === 429) throw new TtsProviderError('rate_limit', message);
        if (response.status >= 500) throw new TtsProviderError('server', message);
        throw new TtsProviderError('invalid_request', message);
      }
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.byteLength) throw new TtsProviderError('invalid_response', 'Deepgram TTS response contained no audio.');
      return { audio, providerLatencyMs };
    } catch (error) {
      if (error instanceof TtsProviderError) throw error;
      if (signal?.aborted) throw new TtsProviderError('timeout', 'Deepgram TTS request was aborted by the caller.');
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new TtsProviderError('timeout', `Deepgram TTS request timed out after ${timeoutMs}ms.`);
      throw new TtsProviderError('network', error?.message ?? 'Network failure during Deepgram TTS request.');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    name: 'deepgram-tts',
    model,
    voice: model, // Aura encodes the voice in the model id (e.g. aura-2-thalia-en)
    async synthesize({ text, model: modelOverride, signal } = {}) {
      assertSynthesizable(text);
      const useModel = modelOverride || model;
      let attempt = 0;
      for (;;) {
        try {
          const { audio, providerLatencyMs } = await requestOnce(text, signal);
          return {
            audio, contentType, provider: 'deepgram-tts', model: useModel, voice: useModel,
            byteLength: audio.byteLength, durationMs: null, providerLatencyMs,
          };
        } catch (error) {
          if (error instanceof TtsProviderError && TRANSIENT_CODES.has(error.code) && attempt === 0 && !signal?.aborted) {
            attempt += 1; await sleep(400); continue;
          }
          throw error;
        }
      }
    },
  };
}

/** Browser-side adapter: same contract, key stays on the server. Audio is
 *  transported as base64 and decoded to bytes here. */
export function createProxyTtsProvider({ endpoint = '/api/tts/synthesize', timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'proxy-tts',
    model: 'server-configured',
    voice: 'server-configured',
    async synthesize({ text, voice, model, format, signal } = {}) {
      assertSynthesizable(text);
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(signal?.reason);
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, model, format }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new TtsProviderError(body?.code ?? 'server', body?.error ?? `TTS proxy failed with status ${response.status}`);
        if (typeof body?.audioBase64 !== 'string') throw new TtsProviderError('invalid_response', 'TTS proxy returned no audio.');
        const audio = base64ToBytes(body.audioBase64);
        return {
          audio,
          contentType: body.contentType ?? 'audio/wav',
          provider: body.provider ?? 'proxy-tts',
          model: body.model ?? 'server-configured',
          voice: body.voice ?? 'server-configured',
          byteLength: audio.byteLength,
          durationMs: body.durationMs ?? null,
          providerLatencyMs: body.providerLatencyMs ?? null,
        };
      } catch (error) {
        if (error instanceof TtsProviderError) throw error;
        if (controller.signal.aborted) throw new TtsProviderError('timeout', `TTS proxy request timed out after ${timeoutMs}ms.`);
        throw new TtsProviderError('network', error?.message ?? 'Network failure reaching the TTS proxy.');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/** Scripted provider for tests / offline simulation — returns deterministic
 *  silent bytes and honors abort so cancellation paths can be exercised. */
export function createMockTtsProvider({ latencyMs = 5, bytesPerChar = 16, failWith = null } = {}) {
  return {
    name: 'mock-tts',
    model: 'mock-tts',
    voice: 'mock-voice',
    async synthesize({ text, voice, model, signal } = {}) {
      assertSynthesizable(text);
      if (failWith) throw new TtsProviderError(failWith.code ?? 'server', failWith.message ?? 'mock failure');
      const startedAt = Date.now();
      await new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new TtsProviderError('timeout', 'aborted before start')); return; }
        const timer = setTimeout(resolve, latencyMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new TtsProviderError('timeout', 'aborted during synthesis')); }, { once: true });
      });
      const audio = new Uint8Array(Math.max(1, text.length * bytesPerChar));
      return {
        audio,
        contentType: 'audio/wav',
        provider: 'mock-tts',
        model: model || 'mock-tts',
        voice: voice || 'mock-voice',
        byteLength: audio.byteLength,
        durationMs: Math.round(text.length * 60),
        providerLatencyMs: Date.now() - startedAt,
      };
    },
  };
}

/** Factory mirroring the agent/vision provider factories. */
export function createTtsProvider(config = {}) {
  switch (config.provider ?? 'mock') {
    case 'deepgram':
    case 'deepgram-tts':
      return createDeepgramTtsProvider(config.deepgram ?? config);
    case 'groq':
    case 'groq-tts':
      return createGroqTtsProvider(config.groq ?? config);
    case 'proxy':
      return createProxyTtsProvider(config.proxy ?? {});
    case 'mock':
    default:
      return createMockTtsProvider(config.mock ?? {});
  }
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(base64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
