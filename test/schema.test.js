import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision, validateTaskUpdate, DECISIONS } from '../src/agent/schema.js';

test('accepts a well-formed ignore decision', () => {
  const { ok, decision, errors } = validateDecision({
    decision: 'ignore', response: null, reason_summary: 'Ambient chat between others.',
    task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: 12,
  });
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
  assert.equal(decision.decision, 'ignore');
  assert.equal(decision.response, null);
});

test('respond and clarify require a non-empty response string', () => {
  const missing = validateDecision({
    decision: 'respond', response: null, reason_summary: 'x', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: 1,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /response is required/);

  const ok = validateDecision({
    decision: 'clarify', response: 'Which one?', reason_summary: 'ambiguous target', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: 1,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.response, 'Which one?');
});

test('rejects an unknown decision enum value', () => {
  const { ok, errors } = validateDecision({
    decision: 'do_something_else', response: null, reason_summary: '', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: null,
  });
  assert.equal(ok, false);
  assert.match(errors.join(), new RegExp(DECISIONS[0]));
});

test('tool_call requires at least one entry in tool_calls', () => {
  const { ok, errors } = validateDecision({
    decision: 'tool_call', response: null, reason_summary: 'need a tool', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: null,
  });
  assert.equal(ok, false);
  assert.match(errors.join(), /at least one entry/);
});

test('inspect_vision requires a visual_analysis_request with a question', () => {
  const missing = validateDecision({
    decision: 'inspect_vision', response: null, reason_summary: 'unsure', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: null,
  });
  assert.equal(missing.ok, false);

  const ok = validateDecision({
    decision: 'inspect_vision', response: null, reason_summary: 'unsure', task_update: null,
    tool_calls: [], visual_analysis_request: { question: 'Which tool is the wrench?', timestampMs: null }, scene_revision_used: 4,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.visualAnalysisRequest.question, 'Which tool is the wrench?');
});

test('rejects non-object payloads and garbage without throwing', () => {
  assert.equal(validateDecision(null).ok, false);
  assert.equal(validateDecision('ignore').ok, false);
  assert.equal(validateDecision([1, 2, 3]).ok, false);
  assert.doesNotThrow(() => validateDecision(undefined));
});

test('task_update is bounded: required fields, entity count, and string length caps', () => {
  const missingFields = validateTaskUpdate({ active: true });
  assert.equal(missingFields.ok, false);

  const tooManyEntities = validateTaskUpdate({
    active: true, taskId: 't1', goal: 'find the wrench', status: 'locating',
    entities: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 'v'])),
  });
  assert.equal(tooManyEntities.ok, false);

  const longGoal = validateTaskUpdate({
    active: true, taskId: 't1', goal: 'x'.repeat(500), status: 'locating', entities: { tool: 'wrench' },
  });
  assert.equal(longGoal.ok, true);
  assert.ok(longGoal.value.goal.length <= 200);

  assert.deepEqual(validateTaskUpdate(null), { ok: true, value: null, errors: [] });
});

test('strict-mode wire format: {name, value} pair arrays convert to object maps', () => {
  const { ok, decision } = validateDecision({
    decision: 'tool_call', response: null, reason_summary: 'wire format',
    task_update: {
      active: true, taskId: 't1', goal: 'find wrench', status: 'locating',
      entities: [{ name: 'requestedObject', value: 'adjustable wrench' }],
    },
    tool_calls: [{ name: 'inspect_view_at_time', arguments: [{ name: 'question', value: 'what was that?' }, { name: 'timestampMs', value: 12345 }] }],
    visual_analysis_request: null, scene_revision_used: 3,
  });
  assert.equal(ok, true);
  assert.deepEqual(decision.taskUpdate.entities, { requestedObject: 'adjustable wrench' });
  assert.deepEqual(decision.toolCalls[0].arguments, { question: 'what was that?', timestampMs: 12345 });
});

test('caps oversized tool_calls arrays and truncates an overlong reason_summary', () => {
  const { ok, decision } = validateDecision({
    decision: 'tool_call', response: null, reason_summary: 'y'.repeat(1000), task_update: null,
    tool_calls: [
      { name: 'a', arguments: {} }, { name: 'b', arguments: {} },
      { name: 'c', arguments: {} }, { name: 'd', arguments: {} },
    ],
    visual_analysis_request: null, scene_revision_used: null,
  });
  assert.equal(ok, true);
  assert.ok(decision.toolCalls.length <= 3);
  assert.ok(decision.reasonSummary.length <= 300);
});
