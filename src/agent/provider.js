// Model-provider abstraction. The runtime depends only on this interface:
//
//   provider.infer({ system, messages, schema, signal }) -> Promise<{ decisionRaw, usage, latencyMs }>
//
// `decisionRaw` is the parsed-but-not-yet-validated JSON object; schema.js's
// validateDecision() is the single source of truth for shape/safety, shared by
// every provider (including the mock), so swapping providers can never change
// what counts as a valid decision.
//
// createGroqProvider is the one real adapter today (Groq's OpenAI-compatible
// Chat Completions API with strict JSON-schema structured output). Model name,
// credentials, timeouts, and token limits all come from config/env — never
// hardcoded — and the API key is never logged.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => 300 * 2 ** attempt;

function isTransientError(error) {
  // Network failures (fetch throws TypeError) are worth a retry; anything else
  // (bad request, validation) is not.
  return error?.name === 'TypeError' || error?.transient === true;
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

/**
 * Deterministic/scripted provider for tests and the mock-only dev path.
 * @param {(context: { system: string, messages: Array }) => object|Promise<object>} decide
 */
export function createMockProvider(decide) {
  return {
    name: 'mock',
    async infer({ system, messages }) {
      const startedAt = Date.now();
      const decisionRaw = await decide({ system, messages });
      return { decisionRaw, usage: null, latencyMs: Date.now() - startedAt };
    },
  };
}

/**
 * @param {{
 *   apiKey: string, model?: string, baseUrl?: string, timeoutMs?: number,
 *   maxRetries?: number, maxTokens?: number, temperature?: number,
 *   reasoningEffort?: string, fetchImpl?: typeof fetch,
 * }} config
 */
export function createGroqProvider({
  apiKey,
  model = 'openai/gpt-oss-20b',
  baseUrl = 'https://api.groq.com/openai/v1',
  timeoutMs = 15000,
  maxRetries = 2,
  maxTokens = 600,
  temperature = 0.2,
  reasoningEffort = 'low',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('Groq provider requires an API key (set GROQ_API_KEY in the server environment).');
  if (typeof fetchImpl !== 'function') throw new Error('Groq provider requires a global fetch implementation.');

  return {
    name: 'groq',
    model,
    async infer({ system, messages, schema, signal }) {
      const body = {
        model,
        reasoning_effort: reasoningEffort,
        temperature,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'agent_decision', strict: true, schema },
        },
      };

      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort(signal?.reason);
        const timeout = setTimeout(() => controller.abort(new Error(`Groq request timed out after ${timeoutMs}ms`)), timeoutMs);
        signal?.addEventListener('abort', onExternalAbort, { once: true });

        const startedAt = Date.now();
        try {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const latencyMs = Date.now() - startedAt;

          if (!response.ok) {
            const errorBody = await safeJson(response);
            const message = errorBody?.error?.message || `Groq request failed with status ${response.status}`;
            // "Generated JSON does not match the expected schema" is a 400, but
            // it's a STOCHASTIC generation failure (Groq validates the model's
            // output server-side), not a bad request — one retry usually fixes it.
            const failedGeneration = response.status === 400 && /Generated JSON does not match/i.test(message);
            const retryable = response.status === 429 || response.status >= 500 || failedGeneration;
            if (retryable && attempt < maxRetries) { lastError = new Error(message); await sleep(backoffMs(attempt)); continue; }
            throw new Error(message);
          }

          const payload = await response.json();
          const content = payload.choices?.[0]?.message?.content;
          if (!content) throw new Error('Groq response contained no message content.');
          let decisionRaw;
          try { decisionRaw = JSON.parse(content); } catch { throw new Error('Groq response content was not valid JSON.'); }

          return { decisionRaw, usage: payload.usage ?? null, latencyMs };
        } catch (error) {
          if (error?.name === 'AbortError' || /timed out/.test(error?.message ?? '')) {
            throw new Error(`Groq request timed out or was aborted after ${timeoutMs}ms.`);
          }
          lastError = error;
          if (attempt < maxRetries && isTransientError(error)) { await sleep(backoffMs(attempt)); continue; }
          throw error;
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onExternalAbort);
        }
      }
      throw lastError ?? new Error('Groq request failed for an unknown reason.');
    },
  };
}

/**
 * Browser-side adapter: same infer() contract, but the request goes to the
 * local /api/agent/infer route (server/groqApi.js) which holds the API key —
 * the key never exists in the client bundle.
 */
export function createProxyProvider({ endpoint = '/api/agent/infer', timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'proxy',
    async infer({ system, messages, schema, signal }) {
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(signal?.reason);
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system, messages, schema }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? `Agent proxy failed with status ${response.status}`);
        return { decisionRaw: body.decisionRaw, usage: body.usage ?? null, latencyMs: body.latencyMs ?? Date.now() - startedAt };
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) throw new Error(`Agent proxy request timed out after ${timeoutMs}ms.`);
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/** Factory mirroring engine/index.js and inspector/index.js. */
export function createProvider(config = {}) {
  switch (config.provider ?? 'mock') {
    case 'groq':
      return createGroqProvider(config.groq ?? config);
    case 'proxy':
      return createProxyProvider(config.proxy ?? {});
    case 'mock':
    default:
      return createMockProvider(config.decide ?? (async () => ({
        decision: 'ignore', response: null, reason_summary: 'No provider configured.',
        task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null,
      })));
  }
}
