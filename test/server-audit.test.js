import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteAuditRepository } from '../server/repositories/auditRepository.mjs';

test('audit events are append-only through the normal API — no update/delete method exists', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteAuditRepository({ db }).forWorkspace('w1');
  assert.deepEqual(Object.keys(repo).sort(), ['countByOutcome', 'list', 'record'].sort());
});

test('audit records carry IDs, actions, outcomes, and reason codes without raw sensitive payload content', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteAuditRepository({ db }).forWorkspace('w1');
  const event = repo.record({ principalId: 'u1', action: 'memory.create', resourceType: 'memory', resourceId: 'mem_1', outcome: 'created', reasonCode: 'ok', sensitivity: 'secret', redacted: true, sourceIds: ['mem_1'] });
  assert.equal(event.resourceId, 'mem_1');
  assert.equal(event.outcome, 'created');
  assert.equal(event.redacted, true);
  assert.ok(!('summary' in event));
  assert.ok(!('content' in event));
});

test('audit list is tenant-scoped and supports filtering/limits', () => {
  const db = openDatabase({ memory: true });
  const repoA = createSqliteAuditRepository({ db }).forWorkspace('w1');
  const repoB = createSqliteAuditRepository({ db }).forWorkspace('w2');
  repoA.record({ principalId: 'u1', action: 'memory.create', resourceType: 'memory', outcome: 'created' });
  repoA.record({ principalId: 'u1', action: 'memory.delete', resourceType: 'memory', outcome: 'deleted' });
  repoB.record({ principalId: 'u2', action: 'memory.create', resourceType: 'memory', outcome: 'created' });
  assert.equal(repoA.list({}).length, 2);
  assert.equal(repoB.list({}).length, 1);
  assert.equal(repoA.list({ action: 'memory.delete' }).length, 1);
  assert.equal(repoA.list({ limit: 1 }).length, 1);
});

test('a policy denial is auditable (outcome:"denied") without exposing the denied content', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteAuditRepository({ db }).forWorkspace('w1');
  const event = repo.record({ principalId: 'u1', action: 'memory.context_compile', resourceType: 'memory', resourceId: 'mem_secret', outcome: 'denied', reasonCode: 'secret_never_in_model_context', sensitivity: 'secret', redacted: true });
  assert.equal(event.outcome, 'denied');
  assert.equal(event.reasonCode, 'secret_never_in_model_context');
});

test('countByOutcome summarizes for the Server Data panel', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteAuditRepository({ db }).forWorkspace('w1');
  repo.record({ principalId: 'u1', action: 'a', resourceType: 'r', outcome: 'created' });
  repo.record({ principalId: 'u1', action: 'a', resourceType: 'r', outcome: 'created' });
  repo.record({ principalId: 'u1', action: 'a', resourceType: 'r', outcome: 'denied' });
  assert.deepEqual(repo.countByOutcome(), { created: 2, denied: 1 });
});
