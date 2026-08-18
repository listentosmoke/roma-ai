import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/agent/tools.js';
import { registerMemoryTools } from '../src/memory/tools.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createAgentRuntime } from '../src/agent/runtime.js';

function commitmentCandidates(summary) {
  return {
    candidates: [{
      action: 'store', type: 'commitment', subject_id: 'person_user', predicate: 'send_quote', object: [],
      summary, confidence: 0.9, importance: 0.8, evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'explicit', tags: ['matt'],
    }],
  };
}

test('remember_this tool stores a memory through the coordinator', async () => {
  const repository = createInMemoryRepository();
  const memory = createMemoryCoordinator({ repository, provider: createMockProvider(async () => commitmentCandidates('The user agreed to send Matt the HVAC quote.')) });
  const registry = createToolRegistry();
  registerMemoryTools(registry, { memory });

  const result = await registry.execute('remember_this', { text: 'remember that I need to send Matt the HVAC quote' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.stored, true);
  assert.equal(repository.exportAll().length, 1);
});

test('recall_memories tool returns a bounded, structured list — not raw internals', async () => {
  const repository = createInMemoryRepository();
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'send_quote', object: {}, summary: 'The user agreed to send Matt the HVAC quote.', confidence: 0.9, importance: 0.8, tags: ['matt'], source: { evidenceType: 'user_stated' } });
  const memory = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const registry = createToolRegistry();
  registerMemoryTools(registry, { memory });

  const result = await registry.execute('recall_memories', { query: 'Matt quote' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.memories.length, 1);
  assert.equal(result.result.memories[0].summary, 'The user agreed to send Matt the HVAC quote.');
});

test('forget_memory tool returns candidates instead of deleting when ambiguous', async () => {
  const repository = createInMemoryRepository();
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'a', object: {}, summary: 'Send Matt the roofing quote.', confidence: 0.8, importance: 0.6, tags: ['matt'], source: { evidenceType: 'user_stated' } });
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'b', object: {}, summary: 'Send Matt the HVAC quote.', confidence: 0.8, importance: 0.6, tags: ['matt'], source: { evidenceType: 'user_stated' } });
  const memory = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const registry = createToolRegistry();
  registerMemoryTools(registry, { memory });

  const result = await registry.execute('forget_memory', { query: 'Matt quote' }, {});
  assert.equal(result.result.outcome, 'ambiguous');
  assert.equal(repository.exportAll().length, 2);
});

test('an unknown tool name (e.g. a typo) fails safely through the shared registry, memory tools included', async () => {
  const registry = createToolRegistry();
  registerMemoryTools(registry, { memory: createMemoryCoordinator({ repository: createInMemoryRepository(), provider: createMockProvider(async () => ({ candidates: [] })) }) });
  const result = await registry.execute('remembr_this', { text: 'x' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('end-to-end: the model calls remember_this via a normal tool_call decision, then responds — no schema changes needed', async () => {
  const repository = createInMemoryRepository();
  const memory = createMemoryCoordinator({ repository, provider: createMockProvider(async () => commitmentCandidates('The user agreed to send Matt the Building 5 HVAC quote.')) });
  const tools = createToolRegistry();
  registerMemoryTools(tools, { memory });

  let calls = 0;
  const agentProvider = createMockProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return { decision: 'tool_call', response: null, reason_summary: 'user asked to remember something', task_update: null, tool_calls: [{ name: 'remember_this', arguments: { text: 'I need to send Matt the Building 5 HVAC quote' } }], visual_analysis_request: null, scene_revision_used: null };
    }
    return { decision: 'respond', response: "Got it, I'll remember that.", reason_summary: 'confirmed', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
  });
  const runtime = createAgentRuntime({ provider: agentProvider, tools });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Remember that I need to send Matt the Building 5 HVAC quote', startedAt: 0.1, endedAt: 0.4 });

  assert.ok(events.some((e) => e.type === 'tool-completed' && e.name === 'remember_this' && e.ok));
  assert.ok(events.some((e) => e.type === 'response' && /remember/i.test(e.text)));
  assert.equal(repository.exportAll().length, 1);
});

test('when remember_this already ran this turn, the automatic write boundary does not ALSO extract (no redundant/racing second model call)', async () => {
  const repository = createInMemoryRepository();
  let extractionCalls = 0;
  const extractionProvider = createMockProvider(async () => { extractionCalls += 1; return commitmentCandidates('The user agreed to send Matt the Building 5 HVAC quote.'); });
  const memory = createMemoryCoordinator({ repository, provider: extractionProvider });
  const tools = createToolRegistry();
  registerMemoryTools(tools, { memory });

  let calls = 0;
  const agentProvider = createMockProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return { decision: 'tool_call', response: null, reason_summary: 'remember request', task_update: null, tool_calls: [{ name: 'remember_this', arguments: { text: 'I need to send Matt the Building 5 HVAC quote' } }], visual_analysis_request: null, scene_revision_used: null };
    }
    return { decision: 'respond', response: "Got it, I'll remember that.", reason_summary: 'confirmed', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
  });
  // Both the tool AND the automatic write boundary are wired to the SAME memory coordinator.
  const runtime = createAgentRuntime({ provider: agentProvider, tools, memory });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Remember that I need to send Matt the Building 5 HVAC quote', startedAt: 0.1, endedAt: 0.4 });
  await runtime.pendingMemoryWrite();

  assert.equal(extractionCalls, 1); // only remember_this's own extraction ran — no duplicate automatic write
  assert.equal(repository.exportAll().length, 1);
});
