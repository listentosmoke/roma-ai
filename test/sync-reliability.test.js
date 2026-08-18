// Browser/server synchronization reliability — the stabilization-phase
// mutation queue (src/server/mutationQueue.js) plus the server-side
// idempotency/tombstone hardening in server/routes/dataApi.mjs.
//
// Part A drives the queue with a fully deterministic fake client/clock/
// scheduler/storage. Part B exercises the REAL http route handlers (same
// harness as test/server-api-integration.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createMutationQueue, MutationQueueError } from '../src/server/mutationQueue.js';
import { DataApiError } from '../src/server/dataClient.js';
import { createUnavailableMemoryRepository } from '../src/server/remoteMemoryRepository.js';
import { createDataApi } from '../server/dataApiPlugin.mjs';
import { attachDataApi } from '../server/routes/dataApi.mjs';

// ── deterministic helpers ────────────────────────────────────────────────────

function createHarness({ handler, queueOptions = {} } = {}) {
  const calls = [];
  let currentNow = 1_000_000;
  const scheduled = [];
  const respond = handler ?? (async () => ({ ok: true }));
  const dataClient = {
    get: async () => ({}),
    post: (path, body, options) => { calls.push({ method: 'post', path, body, options }); return respond('post', path, body, options); },
    patch: (path, body, options) => { calls.push({ method: 'patch', path, body, options }); return respond('patch', path, body, options); },
    del: (path, options) => { calls.push({ method: 'del', path, body: null, options }); return respond('del', path, null, options); },
  };
  const storage = new Map();
  const storageAdapter = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const queue = createMutationQueue({
    dataClient,
    storage: storageAdapter,
    now: () => currentNow,
    schedule: (fn, ms) => { scheduled.push({ fn, at: currentNow + ms }); },
    random: () => 0.5, // deterministic jitter
    ...queueOptions,
  });
  return {
    queue, calls, storage, storageAdapter, dataClient,
    advance(ms) { currentNow += ms; const due = scheduled.splice(0); for (const item of due) item.fn(); },
    now: () => currentNow,
  };
}

function memoryMutation(overrides = {}) {
  return {
    kind: 'create', method: 'post', path: '/api/data/memory',
    body: { memoryId: 'mem_q1', summary: 'send Matt the quote' },
    entityType: 'memory', entityId: 'mem_q1', sensitivity: 'normal',
    ...overrides,
  };
}

// ── Part A: mutation queue ──────────────────────────────────────────────────

test('a mutation stays pending until the server acknowledges it, then becomes acknowledged', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ handler: async () => { await gate; return { ok: true }; } });
  const op = h.queue.submit(memoryMutation());
  assert.equal(op.status, 'pending');
  assert.equal(h.queue.status().pending, 1);
  assert.equal(h.queue.status().acknowledged, 0);
  release({});
  await h.queue.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.queue.status().pending, 0);
  assert.equal(h.queue.status().acknowledged, 1);
});

test('a transient failure retries with the SAME operation ID and bounded backoff', async () => {
  let failures = 1;
  const h = createHarness({
    handler: async () => {
      if (failures > 0) { failures -= 1; throw new DataApiError('unavailable', { status: 503 }); }
      return { ok: true };
    },
  });
  h.queue.submit(memoryMutation());
  await h.queue.flush();
  const [retrying] = h.queue.list({ statuses: ['retrying'] });
  assert.ok(retrying, 'expected a retrying op after a 503');
  assert.equal(retrying.reasonCode, 'http_503');
  assert.ok(retrying.nextAttemptAt > h.now(), 'backoff scheduled in the future');
  h.advance(60_000);
  await h.queue.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.queue.status().acknowledged, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.operationId, h.calls[1].options.operationId, 'retry reuses the stable operation ID');
});

test('retry count is bounded — permanent visible failure after maxAttempts', async () => {
  const h = createHarness({
    handler: async () => { throw new DataApiError('down', { status: 503 }); },
    queueOptions: { maxAttempts: 3 },
  });
  h.queue.submit(memoryMutation());
  await h.queue.flush();
  for (let i = 0; i < 5; i += 1) { h.advance(120_000); await h.queue.flush(); } // more wakeups than attempts
  const [failed] = h.queue.list({ statuses: ['failed'] });
  assert.ok(failed, 'op should end failed');
  assert.equal(failed.reasonCode, 'max_retries_exhausted');
  assert.equal(failed.attempts, 3);
  assert.equal(h.calls.length, 3);
});

