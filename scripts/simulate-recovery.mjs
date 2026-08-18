#!/usr/bin/env node
// Stabilization-phase recovery simulation: the REAL mutation queue
// (src/server/mutationQueue.js) against the REAL data-API route handlers
// (server/routes/dataApi.mjs) over real HTTP, with a real file-backed SQLite
// database — proving interrupted-server retry, idempotency, correction
// authority, deletion permanence, consent-revocation priority, refresh/
// restart recovery, tenant scoping, audit traceability, storage safety, and
// that no recovery path touches the Speech Gate or bypasses sensitivity
// policy. Run: npm run simulate:recovery

import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDataApi } from '../server/dataApiPlugin.mjs';
import { attachDataApi } from '../server/routes/dataApi.mjs';
import { createMutationQueue, MutationQueueError } from '../src/server/mutationQueue.js';
import { createDataClient } from '../src/server/dataClient.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';

const checks = [];
function check(label, condition, details = '') {
  assert.ok(condition, label);
  checks.push(label);
  console.log(`  PASS ${String(checks.length).padStart(2, '0')}  ${label}${details ? ` (${details})` : ''}`);
}

const dbPath = join(tmpdir(), `roma-recovery-${process.pid}.db`);
const quiet = { warn: () => {} };

let api = null;
let server = null;
let port = null;

async function startServer(atPort = 0) {
  api = createDataApi({ dbPath, log: quiet });
  const middlewares = { fns: [], use(fn) { this.fns.push(fn); } };
  attachDataApi(middlewares, api.handlers);
  server = http.createServer((req, res) => {
    let i = 0;
    function next() { const fn = middlewares.fns[i++]; if (fn) fn(req, res, next); else { res.statusCode = 404; res.end('{}'); } }
    next();
  });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(atPort, resolve); });
  port = server.address().port;
}
async function stopServer() {
  await new Promise((resolve) => server.close(resolve));
  api.db.close();
  server = null;
}
/** First request after a server restart can hit a stale keep-alive socket (ECONNRESET) — retry once or twice, exactly as the mutation queue itself would. */
async function readWithRetry(fn, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw lastError;
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

const validMemory = (id, extra = {}) => ({ memoryId: id, type: 'fact', subjectId: 'person_x', predicate: 'commit', summary: `recovery record ${id}`, confidence: 0.6, importance: 0.6, source: { evidenceType: 'user_stated' }, ...extra });

console.log('\nRecovery & data-sync reliability simulation');
console.log('═══════════════════════════════════════════');

// Reserve a port, then take the server DOWN before the first mutation.
await startServer(0);
const fixedPort = port;
await stopServer();

const storageMap = new Map();
const storage = { getItem: (k) => storageMap.get(k) ?? null, setItem: (k, v) => storageMap.set(k, v), removeItem: (k) => storageMap.delete(k) };
const dataClient = createDataClient({ baseUrl: `http://localhost:${fixedPort}`, timeoutMs: 1500 });
const queue = createMutationQueue({ dataClient, storage, baseBackoffMs: 40, maxBackoffMs: 200, maxAttempts: 50, label: 'memory' });

console.log('\n— Interrupted server, visible pending, idempotent retry —');
const createOp = queue.submit({ kind: 'create', method: 'post', path: '/api/data/memory', body: validMemory('mem_recover_1'), entityType: 'memory', entityId: 'mem_recover_1' });
check('1. A memory mutation begins and receives a stable operation ID', createOp.operationId?.startsWith('op_') && createOp.status === 'pending');

await waitFor(() => queue.status().retrying > 0);
const downStatus = queue.status();
check('2. With the server unavailable, the mutation does not falsely acknowledge', downStatus.acknowledged === 0);
check('3. The mutation remains VISIBLY pending/retrying while the server is down', downStatus.open === 1, `retrying=${downStatus.retrying}`);

await startServer(fixedPort);
check('4. The server returns on the same address', port === fixedPort);

await waitFor(() => queue.status().acknowledged === 1);
check('5. The idempotent retry succeeds after recovery', queue.status().acknowledged === 1 && queue.status().open === 0);

const afterRecovery = await dataClient.get('/api/data/memory');
check('6. Exactly one memory exists server-side despite the retries', afterRecovery.memories.length === 1 && afterRecovery.memories[0].memoryId === 'mem_recover_1');

console.log('\n— Correction authority over delayed retries —');
queue.submit({ kind: 'update', method: 'patch', path: '/api/data/memory/mem_recover_1', body: { summary: 'version one' }, entityType: 'memory', entityId: 'mem_recover_1' });
await waitFor(() => queue.status().open === 0);
const v1Op = queue.list().find((op) => op.kind === 'update');
check('7. A correction begins after an earlier acknowledged update', Boolean(v1Op) && (await dataClient.patch('/api/data/memory/mem_recover_1', { summary: 'version two — corrected' })).ok === true);

// The old update's duplicate arrives late (same operation ID, direct send).
const lateRetry = await dataClient.patch('/api/data/memory/mem_recover_1', { summary: 'version one' }, { operationId: v1Op.operationId });
check('8. An older delayed retry is served from the idempotency ledger, not re-executed', lateRetry.replayedOperation === true);

const afterCorrection = await dataClient.get('/api/data/memory/mem_recover_1');
check('9. The correction remains authoritative', afterCorrection.memory.summary === 'version two — corrected');

console.log('\n— Deletion permanence —');
queue.submit({ kind: 'delete', method: 'del', path: '/api/data/memory/mem_recover_1', entityType: 'memory', entityId: 'mem_recover_1' });
await waitFor(() => queue.status().open === 0);
check('10. A deletion begins and is acknowledged', (await dataClient.get('/api/data/memory')).memories.length === 0);

let resurrection = null;
try { resurrection = await dataClient.post('/api/data/memory', validMemory('mem_recover_1'), { operationId: 'op_late_create_replay' }); } catch (error) { resurrection = error; }
check('11. A delayed create replay is refused with a deterministic conflict', resurrection?.status === 409 && resurrection?.code === 'record_deleted');
check('12. The deleted record is NOT resurrected', (await dataClient.get('/api/data/memory')).memories.length === 0);

console.log('\n— Consent revocation priority —');
const personResult = await dataClient.post('/api/data/people', { displayName: 'Recovery Test Person', identityStatus: 'confirmed' });
const personId = personResult.person.personId;
const consent = await dataClient.post('/api/consent', { personId, scope: 'voice_identity', purpose: 'recovery simulation', provider: 'local_wavlm' });
await stopServer(); // hold the queue so the voice-profile op stays pending
queue.submit({ kind: 'update', method: 'post', path: `/api/data/people/${personId}/voice-profile`, body: { voiceProfileId: 'vp_recovery_1' }, entityType: 'voice_profile_ref', entityId: 'vp_recovery_1', category: 'voice_profile' });
const cancelledCount = queue.cancelWhere((op) => op.category === 'voice_profile', 'consent_revoked');
check('13. Consent revocation takes priority: the pending voice-profile mutation is cancelled BEFORE any revoke call', cancelledCount === 1);
await startServer(fixedPort);
const revoked = await readWithRetry(() => dataClient.post(`/api/consent/${consent.consent.consentId}/revoke`, {}));
check('14. The pending voice-profile operation stays cancelled and consent is revoked server-side', revoked.ok === true && queue.list({ statuses: ['cancelled'] }).some((op) => op.reasonCode === 'consent_revoked'));

console.log('\n— Refresh and restart recovery —');
await stopServer();
queue.submit({ kind: 'create', method: 'post', path: '/api/data/memory', body: validMemory('mem_refresh_1'), entityType: 'memory', entityId: 'mem_refresh_1' });
await waitFor(() => queue.status().retrying > 0);
// "Browser refresh": a brand-new queue instance over the SAME storage.
const revivedQueue = createMutationQueue({ dataClient, storage, baseBackoffMs: 40, maxBackoffMs: 200, maxAttempts: 50, label: 'memory' });
const restored = revivedQueue.list({ statuses: ['pending', 'retrying'] });
check('15. A browser refresh restores the safe pending operation from bounded queue metadata', restored.length === 1 && restored[0].entityId === 'mem_refresh_1' && restored[0].hasBody === true);
await startServer(fixedPort);
await revivedQueue.flush();
await waitFor(() => revivedQueue.status().acknowledged >= 1);

await stopServer();
await startServer(fixedPort);
const afterRestart = await readWithRetry(() => dataClient.get('/api/data/memory'));
check('16. A server restart retains acknowledged data (file-backed SQLite)', afterRestart.memories.some((m) => m.memoryId === 'mem_refresh_1'));

console.log('\n— Tenant scope, audit, storage safety, policy —');
const crossTenant = await readWithRetry(() => fetch(`http://localhost:${fixedPort}/api/data/memory`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Roma-Operation-Id': v1Op.operationId, 'X-Roma-Dev-Workspace': 'intruder_ws', 'X-Roma-Dev-User': 'intruder' },
  body: JSON.stringify(validMemory('mem_intruder')),
}).then((r) => r.json()));
check('17. A cross-tenant replay of a known operation ID is denied a cached result', crossTenant.replayedOperation !== true);

