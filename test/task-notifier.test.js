// Task notifier — Roma's deterministic decision about what the wearer HEARS
// from background work. The central guarantee: the server agent's progress
// does not become chatter in someone's ear, but anything blocking on the
// wearer reaches them promptly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskNotifier } from '../src/agent/taskNotifier.js';
import { registerServerTaskTools, formatPendingTasks, formatRegisteredProjects } from '../src/agent/serverTasks.js';
import { createToolRegistry } from '../src/agent/tools.js';

const task = (over = {}) => ({ taskId: 'task_1', title: 'review the module', goal: 'review the module', status: 'running', progress: [], pendingRequest: null, resultSummary: null, error: null, ...over });

test('a task starting and reporting progress never speaks', () => {
  const notifier = createTaskNotifier();
  assert.equal(notifier.evaluate(task({ status: 'queued' })), null);
  const first = notifier.evaluate(task({ progress: [{ message: 'Reading files' }] }));
  assert.equal(first.kind, 'visual', 'the wearer just asked for this work; narrating the start is noise');
  const second = notifier.evaluate(task({ progress: [{ message: 'Reading files' }, { message: 'Running tests' }] }));
  assert.equal(second.kind, 'visual');
});

test('an approval request is spoken immediately — the task is blocked on the wearer', () => {
  const notifier = createTaskNotifier();
  notifier.evaluate(task());
  const decision = notifier.evaluate(task({ status: 'awaiting_approval', pendingRequest: { text: 'May I apply the migration?' } }));
  assert.equal(decision.kind, 'speak_now');
  assert.equal(decision.reasonCode, 'approval_required');
  assert.match(decision.text, /May I apply the migration\?/);
  assert.equal(decision.sourceType, 'task_update');
});

test('a question from the worker is spoken too', () => {
  const notifier = createTaskNotifier();
  notifier.evaluate(task());
  const decision = notifier.evaluate(task({ status: 'awaiting_input', pendingRequest: { text: 'Which database should I use?' } }));
  assert.equal(decision.kind, 'speak_now');
  assert.equal(decision.reasonCode, 'input_required');
});

test('completion is announced once, when convenient — never twice', () => {
  const notifier = createTaskNotifier();
  notifier.evaluate(task());
  const first = notifier.evaluate(task({ status: 'completed', resultSummary: 'All 12 tests pass.' }));
  assert.equal(first.kind, 'speak_when_convenient');
  assert.match(first.text, /All 12 tests pass/);
  const again = notifier.evaluate(task({ status: 'completed', resultSummary: 'All 12 tests pass.' }));
  assert.equal(again, null, 'a completed task must not be announced repeatedly');
});

test('failure is announced with the reason, not hidden', () => {
  const notifier = createTaskNotifier();
  notifier.evaluate(task());
  const decision = notifier.evaluate(task({ status: 'failed', error: 'Build failed: unresolved import.' }));
  assert.equal(decision.kind, 'speak_when_convenient');
  assert.match(decision.text, /failed/i);
  assert.match(decision.text, /unresolved import/);
});

test('a cancellation the wearer asked for is not announced back to them', () => {
  const notifier = createTaskNotifier();
  notifier.evaluate(task());
  const decision = notifier.evaluate(task({ status: 'cancelled' }));
  assert.equal(decision.kind, 'silent');
  assert.equal(decision.reasonCode, 'cancelled_by_wearer');
});

test('spoken progress milestones are rate-limited per task', () => {
  let clock = 1_000_000;
  const notifier = createTaskNotifier({ milestoneIntervalMs: 60_000, now: () => clock });
  notifier.evaluate(task());
  // An approval makes the notifier speak, setting the quiet interval.
  notifier.evaluate(task({ status: 'awaiting_approval', pendingRequest: { text: 'ok?' } }));
  const soon = notifier.evaluate(task({ status: 'running', progress: [{ message: 'step 1' }] }));
  assert.equal(soon.kind, 'visual', 'progress right after speaking stays quiet');
  assert.equal(soon.reasonCode, 'progress_within_quiet_interval');

  clock += 120_000;
  const later = notifier.evaluate(task({ status: 'running', progress: [{ message: 'step 1' }, { message: 'step 2' }] }));
  assert.equal(later.kind, 'speak_when_convenient', 'a genuine milestone after the interval may be spoken');
  assert.equal(later.reasonCode, 'progress_milestone');
});

test('evaluateAll handles a batch and drops non-events', () => {
  const notifier = createTaskNotifier();
  const decisions = notifier.evaluateAll([
    task({ taskId: 'a', status: 'queued' }),
    task({ taskId: 'b', status: 'awaiting_approval', pendingRequest: { text: 'go ahead?' } }),
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].taskId, 'b');
});

