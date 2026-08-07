// Vision-provider abstraction. Everything above this file (deep analysis, agent
// tools, the server route) depends only on the common contract:
//
//   visionProvider.analyze({ image, question, sceneContext, transcriptContext,
//                            target, capturedAt, requestedAt, signal })
//     -> Promise<{ result: ValidatedVisionResult, usage, latencyMs, model }>
//
// Implementations:
//  - createGroqVisionProvider — real: Groq's OpenAI-compatible multimodal chat
//    API (data-URL image + text prompt, JSON-object response). Runs SERVER-side
//    (or in Node scripts) — the API key never reaches the browser.
//  - createProxyVisionProvider — browser: POSTs the same payload to the local
//    /api/vision/analyze route, which holds the key.
//  - createMockVisionProvider — tests / offline simulation.
//
// Every provider's output passes validateVisionResult before being returned;
// malformed model output throws a typed VisionProviderError instead of leaking
// to the agent. Errors carry a `code` so callers can distinguish auth vs
// transient vs invalid-response failures — only transient ones are retried,
// exactly once.

import { VISION_RESULT_JSON_SCHEMA, validateVisionResult } from './schema.js';

export class VisionProviderError extends Error {
  /** @param {'auth'|'rate_limit'|'timeout'|'network'|'invalid_request'|'invalid_response'|'server'} code */
  constructor(code, message) {
    super(message);
    this.name = 'VisionProviderError';
    this.code = code;
  }
}

const TRANSIENT_CODES = new Set(['rate_limit', 'network', 'server']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VISION_SYSTEM_PROMPT = `You are a precise visual analyst for a live assistant. You receive one camera \
frame plus context, and must answer a specific question about what is VISIBLE.

Rules:
- Report only what you can actually see in the image. Never invent objects, \
people, text, or locations.
- The "fast detector hints" come from a lightweight local detector and may be \
wrong or generic — inspect the image independently rather than repeating them.
- If you are unsure, say so in "uncertainty" and use a lower confidence. Do not \
overstate certainty about specialized items that generic shapes could explain.
- Report any clearly legible text in "visibleText".
- Set "requiresAnotherFrame" to true only if a different frame or angle would \
materially improve the answer.
- Respond with ONLY a JSON object matching this schema (no prose, no markdown):
${JSON.stringify(VISION_RESULT_JSON_SCHEMA)}`;

export function buildVisionMessages({ image, question, sceneContext, transcriptContext, target, capturedAt, requestedAt }) {
  const ageMs = capturedAt && requestedAt ? Math.max(0, requestedAt - capturedAt) : null;
  const lines = [
    `QUESTION: ${question}`,
    target ? `REQUESTED TARGET: ${target}` : null,
    ageMs != null ? `FRAME AGE: captured ${ageMs} ms before this request` : null,
    sceneContext ? `FAST DETECTOR HINTS (may be wrong):\n${sceneContext}` : null,
    transcriptContext ? `RECENT CONVERSATION CONTEXT:\n${transcriptContext}` : null,
  ].filter(Boolean);

  return [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: lines.join('\n\n') },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ];
}

/**
 * @param {{ apiKey: string, model: string, baseUrl?: string, timeoutMs?: number,
 *           maxTokens?: number, temperature?: number, fetchImpl?: typeof fetch }} config
 */