test('backoff is bounded by maxBackoffMs', async () => {
  const h = createHarness({
    handler: async () => { throw new DataApiError('down', { status: 503 }); },
    queueOptions: { maxAttempts: 10, baseBackoffMs: 1000, maxBackoffMs: 4000 },
  });
  h.queue.submit(memoryMutation());
  await h.queue.flush();
  for (let i = 0; i < 6; i += 1) {
    const [retrying] = h.queue.list({ statuses: ['retrying'] });
    if (!retrying) break;
    assert.ok(retrying.nextAttemptAt - h.now() <= 4000, `backoff ${retrying.nextAttemptAt - h.now()}ms exceeds the 4000ms cap`);
    h.advance(10_000);
    await h.queue.flush();
  }
});

test('a permanent (4xx) failure is immediately visible as failed with the server reason code', async () => {
  const h = createHarness({ handler: async () => { throw new DataApiError('bad', { status: 400, code: 'validation_failed' }); } });
  h.queue.submit(memoryMutation());
  await h.queue.flush();
  const [failed] = h.queue.list({ statuses: ['failed'] });
  assert.equal(failed.reasonCode, 'validation_failed');
  assert.equal(h.calls.length, 1, 'permanent failures are not retried');
});

test('a 409 conflict becomes conflicted with a deterministic reason code', async () => {
  const h = createHarness({ handler: async () => { throw new DataApiError('gone', { status: 409, code: 'record_deleted' }); } });
  h.queue.submit(memoryMutation());
  await h.queue.flush();
  const [conflicted] = h.queue.list({ statuses: ['conflicted'] });
  assert.equal(conflicted.status, 'conflicted');
  assert.equal(conflicted.reasonCode, 'record_deleted');
});

test('strict FIFO: an earlier retrying mutation is delivered before a later correction, so the correction lands last', async () => {
  const delivered = [];
  let failFirst = true;
  const h = createHarness({
    handler: async (method, path, body) => {
      if (failFirst && body?.value === 'v1') { failFirst = false; throw new DataApiError('down', { status: 503 }); }
      delivered.push(body?.value);
      return { ok: true };
    },
  });
  h.queue.submit(memoryMutation({ kind: 'update', method: 'patch', path: '/api/data/memory/mem_q1', body: { value: 'v1' } }));
  h.queue.submit(memoryMutation({ kind: 'correct', path: '/api/data/memory/mem_q1/supersede', body: { value: 'v2-correction' } }));
  await h.queue.flush();
  // v1 failed transiently; v2 must NOT have jumped ahead of it
  assert.deepEqual(delivered, []);
  h.advance(60_000);
  await h.queue.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ['v1', 'v2-correction'], 'the correction is applied after (never before) the older retry');
});

test('submitting a delete cancels still-queued creates/updates for the same entity (no resurrection from the client)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ handler: async (method, path, body) => { if (body?.hold) await gate; return { ok: true }; } });
  h.queue.submit(memoryMutation({ body: { hold: true } })); // occupies the dispatch slot
  const create = h.queue.submit(memoryMutation({ entityId: 'mem_q2', body: { memoryId: 'mem_q2' } }));
  h.queue.submit(memoryMutation({ kind: 'delete', method: 'del', path: '/api/data/memory/mem_q2', body: null, entityId: 'mem_q2' }));
  const cancelled = h.queue.list({ statuses: ['cancelled'] });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].operationId, create.operationId);
  assert.equal(cancelled[0].reasonCode, 'superseded_by_delete');
  release({});
  await h.queue.flush();
});