// ── pending-task context + tools ────────────────────────────────────────────

test('only tasks blocked on the wearer enter the prompt context', () => {
  assert.equal(formatPendingTasks([task({ status: 'running' })]), '');
  const block = formatPendingTasks([
    task({ taskId: 'task_9', status: 'awaiting_approval', pendingRequest: { text: 'Apply the migration?' } }),
    task({ taskId: 'task_8', status: 'running' }),
  ]);
  assert.match(block, /task_9/);
  assert.match(block, /Apply the migration\?/);
  assert.ok(!block.includes('task_8'), 'work that is not waiting is not mentioned');
});

test('Roma is told which projects the background agent can work in', () => {
  // Without this block she has no evidence any codebase is reachable. Asked to
  // look at "the roma project" in a live run she replied "I don't have access
  // to the source code" and never dispatched — true of herself, wrong overall.
  assert.equal(formatRegisteredProjects([]), '', 'nothing registered means no block at all');
  const block = formatRegisteredProjects([
    { name: 'roma', rootPath: 'C:/repos/roma', defaultTestCmd: 'npm test' },
    { name: 'widgets', rootPath: 'C:/repos/widgets', defaultTestCmd: null },
  ]);
  assert.match(block, /roma/);
  assert.match(block, /npm test/);
  assert.match(block, /widgets/);
  // Filesystem paths are the worker's business, not the conversational model's.
  assert.ok(!block.includes('C:/repos'), 'root paths never enter the prompt');
});

test('the dispatch tool tells the model it cannot read files itself', () => {
  const registry = createToolRegistry();
  registerServerTaskTools(registry, { tasks: { dispatch: async () => ({ ok: true, task: {} }), status: async () => ({}), respond: async () => ({}), cancel: async () => ({}) } });
  const description = registry.descriptions().find((tool) => tool.name === 'dispatch_server_task').description;
  assert.match(description, /cannot read files/i);
  assert.match(description, /what does this file do/i, 'small-sounding code questions must route here too');
});

test('the dispatch tool reports that work STARTED, never that it finished', async () => {
  const registry = createToolRegistry();
  const calls = [];
  registerServerTaskTools(registry, { tasks: {
    dispatch: async (args) => { calls.push(args); return { ok: true, task: { taskId: 'task_1', status: 'queued' } }; },
    status: async () => ({ ok: true, tasks: [] }),
    respond: async () => ({ ok: true, task: { status: 'running' } }),
    cancel: async () => ({ ok: true, task: { status: 'cancelled' } }),
  } });

  const result = await registry.execute('dispatch_server_task', { goal: 'run the tests', project: 'roma' });
  assert.equal(result.ok, true);
  assert.equal(result.result.taskId, 'task_1');
  assert.match(result.result.note, /background/i);
  assert.ok(!/finished|completed|done/i.test(result.result.note), 'dispatch must not imply the work is done');
  assert.equal(calls[0].mode, 'readonly', 'readonly unless explicitly asked otherwise');
});

test('write mode is only used when explicitly requested', async () => {
  const registry = createToolRegistry();
  const calls = [];
  registerServerTaskTools(registry, { tasks: { dispatch: async (args) => { calls.push(args); return { ok: true, task: { taskId: 't', status: 'queued' } }; }, status: async () => ({ ok: true, tasks: [] }), respond: async () => ({ ok: true }), cancel: async () => ({ ok: true }) } });
  await registry.execute('dispatch_server_task', { goal: 'fix it', mode: 'write' });
  await registry.execute('dispatch_server_task', { goal: 'look at it', mode: 'nonsense' });
  assert.equal(calls[0].mode, 'write');
  assert.equal(calls[1].mode, 'readonly', 'an unrecognized mode falls back to readonly, never to write');
});

test('approval and refusal both reach the dispatcher through the tool', async () => {
  const registry = createToolRegistry();
  const calls = [];
  registerServerTaskTools(registry, { tasks: { dispatch: async () => ({ ok: true, task: {} }), status: async () => ({ ok: true, tasks: [] }), respond: async (args) => { calls.push(args); return { ok: true, task: { status: args.approved ? 'running' : 'cancelled' } }; }, cancel: async () => ({ ok: true }) } });

  await registry.execute('answer_task_question', { task_id: 't1', approve: true });
  await registry.execute('answer_task_question', { task_id: 't1', approve: false });
  assert.equal(calls[0].approved, true);
  assert.equal(calls[1].approved, false);
});

test('task tools fail safely when the server agent is unavailable', async () => {
  const registry = createToolRegistry();
  registerServerTaskTools(registry, { tasks: null });
  const result = await registry.execute('dispatch_server_task', { goal: 'do something' });
  assert.equal(result.result.ok, false);
  assert.match(result.result.note, /not available/i);
});
