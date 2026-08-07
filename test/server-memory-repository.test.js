import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';

function setup() {
  const db = openDatabase({ memory: true });
  const memoryRepository = createSqliteMemoryRepository({ db });
  const identityRepository = createSqliteIdentityRepository({ db });
  return { db, memoryRepository, identityRepository };
}

test('memory records preserve their existing ID and provenance across create/get', () => {
  const { memoryRepository } = setup();
  const repo = memoryRepository.forWorkspace('w1', 'u1');
  const result = repo.create({ memoryId: 'mem_fixed_1', type: 'fact', subjectId: 'person_user', predicate: 'likes', summary: 'x', confidence: 0.8, importance: 0.5, source: { evidenceType: 'user_stated', interactionId: 'i1', turnIds: [1] } });
  assert.equal(result.memory.memoryId, 'mem_fixed_1');
  const fetched = repo.get('mem_fixed_1');
  assert.equal(fetched.source.interactionId, 'i1');
  assert.deepEqual(fetched.source.turnIds, [1]);
});

test('cross-tenant memory access is denied at the repository layer', () => {
  const { memoryRepository } = setup();
  const created = memoryRepository.forWorkspace('w1', 'u1').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  const other = memoryRepository.forWorkspace('w2', 'u2');
  assert.equal(other.get(created.memory.memoryId), null);
  assert.equal(other.searchStructured({}).length, 0);
  assert.equal(other.exportAll().length, 0);
});

test('guessing a memory ID does not grant access across tenants', () => {
  const { memoryRepository } = setup();
  const created = memoryRepository.forWorkspace('w1', 'u1').create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  // Even with the EXACT correct ID string, a different workspace scope returns null.
  assert.equal(memoryRepository.forWorkspace('attacker_workspace', 'attacker').get(created.memory.memoryId), null);
});

test('deleteBySource cleans memory-entity links (fixes the known gap structurally via live joins)', () => {
  const { memoryRepository, identityRepository } = setup();
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  memRepo.create({ type: 'commitment', subjectId: 'person_user', predicate: 'x', summary: 'x', confidence: 0.9, importance: 0.8, source: { evidenceType: 'user_stated', interactionId: 'i1', speakerId: 'Speaker 1' }, speakerEntityId: matt.personId });
  assert.deepEqual(idRepo.getPerson(matt.personId).linkedMemoryIds.length, 1);
  const count = memRepo.deleteBySource('i1');
  assert.equal(count, 1);
  assert.deepEqual(idRepo.getPerson(matt.personId).linkedMemoryIds, []);
});

test('a hard delete records a tombstone distinguishable from a soft delete', () => {
  const { memoryRepository, db } = setup();
  const repo = memoryRepository.forWorkspace('w1', 'u1');
  const created = repo.create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  repo.delete(created.memory.memoryId);
  const hardTomb = db.prepare("SELECT * FROM tombstones WHERE resource_id = ?").get(created.memory.memoryId);
  assert.equal(hardTomb.deletion_kind, 'hard');
  assert.equal(repo.get(created.memory.memoryId), null);

  const created2 = repo.create({ type: 'fact', subjectId: 'x', predicate: 'y2', summary: 'z2', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  repo.softDelete(created2.memory.memoryId);
  const softTomb = db.prepare("SELECT * FROM tombstones WHERE resource_id = ?").get(created2.memory.memoryId);
  assert.equal(softTomb.deletion_kind, 'soft');
  assert.equal(repo.get(created2.memory.memoryId), null); // excluded from normal reads
  const rawRow = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(created2.memory.memoryId);
  assert.ok(rawRow); // but the row itself still exists (recoverable/inspectable)
});

test('markAccessed, supersede, and findRelated behave the same as the client repository', () => {
  const { memoryRepository } = setup();
  const repo = memoryRepository.forWorkspace('w1', 'u1');
  const a = repo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'old', confidence: 0.6, importance: 0.5, tags: ['t'], source: { evidenceType: 'user_stated' } }).memory;
  const related = repo.findRelated({ type: 'fact', subjectId: 'person_user', predicate: 'p' });
  assert.equal(related.length, 1);
  const b = repo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'new', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_corrected' }, supersedes: [a.memoryId] }).memory;
  repo.supersede(a.memoryId, b.memoryId);
  assert.equal(repo.get(a.memoryId).status, 'superseded');
  repo.markAccessed([b.memoryId]);
  assert.ok(repo.get(b.memoryId).lastAccessedAt);
});
