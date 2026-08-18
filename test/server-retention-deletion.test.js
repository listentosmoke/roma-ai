import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { createSqliteSessionRepository } from '../server/repositories/sessionRepository.mjs';
import { createSqliteAuditRepository } from '../server/repositories/auditRepository.mjs';
import { runRetentionCleanup } from '../server/repositories/retention.mjs';
import { planWorkspaceDeletion, deleteWorkspace } from '../server/repositories/deletion.mjs';

function setup() {
  const db = openDatabase({ memory: true });
  return {
    db,
    memoryRepository: createSqliteMemoryRepository({ db }),
    identityRepository: createSqliteIdentityRepository({ db }),
    sessionRepository: createSqliteSessionRepository({ db }),
    auditRepository: createSqliteAuditRepository({ db }),
  };
}

test('expired records are excluded from normal retrieval (sessions)', () => {
  const { db, sessionRepository } = setup();
  let clock = 1000;
  const repo = createSqliteSessionRepository({ db, now: () => clock }).forWorkspace('w1', 'u1');
  const s = repo.start({ ttlMs: 10 });
  clock += 100;
  assert.equal(repo.get(s.sessionId), null);
});

test('retention cleanup is deterministic and idempotent', () => {
  const { db, identityRepository, sessionRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  idRepo.createPerson({ displayName: 'Ghost', identityStatus: 'provisional', createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000 });
  const first = runRetentionCleanup({ db, sessionRepository, identityRepository, workspaceId: 'w1', userId: 'u1' });
  assert.equal(first.expiredProvisionalPeople.length, 1);
  const second = runRetentionCleanup({ db, sessionRepository, identityRepository, workspaceId: 'w1', userId: 'u1' });
  assert.equal(second.expiredProvisionalPeople.length, 0); // nothing new to clean up
});

test('a provisional person with linked memories or relationships is NEVER auto-expired by retention (real value, not garbage)', () => {
  const { db, identityRepository, sessionRepository, memoryRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const p = idRepo.createPerson({ displayName: 'Ghost', identityStatus: 'provisional', createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }).person;
  memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: p.personId });
  const result = runRetentionCleanup({ db, sessionRepository, identityRepository, workspaceId: 'w1', userId: 'u1' });
  assert.equal(result.expiredProvisionalPeople.length, 0);
  assert.equal(idRepo.getPerson(p.personId).status, 'active');
});

test('soft deletion and hard deletion are distinguishable via tombstones.deletion_kind', () => {
  const { db, memoryRepository } = setup();
  const repo = memoryRepository.forWorkspace('w1', 'u1');
  const a = repo.create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } }).memory;
  repo.softDelete(a.memoryId);
  const b = repo.create({ type: 'fact', subjectId: 'x', predicate: 'y2', summary: 'z2', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } }).memory;
  repo.delete(b.memoryId);
  const kinds = db.prepare('SELECT resource_id, deletion_kind FROM tombstones WHERE resource_id IN (?, ?)').all(a.memoryId, b.memoryId);
  const map = Object.fromEntries(kinds.map((k) => [k.resource_id, k.deletion_kind]));
  assert.equal(map[a.memoryId], 'soft');
  assert.equal(map[b.memoryId], 'hard');
});

test('deleted memories are unlinked from people (single delete)', () => {
  const { memoryRepository, identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const mem = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: matt.personId }).memory;
  assert.equal(idRepo.getPerson(matt.personId).linkedMemoryIds.length, 1);
  memRepo.delete(mem.memoryId);
  assert.deepEqual(idRepo.getPerson(matt.personId).linkedMemoryIds, []);
});

test('deleteBySource removes memory-entity links for every affected memory', () => {
  const { memoryRepository, identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p1', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated', interactionId: 'i1' }, speakerEntityId: matt.personId });
  memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p2', summary: 'y', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated', interactionId: 'i1' }, speakerEntityId: matt.personId });
  assert.equal(idRepo.getPerson(matt.personId).linkedMemoryIds.length, 2);
  const count = memRepo.deleteBySource('i1');
  assert.equal(count, 2);
  assert.deepEqual(idRepo.getPerson(matt.personId).linkedMemoryIds, []);
});

test('deleting a person does not silently delete unrelated memories', () => {
  const { memoryRepository, identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const mem = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: matt.personId }).memory;
  idRepo.deletePerson(matt.personId);
  assert.ok(memRepo.get(mem.memoryId));
});

test('workspace deletion produces a complete impact plan before applying', () => {
  const { db, memoryRepository, identityRepository } = setup();
  memoryRepository.forWorkspace('w1', 'u1').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
  const plan = planWorkspaceDeletion({ db, workspaceId: 'w1' });
  assert.equal(plan.counts.memories, 1);
  assert.equal(plan.counts.people, 1);
});

test('a confirmed workspace deletion removes retrievable data and requires confirm+operationId', () => {
  const { db, memoryRepository, auditRepository } = setup();
  memoryRepository.forWorkspace('w1', 'u1').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  const withoutConfirm = deleteWorkspace({ db, workspaceId: 'w1', operationId: 'op1', principalId: 'u1', auditRepository, confirm: false });
  assert.equal(withoutConfirm.ok, false);
  assert.equal(memoryRepository.forWorkspace('w1', 'u1').exportAll().length, 1); // untouched

  const withoutOpId = deleteWorkspace({ db, workspaceId: 'w1', operationId: null, principalId: 'u1', auditRepository, confirm: true });
  assert.equal(withoutOpId.ok, false);

  const confirmed = deleteWorkspace({ db, workspaceId: 'w1', operationId: 'op1', principalId: 'u1', auditRepository, confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.verified, true);
  assert.equal(memoryRepository.forWorkspace('w1', 'u1').exportAll().length, 0);
});

test('workspace deletion does not affect other workspaces', () => {
  const { db, memoryRepository, auditRepository } = setup();
  memoryRepository.forWorkspace('w1', 'u1').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  memoryRepository.forWorkspace('w2', 'u2').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  deleteWorkspace({ db, workspaceId: 'w1', operationId: 'op1', principalId: 'u1', auditRepository, confirm: true });
  assert.equal(memoryRepository.forWorkspace('w2', 'u2').exportAll().length, 1);
});