test('consent revocation cancels every pending voice-profile mutation; profile deletion cancels by profile id', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ handler: async () => { await gate; return { ok: true }; } });
  h.queue.submit(memoryMutation()); // head op holds the queue
  h.queue.submit(memoryMutation({ kind: 'update', path: '/api/data/people/p1/voice-profile', body: { voiceProfileId: 'vp_1' }, entityType: 'voice_profile_ref', entityId: 'vp_1', category: 'voice_profile' }));
  h.queue.submit(memoryMutation({ kind: 'update', path: '/api/data/people/p1/voice-profile', body: { voiceProfileId: 'vp_2' }, entityType: 'voice_profile_ref', entityId: 'vp_2', category: 'voice_profile' }));

  // Profile deletion → only that profile's pending work is invalidated.
  const byProfile = h.queue.cancelWhere((op) => op.category === 'voice_profile' && op.entityId === 'vp_2', 'profile_deleted');
  assert.equal(byProfile, 1);
  // Consent revocation → every remaining voice-profile op is cancelled.
  const byConsent = h.queue.cancelWhere((op) => op.category === 'voice_profile', 'consent_revoked');
  assert.equal(byConsent, 1);
  const cancelled = h.queue.list({ statuses: ['cancelled'] });
  assert.deepEqual(cancelled.map((op) => op.reasonCode).sort(), ['consent_revoked', 'profile_deleted']);
  release({});
  await h.queue.flush();
});

test('an op cancelled while its request is in flight stays cancelled — a late result never resurrects it', async () => {
  // Regression: found live by scripts/simulate-recovery.mjs — consent
  // revocation cancelled a voice-profile op whose network attempt was still
  // in flight; the late network failure then flipped it back to retrying,
  // which would have replayed a revoked biometric-adjacent action.
  let reject;
  const gate = new Promise((_resolve, r) => { reject = r; });
  const h = createHarness({ handler: async () => { await gate; } });
  h.queue.submit(memoryMutation({ category: 'voice_profile', entityType: 'voice_profile_ref', entityId: 'vp_inflight' }));
  assert.equal(h.queue.cancelWhere((op) => op.category === 'voice_profile', 'consent_revoked'), 1);
  reject(new DataApiError('down', { status: 503 })); // the in-flight request now fails
  await h.queue.flush();
  await new Promise((resolve) => setImmediate(resolve));
  const [op] = h.queue.list({ statuses: ['cancelled'] });
  assert.ok(op, 'op must still be cancelled');
  assert.equal(op.reasonCode, 'consent_revoked');
  assert.equal(h.queue.status().retrying, 0);
  h.advance(600_000);
  await h.queue.flush();
  assert.equal(h.calls.length, 1, 'no further delivery attempts after cancellation');
});

test('biometric operations and template-shaped payloads can never enter the queue', () => {
  const h = createHarness();
  assert.throws(() => h.queue.submit(memoryMutation({ category: 'biometric' })), (e) => e instanceof MutationQueueError && e.code === 'biometric_operation_not_queueable');
  assert.throws(() => h.queue.submit(memoryMutation({ sensitivity: 'biometric' })), (e) => e.code === 'biometric_operation_not_queueable');
  assert.throws(() => h.queue.submit(memoryMutation({ body: { template: [0.1, 0.2] } })), (e) => e.code === 'biometric_payload_rejected');
  assert.throws(() => h.queue.submit(memoryMutation({ body: { nested: { embeddings: 'x' } } })), (e) => e.code === 'biometric_payload_rejected');
  assert.equal(h.queue.status().total, 0, 'nothing was queued');
});

test('queue size is bounded — overflow is a visible failure, not silent growth', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ handler: async () => { await gate; return { ok: true }; }, queueOptions: { maxQueue: 2 } });
  h.queue.submit(memoryMutation({ entityId: 'a', body: { memoryId: 'a' } }));
  h.queue.submit(memoryMutation({ entityId: 'b', body: { memoryId: 'b' } }));
  const overflow = h.queue.submit(memoryMutation({ entityId: 'c', body: { memoryId: 'c' } }));
  assert.equal(overflow.status, 'failed');
  assert.equal(overflow.reasonCode, 'queue_full');
  release({});
  await h.queue.flush();
});

