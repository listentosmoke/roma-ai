import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';

function setup() {
  const db = openDatabase({ memory: true });
  return { db, identityRepository: createSqliteIdentityRepository({ db }), memoryRepository: createSqliteMemoryRepository({ db }) };
}

test('person records preserve aliases and identity evidence', () => {
  const { identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const created = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed', aliases: [{ alias: 'Matthew', type: 'name' }] });
  assert.equal(created.person.aliases[0].normalizedAlias, 'matthew');
  const evidence = repo.addEvidence({ evidenceType: 'explicit_user_attribution', personId: created.person.personId, decision: 'resolved' });
  assert.ok(created.person.personId);
  assert.equal(repo.listEvidenceForPerson(created.person.personId)[0].evidenceId, evidence.evidence.evidenceId);
});

test('relationships preserve direction and provenance', () => {
  const { identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const matt = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const created = repo.createRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'works_with', sourceEvidenceIds: ['evidence_1'] });
  assert.equal(created.relationship.fromEntityId, 'person_user');
  assert.equal(created.relationship.toEntityId, matt.personId);
  assert.deepEqual(created.relationship.sourceEvidenceIds, ['evidence_1']);
});

test('memory-entity links preserve referential integrity (invalid entity IDs are skipped, not crashing)', () => {
  const { memoryRepository } = setup();
  const repo = memoryRepository.forWorkspace('w1', 'u1');
  const result = repo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: 'person_does_not_exist' });
  assert.equal(result.ok, true); // never crashes
});

test('cross-tenant person access is denied', () => {
  const { identityRepository } = setup();
  const matt = identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const other = identityRepository.forWorkspace('w2', 'u2');
  assert.equal(other.getPerson(matt.personId), null);
  assert.equal(other.findByName('Matt').length, 0);
  assert.equal(other.listPeople({}).length, 0);
});

test('cross-tenant relationship traversal is denied', () => {
  const { identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const matt = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  repo.createRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'friend' });
  const other = identityRepository.forWorkspace('w2', 'u2');
  assert.equal(other.listRelationships({ entityId: matt.personId }).length, 0);
});

test('a guessed personId does not grant cross-tenant access even to an evidence lookup', () => {
  const { identityRepository } = setup();
  const matt = identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const other = identityRepository.forWorkspace('attacker', 'attacker');
  assert.equal(other.listEvidenceForPerson(matt.personId).length, 0);
});

test('merge preserves aliases, evidence, relationships, and memory links under the target; merge history stays inspectable', () => {
  const { identityRepository, memoryRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const target = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const source = idRepo.createPerson({ displayName: 'Matthew', identityStatus: 'confirmed', aliases: [{ alias: 'Matty', type: 'nickname' }] }).person;
  const ev = idRepo.addEvidence({ evidenceType: 'explicit_user_attribution', personId: source.personId, decision: 'resolved' });
  memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: source.personId });

  const result = idRepo.mergePeople([source.personId], target.personId);
  assert.equal(result.ok, true);
  const merged = idRepo.getPerson(target.personId);
  assert.ok(merged.aliases.some((a) => a.normalizedAlias === 'matty'));
  assert.equal(merged.linkedMemoryIds.length, 1);
  assert.ok(idRepo.listEvidenceForPerson(target.personId).some((e) => e.evidenceId === ev.evidence.evidenceId));
  assert.equal(idRepo.getPerson(source.personId).identityStatus, 'merged');
});