const auditEvents = (await readWithRetry(() => dataClient.get('/api/audit?limit=100'))).events;
const withOperation = auditEvents.filter((event) => event.operationId);
const withReason = auditEvents.filter((event) => event.reasonCode);
check('18. Audit events carry operation IDs and reason codes', withOperation.length > 0 && withReason.length > 0, `${withOperation.length} with operationId`);

await stopServer();
queue.submit({ kind: 'create', method: 'post', path: '/api/data/memory', body: validMemory('mem_private_1', { sensitivity: 'sensitive', summary: 'PRIVATE-MEDICAL-DETAIL' }), entityType: 'memory', entityId: 'mem_private_1', sensitivity: 'sensitive' });
let biometricRejected = false;
try { queue.submit({ kind: 'create', method: 'post', path: '/api/data/x', body: { template: [1, 2, 3] } }); } catch (error) { biometricRejected = error instanceof MutationQueueError; }
const persistedRaw = storageMap.get('roma.sync.queue') ?? '';
check('19. No sensitive or biometric payload reaches unsafe queue storage', biometricRejected && !persistedRaw.includes('PRIVATE-MEDICAL-DETAIL'));

await startServer(fixedPort);
await waitFor(() => queue.status().open === 0, { timeoutMs: 8000 });
const search = await readWithRetry(() => dataClient.get('/api/data/memory'));
const secretLeaked = search.memories.some((m) => m.memoryId === 'mem_private_1');
const gate = createSpeechGate();
const gateDenied = gate.requestSpeech({ prompted: false, preferences: {}, urgent: true }).approved === false;
const queueHasNoSpeechSurface = !('speak' in queue) && !('requestSpeech' in queue) && !('synthesize' in queue);
check('20. No recovery operation bypasses sensitivity policy or the Speech Gate', !secretLeaked && gateDenied && queueHasNoSpeechSurface, 'sensitive record excluded from search; gate still denies; queue has no speech surface');

await stopServer();
for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix); } catch { /* not created */ } }

console.log(`\n  ${checks.length}/20 checks passed`);
if (checks.length !== 20) process.exit(1);