test('sensitive payloads are never written to queue storage; normal payloads survive a "refresh"', async () => {
  const blockedForever = createHarness({ handler: async () => { throw new DataApiError('down', { status: 503 }); }, queueOptions: { maxAttempts: 99 } });
  blockedForever.queue.submit(memoryMutation({ body: { memoryId: 'mem_normal', summary: 'normal text' } }));
  blockedForever.queue.submit(memoryMutation({ entityId: 'mem_secretive', sensitivity: 'sensitive', body: { memoryId: 'mem_secretive', summary: 'private medical detail' } }));
  await blockedForever.queue.flush();

  const persisted = blockedForever.storage.get('roma.sync.queue');
  assert.ok(persisted.includes('normal text'), 'normal-sensitivity body is persisted for restart recovery');
  assert.ok(!persisted.includes('private medical detail'), 'sensitive body must NOT be written to queue storage');

  // "Browser refresh": a new queue over the same storage, with a healthy server.
  const revived = createMutationQueue({
    dataClient: { get: async () => ({}), post: async () => ({ ok: true }), patch: async () => ({ ok: true }), del: async () => ({ ok: true }) },
    storage: blockedForever.storageAdapter,
    now: Date.now,
    schedule: (fn) => setImmediate(fn),
  });
  await revived.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const acked = revived.list({ statuses: ['acknowledged'] });
  const failed = revived.list({ statuses: ['failed'] });
  assert.equal(acked.length, 1, 'the restored normal mutation was retried and acknowledged');
  assert.equal(failed.length, 1, 'the sensitive mutation is restored as a VISIBLE failure');
  assert.equal(failed[0].reasonCode, 'payload_not_restored');
});

test('the queue never exposes mutation bodies through list()/subscribe()', async () => {
  const events = [];
  const h = createHarness();
  h.queue.subscribe((event) => events.push(event));
  h.queue.submit(memoryMutation({ body: { memoryId: 'mem_view', summary: 'CONFIDENTIAL-MARKER' } }));
  await h.queue.flush();
  const listed = JSON.stringify(h.queue.list());
  const emitted = JSON.stringify(events);
  assert.ok(!listed.includes('CONFIDENTIAL-MARKER'));
  assert.ok(!emitted.includes('CONFIDENTIAL-MARKER'));
});

test('production without a reachable server fails closed — no localStorage authority, every mutation visibly refused', () => {
  const repo = createUnavailableMemoryRepository();
  const result = repo.create({ summary: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /unavailable/i);
  assert.equal(repo.unavailable, true);
});

// ── Part B: real server routes ──────────────────────────────────────────────

async function startServer({ dbPath = ':memory:' } = {}) {
  const api = createDataApi({ dbPath });
  const middlewares = { fns: [], use(fn) { this.fns.push(fn); } };
  attachDataApi(middlewares, api.handlers);
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

const validMemory = (id) => ({ memoryId: id, type: 'fact', subjectId: 'person_x', predicate: 'likes', summary: 'sync test record', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });

test('duplicate retries with one operation ID create exactly one server record (replay flagged)', async () => {
  const s = await startServer();
  const headers = { 'X-Roma-Operation-Id': 'op_dup_1' };
  const first = await s.call('POST', '/api/data/memory', validMemory('mem_dup'), headers);
  const second = await s.call('POST', '/api/data/memory', validMemory('mem_dup'), headers);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.json.replayedOperation, true);
  const list = await s.call('GET', '/api/data/memory');
  assert.equal(list.json.memories.length, 1);
  await s.close();
});

test('server restart retains acknowledged mutations and still replays their operation IDs (no duplicates)', async () => {
  const dbPath = join(tmpdir(), `roma-sync-restart-${process.pid}.db`);
  try {
    const s1 = await startServer({ dbPath });
    const created = await s1.call('POST', '/api/data/memory', validMemory('mem_restart'), { 'X-Roma-Operation-Id': 'op_restart_1' });
    assert.equal(created.status, 201);
    await s1.close();

    const s2 = await startServer({ dbPath });
    const list = await s2.call('GET', '/api/data/memory');
    assert.equal(list.json.memories.length, 1, 'acknowledged record survives a server restart');
    const replayed = await s2.call('POST', '/api/data/memory', validMemory('mem_restart'), { 'X-Roma-Operation-Id': 'op_restart_1' });
    assert.equal(replayed.json.replayedOperation, true, 'the ledger survives the restart too');
    const after = await s2.call('GET', '/api/data/memory');
    assert.equal(after.json.memories.length, 1, 'still exactly one record');
    await s2.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix); } catch { /* not created */ } }
  }
});