test('merge avoids duplicate relationship edges', () => {
  const { identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const target = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const source = idRepo.createPerson({ displayName: 'Matthew', identityStatus: 'confirmed' }).person;
  idRepo.createRelationship({ fromEntityId: 'person_user', toEntityId: target.personId, type: 'works_with' });
  idRepo.createRelationship({ fromEntityId: 'person_user', toEntityId: source.personId, type: 'works_with' });
  idRepo.mergePeople([source.personId], target.personId);
  const active = idRepo.listRelationships({ entityId: target.personId }).filter((r) => r.type === 'works_with');
  assert.equal(active.length, 1);
});

test('split moves only selected evidence and links; ambiguous (unlisted) memories remain unresolved', () => {
  const { identityRepository, memoryRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const combined = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const keep = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p1', summary: 'keep', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: combined.personId }).memory;
  const move = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p2', summary: 'move', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: combined.personId }).memory;

  const result = idRepo.splitPerson(combined.personId, { newDisplayName: 'Other Matt', memoryIds: [move.memoryId] });
  assert.equal(result.ok, true);
  assert.deepEqual(idRepo.getPerson(combined.personId).linkedMemoryIds, [keep.memoryId]);
  assert.deepEqual(idRepo.getPerson(result.target.personId).linkedMemoryIds, [move.memoryId]);
});

test('split invalidates nothing it should not — everything not explicitly listed stays on the source', () => {
  const { identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const combined = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed', aliases: [{ alias: 'A', type: 'nickname' }, { alias: 'B', type: 'nickname' }] }).person;
  const result = idRepo.splitPerson(combined.personId, { newDisplayName: 'Other', aliasTexts: ['a'] });
  const source = idRepo.getPerson(combined.personId);
  const target = idRepo.getPerson(result.target.personId);
  assert.ok(source.aliases.some((a) => a.normalizedAlias === 'b'));
  assert.ok(!source.aliases.some((a) => a.normalizedAlias === 'a'));
  assert.ok(target.aliases.some((a) => a.normalizedAlias === 'a'));
});

test('deleting a person does not silently delete unrelated memories', () => {
  const { identityRepository, memoryRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const memRepo = memoryRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const mem = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated' }, speakerEntityId: matt.personId }).memory;
  idRepo.deletePerson(matt.personId);
  assert.ok(memRepo.get(mem.memoryId)); // memory untouched
  assert.equal(idRepo.getPerson(matt.personId).status, 'deleted');
});

// ── face profiles (F3) ─────────────────────────────────────────────────────
//
// A person's faceProfileIds are DERIVED from face_templates rather than kept
// as a second list, so the two can never drift apart.

function enrolFace(db, { faceProfileId, personId, workspaceId = 'w1' }) {
  db.prepare(`INSERT INTO face_templates (face_profile_id, workspace_id, person_id, provider, model, model_revision, model_version, template_version, dimensions, encrypted_template, encryption_algorithm, encryption_nonce, encryption_auth_tag, encryption_key_version, sample_count, aggregate_quality, status, created_at, updated_at, template_plain)
    VALUES (?,?,?,'insightface','buffalo_l','rev0','1',2,512,'','none','','',0,1,0.9,'active',1,1,'[]')`)
    .run(faceProfileId, workspaceId, personId);
}

test('a person carries the face profiles that actually exist for them', () => {
  const { db, identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const matt = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  assert.deepEqual(matt.faceProfileIds, [], 'nothing enrolled yet');

  enrolFace(db, { faceProfileId: 'face_1', personId: matt.personId });
  assert.deepEqual(repo.getPerson(matt.personId).faceProfileIds, ['face_1']);
});

test('attaching a face profile writes the enrollment evidence trail', () => {
  const { db, identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const matt = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  enrolFace(db, { faceProfileId: 'face_1', personId: matt.personId });

  const result = repo.attachFaceProfile(matt.personId, 'face_1', { provider: 'insightface', providerModel: 'buffalo_l', quality: 0.92, sampleCount: 3 });
  assert.equal(result.ok, true);

  const evidence = repo.listEvidenceForPerson(matt.personId).at(-1);
  assert.equal(evidence.evidenceType, 'face_enrollment');
  assert.equal(evidence.decision, 'enrolled');
  assert.equal(evidence.faceProfileId, 'face_1', 'the profile reference survives the round trip through SQLite');
  assert.equal(evidence.sensitivity, 'biometric');
  assert.equal(evidence.reasonCode, 'explicit_enrollment_3_samples');
});

test('attaching a face profile to nobody fails rather than orphaning evidence', () => {
  const { identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  assert.equal(repo.attachFaceProfile('person_does_not_exist', 'face_1').ok, false);
});

test('forgetting a person stops the camera recognising them', () => {
  const { db, identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const matt = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  enrolFace(db, { faceProfileId: 'face_1', personId: matt.personId });

  repo.deletePerson(matt.personId);

  const row = db.prepare('SELECT status FROM face_templates WHERE face_profile_id = ?').get('face_1');
  assert.equal(row.status, 'deleted', 'a forgotten person must not keep producing face evidence');
});

test('merging people carries their face profiles onto the surviving record', () => {
  const { db, identityRepository } = setup();
  const repo = identityRepository.forWorkspace('w1', 'u1');
  const target = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const source = repo.createPerson({ displayName: 'Matthew', identityStatus: 'candidate' }).person;
  enrolFace(db, { faceProfileId: 'face_target', personId: target.personId });
  enrolFace(db, { faceProfileId: 'face_source', personId: source.personId });

  const merged = repo.mergePeople([source.personId], target.personId);
  assert.equal(merged.ok, true);
  assert.deepEqual(repo.getPerson(target.personId).faceProfileIds.sort(), ['face_source', 'face_target']);
});
