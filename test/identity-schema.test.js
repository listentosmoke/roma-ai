import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePerson, validateEvidence, validateRelationship, identityEvidenceRank, IDENTITY_EVIDENCE_TYPES, SENSITIVITY_LEVELS } from '../src/identity/schema.js';

test('validatePerson accepts a minimal valid record and fills defaults', () => {
  const { ok, person, errors } = validatePerson({ personId: 'person_1', displayName: 'Matt', identityStatus: 'confirmed' });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(person.status, 'active');
  assert.equal(person.sensitivity, 'normal');
  assert.equal(person.schemaVersion, 1);
  assert.deepEqual(person.aliases, []);
  assert.deepEqual(person.faceProfileIds, []); // reserved for later — never populated
});

test('validatePerson rejects missing displayName / bad identityStatus, never throws', () => {
  assert.equal(validatePerson({ personId: 'p1', displayName: '', identityStatus: 'confirmed' }).ok, false);
  assert.equal(validatePerson({ personId: 'p1', displayName: 'Matt', identityStatus: 'nonsense' }).ok, false);
  assert.equal(validatePerson(null).ok, false);
  assert.equal(validatePerson(undefined).ok, false);
});

test('validatePerson bounds aliases/roles/attributes and normalizes alias text', () => {
  const { person } = validatePerson({
    personId: 'p1', displayName: 'Matt', identityStatus: 'confirmed',
    aliases: [{ alias: '  Matthew  ', type: 'name' }, { type: 'name' }, 'not-an-object', null],
    roles: Array.from({ length: 20 }, (_, i) => `role_${i}`),
  });
  assert.equal(person.aliases.length, 1);
  assert.equal(person.aliases[0].normalizedAlias, 'matthew');
  assert.ok(person.roles.length <= 8);
});

test('validateEvidence accepts a full record and defaults sensitivity to biometric for voice evidence', () => {
  const { ok, evidence } = validateEvidence({ evidenceId: 'evidence_1', evidenceType: 'voice_match', personId: 'p1', score: 0.9, decision: 'resolved' });
  assert.equal(ok, true);
  assert.equal(evidence.sensitivity, 'biometric');
  assert.equal(evidence.decision, 'resolved');
});

test('validateEvidence rejects an unknown evidenceType/decision', () => {
  assert.equal(validateEvidence({ evidenceId: 'e1', evidenceType: 'made_up_type' }).ok, false);
  assert.equal(validateEvidence({ evidenceId: 'e1', evidenceType: 'voice_match', decision: 'made_up_decision' }).ok, false);
});

test('identityEvidenceRank orders correction/manual_confirmation above name_mention/memory_context', () => {
  assert.ok(identityEvidenceRank('correction') > identityEvidenceRank('explicit_user_attribution'));
  assert.ok(identityEvidenceRank('manual_confirmation') > identityEvidenceRank('voice_match'));
  assert.ok(identityEvidenceRank('name_mention') < identityEvidenceRank('explicit_self_identification'));
  assert.ok(identityEvidenceRank('memory_context') < identityEvidenceRank('voice_match'));
});

test('future_face_match is a valid schema value but is schema-support only', () => {
  assert.ok(IDENTITY_EVIDENCE_TYPES.includes('future_face_match'));
  const { ok } = validateEvidence({ evidenceId: 'e1', evidenceType: 'future_face_match', personId: 'p1' });
  assert.equal(ok, true);
});

test('validateRelationship accepts a full record and rejects a bad type', () => {
  const { ok, relationship } = validateRelationship({ relationshipId: 'r1', fromEntityId: 'person_user', toEntityId: 'p1', type: 'works_with' });
  assert.equal(ok, true);
  assert.equal(relationship.status, 'active');
  assert.equal(relationship.direction, 'directed');
  assert.equal(validateRelationship({ relationshipId: 'r1', fromEntityId: 'a', toEntityId: 'b', type: 'not_a_real_type' }).ok, false);
});

test('sensitivity is metadata-only: SENSITIVITY_LEVELS includes biometric, and an out-of-range value falls back to normal', () => {
  assert.ok(SENSITIVITY_LEVELS.includes('biometric'));
  const { person } = validatePerson({ personId: 'p1', displayName: 'Matt', identityStatus: 'confirmed', sensitivity: 'not-a-real-level' });
  assert.equal(person.sensitivity, 'normal');
});