test('a delayed create cannot resurrect a deleted record (tombstone -> deterministic 409 record_deleted)', async () => {
  const s = await startServer();
  await s.call('POST', '/api/data/memory', validMemory('mem_lazarus'));
  const deleted = await s.call('DELETE', '/api/data/memory/mem_lazarus');
  assert.equal(deleted.json.ok, true);
  const resurrection = await s.call('POST', '/api/data/memory', validMemory('mem_lazarus'), { 'X-Roma-Operation-Id': 'op_late_create' });
  assert.equal(resurrection.status, 409);
  assert.equal(resurrection.json.code, 'record_deleted');
  const update = await s.call('PATCH', '/api/data/memory/mem_lazarus', { summary: 'late update' });
  assert.equal(update.status, 409);
  assert.equal(update.json.code, 'record_deleted');
  const list = await s.call('GET', '/api/data/memory');
  assert.equal(list.json.memories.length, 0);
  await s.close();
});

test('operation IDs are tenant-scoped — another workspace can neither replay nor clobber them', async () => {
  const s = await startServer();
  const headers = { 'X-Roma-Operation-Id': 'op_shared_id' };
  const tenantA = await s.call('POST', '/api/data/memory', validMemory('mem_tenant_a'), headers);
  assert.equal(tenantA.status, 201);

  // Same operationId presented by a DIFFERENT workspace: not a replay — it
  // executes fresh under that tenant and records its own ledger row.
  const tenantB = await s.call('POST', '/api/data/memory', validMemory('mem_tenant_b'), { ...headers, 'X-Roma-Dev-Workspace': 'other_workspace', 'X-Roma-Dev-User': 'other_user' });
  assert.equal(tenantB.status, 201);
  assert.notEqual(tenantB.json.replayedOperation, true, 'cross-tenant replay must not serve tenant A\'s cached result');

  // Tenant A's ledger entry was not clobbered: replaying under A still returns A's original record.
  const replayA = await s.call('POST', '/api/data/memory', validMemory('mem_tenant_a'), headers);
  assert.equal(replayA.json.replayedOperation, true);
  assert.equal(replayA.json.memory.memoryId, 'mem_tenant_a');

  const listA = await s.call('GET', '/api/data/memory');
  assert.deepEqual(listA.json.memories.map((m) => m.memoryId), ['mem_tenant_a']);
  await s.close();
});

test('replay after a correction returns the ORIGINAL recorded result — it does not re-execute over newer state', async () => {
  const s = await startServer();
  await s.call('POST', '/api/data/memory', validMemory('mem_correct_1'));
  // First update, recorded under an operation ID.
  const firstUpdate = await s.call('PATCH', '/api/data/memory/mem_correct_1', { summary: 'version one' }, { 'X-Roma-Operation-Id': 'op_v1_update' });
  assert.equal(firstUpdate.status, 200);
  // A newer correction lands.
  const correction = await s.call('PATCH', '/api/data/memory/mem_correct_1', { summary: 'version two — corrected' });
  assert.equal(correction.status, 200);
  // The old update's retry arrives late: replayed from the ledger, NOT re-executed.
  const lateRetry = await s.call('PATCH', '/api/data/memory/mem_correct_1', { summary: 'version one' }, { 'X-Roma-Operation-Id': 'op_v1_update' });
  assert.equal(lateRetry.json.replayedOperation, true);
  const current = await s.call('GET', '/api/data/memory/mem_correct_1');
  assert.equal(current.json.memory.summary, 'version two — corrected', 'the correction remains authoritative');
  await s.close();
});

test('biometric voice routes do not honor idempotent replay (a cached success can never mask revoked consent)', async () => {
  const s = await startServer();
  // The voice capture route re-executes on every call — same operationId or
  // not. Without a configured BIOMETRIC_ENCRYPTION_KEY the service fails
  // closed; the important property is that the SECOND call is NOT a cached
  // replay of the first (no replayedOperation flag ever appears).
  const first = await s.call('POST', '/api/voice/captures', { sessionId: 's1', purpose: 'quality_check', operationId: 'op_bio_1' }, { 'X-Roma-Operation-Id': 'op_bio_1' });
  const second = await s.call('POST', '/api/voice/captures', { sessionId: 's1', purpose: 'quality_check', operationId: 'op_bio_1' }, { 'X-Roma-Operation-Id': 'op_bio_1' });
  assert.notEqual(first.json?.replayedOperation, true);
  assert.notEqual(second.json?.replayedOperation, true);
  await s.close();
});
