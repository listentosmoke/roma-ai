// Server agent environment: engineering memory, task store, dispatcher, and
// the authenticated task API. The mock worker makes every behavior here
// deterministic — dispatch, approval, cancellation, restart honesty, and
// tenant isolation are verified without depending on a real coding agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../server/db/index.mjs';
import { createTaskStore } from '../server/agentEnv/taskStore.mjs';
import { createEngineeringMemory, formatEngineeringContext } from '../server/agentEnv/engineeringMemory.mjs';
import { createDispatcher } from '../server/agentEnv/dispatcher.mjs';
import { createMockWorker, APPROVAL_SCRIPT, FAILURE_SCRIPT, SLOW_SCRIPT } from '../server/agentEnv/workers/mock.mjs';
import { normalizeWorkerEvent, buildTaskBrief } from '../server/agentEnv/workers/adapter.mjs';
import { createDataApi, selectWorker, isTestContext } from '../server/dataApiPlugin.mjs';
import { attachAgentTaskApi } from '../server/routes/agentTasks.mjs';

const PRINCIPAL = { workspaceId: 'ws_1', userId: 'user_1' };

function fixture({ script } = {}) {
  const db = openDatabase({ memory: true });
  const taskStore = createTaskStore({ db });
  const engineeringMemory = createEngineeringMemory({ db });
  const worker = createMockWorker(script ? { script } : {});
  const dispatcher = createDispatcher({ taskStore, engineeringMemory, worker, timeoutMs: 5000 });
  return { db, taskStore, engineeringMemory, dispatcher, tasks: taskStore.forWorkspace(PRINCIPAL.workspaceId, PRINCIPAL.userId), memory: engineeringMemory.forWorkspace(PRINCIPAL.workspaceId, PRINCIPAL.userId) };
}

