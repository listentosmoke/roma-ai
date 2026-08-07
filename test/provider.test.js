import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqProvider, createMockProvider, createProvider } from '../src/agent/provider.js';
import { AGENT_DECISION_JSON_SCHEMA } from '../src/agent/schema.js';

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const sampleDecision = {
  decision: 'ignore', response: null, reason_summary: 'ambient', task_update: null,
  tool_calls: [], visual_analysis_request: null, scene_revision_used: 1,
};

test('groq provider sends model/reasoning_effort/strict json_schema and parses the decision', async () => {
  let capturedUrl, capturedBody, capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedUrl = url; capturedBody = JSON.parse(init.body); capturedHeaders = init.headers;
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(sampleDecision) } }], usage: { total_tokens: 42 } });
  };

  const provider = createGroqProvider({ apiKey: 'sk-test', model: 'openai/gpt-oss-20b', fetchImpl });
  const result = await provider.infer({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], schema: AGENT_DECISION_JSON_SCHEMA });

  assert.match(capturedUrl, /\/chat\/completions$/);
  assert.equal(capturedBody.model, 'openai/gpt-oss-20b');
  assert.equal(capturedBody.reasoning_effort, 'low');
  assert.equal(capturedBody.response_format.type, 'json_schema');
  assert.equal(capturedBody.response_format.json_schema.strict, true);
  assert.deepEqual(capturedBody.response_format.json_schema.schema, AGENT_DECISION_JSON_SCHEMA);
  assert.equal(capturedHeaders.Authorization, 'Bearer sk-test');
  assert.deepEqual(result.decisionRaw, sampleDecision);
  assert.equal(result.usage.total_tokens, 42);
  assert.ok(result.latencyMs >= 0);
});

test('groq provider never logs the API key on failure', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'bad request' } }, { status: 400 });
  const provider = createGroqProvider({ apiKey: 'sk-should-not-appear', fetchImpl });
  await assert.rejects(
    () => provider.infer({ system: 's', messages: [], schema: AGENT_DECISION_JSON_SCHEMA }),
    (error) => {
      assert.ok(!error.message.includes('sk-should-not-appear'));
      assert.match(error.message, /bad request/);
      return true;
    },
  );
});

test('groq provider retries once on 429 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'rate limited' } }, { status: 429 });
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(sampleDecision) } }] });
  };
  const provider = createGroqProvider({ apiKey: 'sk-test', fetchImpl, maxRetries: 2 });
  const result = await provider.infer({ system: 's', messages: [], schema: AGENT_DECISION_JSON_SCHEMA });
  assert.equal(calls, 2);
  assert.deepEqual(result.decisionRaw, sampleDecision);
});

test('groq provider does not retry a non-transient 400', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ error: { message: 'bad request' } }, { status: 400 }); };
  const provider = createGroqProvider({ apiKey: 'sk-test', fetchImpl, maxRetries: 2 });
  await assert.rejects(() => provider.infer({ system: 's', messages: [], schema: AGENT_DECISION_JSON_SCHEMA }));
  assert.equal(calls, 1);
});

test('groq provider aborts on timeout', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const provider = createGroqProvider({ apiKey: 'sk-test', fetchImpl, timeoutMs: 30, maxRetries: 0 });
  await assert.rejects(
    () => provider.infer({ system: 's', messages: [], schema: AGENT_DECISION_JSON_SCHEMA }),
    /timed out/,
  );
});

test('groq provider requires an api key and a fetch implementation', () => {
  assert.throws(() => createGroqProvider({ apiKey: '' }), /API key/);
  assert.throws(() => createGroqProvider({ apiKey: 'x', fetchImpl: null }), /fetch/);
});

test('mock provider wraps a scripted decision function with timing', async () => {
  const provider = createMockProvider(async () => sampleDecision);
  const result = await provider.infer({ system: 's', messages: [] });
  assert.deepEqual(result.decisionRaw, sampleDecision);
  assert.equal(result.usage, null);
  assert.ok(result.latencyMs >= 0);
});

test('createProvider factory switches adapters from config, defaulting to mock', () => {
  const mock = createProvider({});
  assert.equal(mock.name, 'mock');
  const groq = createProvider({ provider: 'groq', groq: { apiKey: 'sk-test', fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '{}' } }] }) } });
  assert.equal(groq.name, 'groq');
});