export function createGroqVisionProvider({
  apiKey,
  model,
  baseUrl = 'https://api.groq.com/openai/v1',
  timeoutMs = 25000,
  maxTokens = 800,
  temperature = 0.2,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new VisionProviderError('auth', 'Vision provider requires an API key (GROQ_API_KEY).');
  if (!model) throw new VisionProviderError('invalid_request', 'Vision provider requires a model (VISION_MODEL).');

  async function requestOnce(payload, signal) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        let message = `Vision request failed with status ${response.status}`;
        try { message = (await response.json())?.error?.message ?? message; } catch { /* keep default */ }
        if (response.status === 401 || response.status === 403) throw new VisionProviderError('auth', message);
        if (response.status === 429) throw new VisionProviderError('rate_limit', message);
        if (response.status >= 500) throw new VisionProviderError('server', message);
        throw new VisionProviderError('invalid_request', message);
      }
      const body = await response.json();
      return { body, latencyMs };
    } catch (error) {
      if (error instanceof VisionProviderError) throw error;
      if (signal?.aborted) throw new VisionProviderError('timeout', 'Vision request was aborted by the caller.');
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new VisionProviderError('timeout', `Vision request timed out after ${timeoutMs}ms.`);
      }
      throw new VisionProviderError('network', error?.message ?? 'Network failure during vision request.');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    name: 'groq-vision',
    model,
    async analyze({ image, question, sceneContext, transcriptContext, target, capturedAt, requestedAt, signal }) {
      if (!image || !question) throw new VisionProviderError('invalid_request', 'Vision analysis requires an image and a question.');
      const payload = {
        model,
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: buildVisionMessages({ image, question, sceneContext, transcriptContext, target, capturedAt, requestedAt }),
      };

      let attempt = 0;
      // One bounded retry, only for transient failures (rate limit / network / 5xx).
      // Auth, invalid requests, and validation failures are never retried.
      for (;;) {
        try {
          const { body, latencyMs } = await requestOnce(payload, signal);
          const content = body.choices?.[0]?.message?.content;
          if (!content) throw new VisionProviderError('invalid_response', 'Vision response contained no message content.');
          let raw;
          try { raw = JSON.parse(content); } catch { throw new VisionProviderError('invalid_response', 'Vision response was not valid JSON.'); }
          const validation = validateVisionResult(raw);
          if (!validation.ok) throw new VisionProviderError('invalid_response', `Vision result failed validation: ${validation.errors.join('; ')}`);
          return { result: validation.result, usage: body.usage ?? null, latencyMs, model };
        } catch (error) {
          if (error instanceof VisionProviderError && TRANSIENT_CODES.has(error.code) && attempt === 0 && !signal?.aborted) {
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

/** Browser-side adapter: same contract, but the key stays on the server. */
export function createProxyVisionProvider({ endpoint = '/api/vision/analyze', timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'proxy-vision',
    model: 'server-configured',
    async analyze({ image, question, sceneContext, transcriptContext, target, capturedAt, requestedAt, signal }) {
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(signal?.reason);
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image, question, sceneContext, transcriptContext, target, capturedAt, requestedAt }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new VisionProviderError(body?.code ?? 'server', body?.error ?? `Vision proxy failed with status ${response.status}`);
        }
        const validation = validateVisionResult(body?.result);
        if (!validation.ok) throw new VisionProviderError('invalid_response', `Vision proxy returned an invalid result: ${validation.errors.join('; ')}`);
        return { result: validation.result, usage: body.usage ?? null, latencyMs: body.latencyMs ?? null, model: body.model ?? 'server-configured' };
      } catch (error) {
        if (error instanceof VisionProviderError) throw error;
        if (controller.signal.aborted) throw new VisionProviderError('timeout', `Vision proxy request timed out after ${timeoutMs}ms.`);
        throw new VisionProviderError('network', error?.message ?? 'Network failure reaching the vision proxy.');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/** Scripted provider for tests and offline development. */
export function createMockVisionProvider(decide) {
  return {
    name: 'mock-vision',
    model: 'mock-vision',
    async analyze(request) {
      const startedAt = Date.now();
      const raw = await decide(request);
      const validation = validateVisionResult(raw);
      if (!validation.ok) throw new VisionProviderError('invalid_response', `Mock vision result failed validation: ${validation.errors.join('; ')}`);
      return { result: validation.result, usage: null, latencyMs: Date.now() - startedAt, model: 'mock-vision' };
    },
  };
}