/** Wait for the dispatcher queue to drain — only valid when the task can actually finish. */
async function settle(dispatcher, ms = 200) {
  await dispatcher.drain();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait WITHOUT draining. A task paused for approval never completes on its
 * own, so awaiting drain() there would block forever (it did, on the first
 * run of this suite).
 */
async function pause(ms = 150) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── worker selection ────────────────────────────────────────────────────────

test('a test run NEVER selects a real worker, whatever .env asks for', () => {
  // This is a regression test with a receipt: setting AGENT_WORKER=qwen in a
  // developer's .env once turned `npm test` into a run that spawned five real
  // Qwen CLI processes and spent real tokens before it was killed.
  assert.equal(isTestContext(), true, 'the suite must be able to recognize itself as a test run');
  const silent = { warn: () => {} };
  for (const requested of ['qwen', 'anything-else']) {
    const worker = selectWorker({ env: { AGENT_WORKER: requested, AGENT_WORKER_API_KEY: 'k' }, log: silent });
    assert.equal(worker.name, 'mock', `AGENT_WORKER=${requested} must still be the mock under test`);
    assert.equal(worker.describe().real, false);
  }
});

test('outside a test run the requested engine is honoured, and an unknown one falls back to mock', () => {
  const silent = { warn: () => {} };
  const real = selectWorker({ env: { AGENT_WORKER: 'qwen' }, log: silent, testContext: false });
  assert.equal(real.name, 'qwen');
  assert.equal(real.describe().real, true);
  // Credential state is reported, never the value.
  assert.equal(real.describe().credential, 'missing');
  assert.equal(JSON.stringify(real.describe()).includes('AGENT_WORKER_API_KEY'), false);

  assert.equal(selectWorker({ env: { AGENT_WORKER: 'nonsense' }, log: silent, testContext: false }).name, 'mock');
  assert.equal(selectWorker({ env: {}, log: silent, testContext: false }).name, 'mock', 'the default must be the mock');
});

test('the data API built in a test run carries the mock worker', () => {
  const api = createDataApi({ dbPath: ':memory:', log: { warn: () => {} } });
  assert.equal(api.dispatcher.describeWorker().real, false);
  api.db.close();
});

// ── engineering memory ──────────────────────────────────────────────────────

test('engineering memory is separate from personal memory and stores codebase knowledge', () => {
  const f = fixture();
  const project = f.memory.createProject({ name: 'roma', rootPath: 'C:/repos/roma', defaultTestCmd: 'node --test' }).project;
  f.memory.remember({ projectId: project.projectId, kind: 'failed_approach', title: 'Nested turn_analysis', body: 'A nested object destabilized constrained decoding; flatten instead.' });
  f.memory.remember({ projectId: project.projectId, kind: 'commands', title: 'Test command', body: 'node --test test/*.test.js' });

  const counts = f.memory.counts();
  assert.equal(counts.total, 2);
  assert.equal(counts.byKind.failed_approach, 1);
  // The personal-memory table is untouched by any of this.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  f.db.close();
});

test('an invalid engineering-memory kind is rejected', () => {
  const f = fixture();
  assert.equal(f.memory.remember({ kind: 'gossip', title: 'x', body: 'y' }).ok, false);
  f.db.close();
});

test('brief retrieval ranks relevant notes and favours failed approaches and known bugs', () => {
  const f = fixture();
  const project = f.memory.createProject({ name: 'roma', rootPath: '/repo' }).project;
  f.memory.remember({ projectId: project.projectId, kind: 'failed_approach', title: 'schema flattening', body: 'nested schema objects break constrained decoding' });
  f.memory.remember({ projectId: project.projectId, kind: 'deployment', title: 'unrelated note', body: 'the favicon is green' });

  const retrieved = f.memory.retrieveForBrief({ goal: 'fix the schema decoding problem', projectId: project.projectId });
  assert.ok(retrieved.length >= 1);
  assert.equal(retrieved[0].kind, 'failed_approach');
  assert.ok(!formatEngineeringContext(retrieved).includes('favicon'), 'irrelevant notes stay out of the brief');
  f.db.close();
});

// ── worker contract ─────────────────────────────────────────────────────────

test('unknown worker event types are dropped, and payloads are bounded', () => {
  assert.equal(normalizeWorkerEvent({ type: 'speak', message: 'say this out loud' }), null, 'a worker cannot invent a way to reach the wearer');
  assert.equal(normalizeWorkerEvent({ type: 'progress', message: 'x'.repeat(1000) }).message.length, 300);
  const result = normalizeWorkerEvent({ type: 'result', summary: 'done', learnings: Array.from({ length: 50 }, () => ({ kind: 'fix', title: 't', body: 'b' })) });
  assert.equal(result.learnings.length, 10, 'learnings are capped');
});

test('a task brief carries engineering context and never personal data or credentials', () => {
  const brief = buildTaskBrief({ goal: 'run the tests', project: { name: 'roma', rootPath: '/repo', defaultTestCmd: 'node --test' }, engineeringContext: '- [commands] Test: node --test', mode: 'readonly' });
  assert.match(brief, /run the tests/);
  assert.match(brief, /readonly/);
  assert.match(brief, /node --test/);
  assert.doesNotMatch(brief, /API_KEY|password|wearer said|transcript/i);
});

// ── dispatch lifecycle ──────────────────────────────────────────────────────

test('a dispatched task runs, records bounded progress, completes, and harvests learnings', async () => {
  const f = fixture();
  const project = f.memory.createProject({ name: 'roma', rootPath: '/repo' }).project;
  const task = f.tasks.create({ goal: 'review the module', projectId: project.projectId }).task;
  assert.equal(task.status, 'queued');

  f.dispatcher.dispatch(PRINCIPAL, { taskId: task.taskId });
  await settle(f.dispatcher);

  const finished = f.tasks.get(task.taskId);
  assert.equal(finished.status, 'completed');
  assert.match(finished.resultSummary, /no failing tests/i);
  assert.ok(finished.progress.length >= 2 && finished.progress.length <= 50, 'progress is recorded and bounded');
  assert.equal(f.memory.counts().byKind.codebase, 1, 'worker learnings become engineering memory');
  f.db.close();
});

test('a write-mode step waits for the wearer: approval resumes it, refusal cancels without changes', async () => {
  const approved = fixture({ script: APPROVAL_SCRIPT });
  const t1 = approved.tasks.create({ goal: 'apply the migration', mode: 'write' }).task;
  approved.dispatcher.dispatch(PRINCIPAL, { taskId: t1.taskId });
  await pause(200);
  assert.equal(approved.tasks.get(t1.taskId).status, 'awaiting_approval');
  assert.match(approved.tasks.get(t1.taskId).pendingRequest.text, /migration/i);

  approved.dispatcher.respond(PRINCIPAL, { taskId: t1.taskId, approved: true });
  await settle(approved.dispatcher);
  assert.equal(approved.tasks.get(t1.taskId).status, 'completed');
  approved.db.close();

  const refused = fixture({ script: APPROVAL_SCRIPT });
  const t2 = refused.tasks.create({ goal: 'apply the migration', mode: 'write' }).task;
  refused.dispatcher.dispatch(PRINCIPAL, { taskId: t2.taskId });
  await pause(200);
  refused.dispatcher.respond(PRINCIPAL, { taskId: t2.taskId, approved: false });
  await settle(refused.dispatcher);
  const final = refused.tasks.get(t2.taskId);
  assert.equal(final.status, 'cancelled');
  assert.match(final.error, /did not approve/i);
  refused.db.close();
});

test('a failing worker surfaces the failure visibly and never reports success', async () => {
  const f = fixture({ script: FAILURE_SCRIPT });
  const task = f.tasks.create({ goal: 'build it' }).task;
  f.dispatcher.dispatch(PRINCIPAL, { taskId: task.taskId });
  await settle(f.dispatcher);
  const finished = f.tasks.get(task.taskId);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /Build failed/);
  assert.equal(finished.resultSummary, null);
  f.db.close();
});

