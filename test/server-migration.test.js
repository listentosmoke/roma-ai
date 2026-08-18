import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { planMigration, applyMigration } from '../server/migration/localStorageImport.mjs';

function setup() {
  const db = openDatabase({ memory: true });
  return {
    db,
    repositories: {
      memory: createSqliteMemoryRepository({ db }).forWorkspace('w1', 'u1'),
      identity: createSqliteIdentityRepository({ db }).forWorkspace('w1', 'u1'),
    },
  };
}

function legacyMemory(overrides = {}) {
  return { memoryId: 'mem_legacy_1', type: 'fact', subjectId: 'person_user', predicate: 'likes', summary: 'The user likes coffee.', confidence: 0.8, importance: 0.5, status: 'active', source: { evidenceType: 'user_stated' }, ...overrides };
}
function legacyPerson(overrides = {}) {
  return { personId: 'person_legacy_1', displayName: 'Matt', identityStatus: 'confirmed', ...overrides };
}

test('a dry run reports valid, duplicate, and malformed legacy records without writing anything', () => {
  const { repositories } = setup();
  const records = { memories: [legacyMemory(), { type: 'fact' }], people: [legacyPerson()], relationships: [] };
  const plan = planMigration({ records, repositories });
  assert.equal(plan.memories.counts.valid, 1);
  assert.equal(plan.memories.counts.malformed, 1);
  assert.equal(plan.people.counts.valid, 1);
  assert.equal(repositories.memory.exportAll().length, 0); // nothing written
});

test('a confirmed import writes the valid records and preserves original IDs/links', () => {
  const { db, repositories } = setup();
  const records = { memories: [legacyMemory({ speakerEntityId: 'person_legacy_1' })], people: [legacyPerson()], relationships: [] };
  const result = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op1' });
  assert.equal(result.report.memoriesImported, 1);
  assert.equal(result.report.peopleImported, 1);
  assert.ok(repositories.memory.get('mem_legacy_1'));
  assert.ok(repositories.identity.getPerson('person_legacy_1'));
  assert.deepEqual(repositories.identity.getPerson('person_legacy_1').linkedMemoryIds, ['mem_legacy_1']);
});

test('migration is idempotent — the SAME operationId replays the cached result instead of re-importing', () => {
  const { db, repositories } = setup();
  const records = { memories: [legacyMemory()], people: [], relationships: [] };
  const first = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_repeat' });
  assert.equal(first.alreadyApplied, false);
  const second = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_repeat' });
  assert.equal(second.alreadyApplied, true);
  assert.equal(repositories.memory.exportAll().length, 1); // not duplicated
});

test('a second migration attempt with a DIFFERENT operationId still creates no duplicates (record-ID-level idempotency)', () => {
  const { db, repositories } = setup();
  const records = { memories: [legacyMemory()], people: [legacyPerson()], relationships: [] };
  applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_a' });
  const second = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_b' });
  assert.equal(second.report.memoriesSkipped, 1);
  assert.equal(second.report.peopleSkipped, 1);
  assert.equal(repositories.memory.exportAll().length, 1);
});

test('a partial/failed migration never deletes anything — malformed records are reported, not applied, and valid ones already imported stay', () => {
  const { db, repositories } = setup();
  const records = { memories: [legacyMemory(), { type: 'fact', predicate: 'p' /* missing memoryId -> malformed */ }], people: [], relationships: [] };
  const result = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_partial' });
  assert.equal(result.report.memoriesImported, 1);
  assert.ok(repositories.memory.get('mem_legacy_1')); // the valid one landed
});

test('malformed legacy records are reported with a reason, never silently dropped', () => {
  const { repositories } = setup();
  const plan = planMigration({ records: { memories: [{ type: 'fact' }], people: [], relationships: [] }, repositories });
  assert.equal(plan.memories.preview[0].status, 'malformed');
  assert.ok(plan.memories.preview[0].reason);
});

test('duplicate legacy records (matching an ID already on the server) do not multiply', () => {
  const { db, repositories } = setup();
  repositories.memory.create(legacyMemory());
  const plan = planMigration({ records: { memories: [legacyMemory()], people: [], relationships: [] }, repositories });
  assert.equal(plan.memories.counts.duplicate, 1);
  const result = applyMigration({ db, workspaceId: 'w1', records: { memories: [legacyMemory()], people: [], relationships: [] }, repositories, operationId: 'op_dup' });
  assert.equal(result.report.memoriesSkipped, 1);
  assert.equal(repositories.memory.exportAll().length, 1);
});

test('evidence records import and preserve provenance', () => {
  const { db, repositories } = setup();
  const records = { people: [legacyPerson()], evidence: [{ evidenceId: 'evidence_legacy_1', evidenceType: 'explicit_user_attribution', personId: 'person_legacy_1', decision: 'resolved' }], memories: [], relationships: [] };
  const result = applyMigration({ db, workspaceId: 'w1', records, repositories, operationId: 'op_evidence' });
  assert.equal(result.report.evidenceImported, 1);
  assert.ok(repositories.identity.listEvidenceForPerson('person_legacy_1').some((e) => e.evidenceId === 'evidence_legacy_1'));
});