test('cancellation stops a running task immediately', async () => {
  const f = fixture({ script: SLOW_SCRIPT });
  const task = f.tasks.create({ goal: 'long job' }).task;
  f.dispatcher.dispatch(PRINCIPAL, { taskId: task.taskId });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const result = f.dispatcher.cancel(PRINCIPAL, { taskId: task.taskId });
  assert.equal(result.ok, true);
  assert.equal(f.tasks.get(task.taskId).status, 'cancelled');
  f.db.close();
});

test('a terminal task cannot be revived by a late event, and stale versions are rejected', async () => {
  const f = fixture();
  const task = f.tasks.create({ goal: 'quick job' }).task;
  f.dispatcher.dispatch(PRINCIPAL, { taskId: task.taskId });
  await settle(f.dispatcher);
  const done = f.tasks.get(task.taskId);
  assert.equal(done.status, 'completed');

  assert.equal(f.tasks.update(task.taskId, { status: 'running' }).reasonCode, 'already_terminal');
  assert.equal(f.tasks.update(task.taskId, { resultSummary: 'x' }, done.version - 1).reasonCode, 'stale_version');
  f.db.close();
});

test('tasks in flight when the server restarts are marked failed, never left looking alive', () => {
  const f = fixture();
  const task = f.tasks.create({ goal: 'interrupted work' }).task;
  f.tasks.update(task.taskId, { status: 'running' });
  const swept = f.taskStore.failInterruptedEverywhere();
  assert.equal(swept, 1);
  const after = f.tasks.get(task.taskId);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /restart/i);
  f.db.close();
});

test('progress is ring-buffered, never an unbounded worker transcript', () => {
  const f = fixture();
  const task = f.tasks.create({ goal: 'chatty job' }).task;
  for (let i = 0; i < 120; i += 1) f.tasks.appendProgress(task.taskId, { message: `step ${i}` });
  const progress = f.tasks.get(task.taskId).progress;
  assert.equal(progress.length, 50);
  assert.match(progress.at(-1).message, /step 119/);
  f.db.close();
});

// ── HTTP surface ────────────────────────────────────────────────────────────

async function startServer() {
  const api = createDataApi({ dbPath: ':memory:', log: { warn: () => {} } });
  const middlewares = { fns: [], use(fn) { this.fns.push(fn); } };
  attachAgentTaskApi(middlewares, api.agentTaskHandlers);
  const server = http.createServer((req, res) => {
    let i = 0;
    function next() { const fn = middlewares.fns[i++]; if (fn) fn(req, res, next); else { res.statusCode = 404; res.end('{}'); } }
    next();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    api,
    close: () => new Promise((resolve) => { server.close(resolve); api.db.close(); }),
    call: async (method, path, body, headers = {}) => {
      const res = await fetch(`http://localhost:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    },
  };
}

test('the task API dispatches, reports status, and is tenant-scoped', async () => {
  const s = await startServer();
  await s.call('POST', '/api/agent-projects', { name: 'roma', rootPath: '/repo' });
  const created = await s.call('POST', '/api/agent-tasks', { goal: 'review the module', project: 'roma' });
  assert.equal(created.status, 201);
  const taskId = created.json.task.taskId;

  await s.api.dispatcher.drain();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const fetched = await s.call('GET', `/api/agent-tasks/${taskId}`);
  assert.equal(fetched.json.task.status, 'completed');

  // Another tenant can neither see nor address the task.
  const other = await s.call('GET', `/api/agent-tasks/${taskId}`, null, { 'X-Roma-Dev-Workspace': 'intruder_ws', 'X-Roma-Dev-User': 'intruder' });
  assert.equal(other.status, 404);
  const otherList = await s.call('GET', '/api/agent-tasks', null, { 'X-Roma-Dev-Workspace': 'intruder_ws', 'X-Roma-Dev-User': 'intruder' });
  assert.equal(otherList.json.tasks.length, 0);
  await s.close();
});

test('a task naming an unregistered project is refused — a worker never gets an invented location', async () => {
  const s = await startServer();
  const created = await s.call('POST', '/api/agent-tasks', { goal: 'do something', project: 'not-registered' });
  assert.equal(created.status, 400);
  assert.equal(created.json.code, 'unknown_project');
  await s.close();
});

test('the worker engine identifies itself honestly as a mock', async () => {
  const s = await startServer();
  const health = await s.call('GET', '/api/agent-tasks/health');
  assert.equal(health.json.worker.real, false);
  assert.equal(health.json.worker.engine, 'mock');
  await s.close();
});
