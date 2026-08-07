import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteConsentRepository } from '../server/repositories/consentRepository.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { evaluatePolicy } from '../src/policy/sensitivity.js';

function setup() {
  const db = openDatabase({ memory: true });
  return { db, consentRepository: createSqliteConsentRepository({ db }), identityRepository: createSqliteIdentityRepository({ db }) };
}

test('consent grant is stored with purpose and scope', () => {
  const { consentRepository, identityRepository } = setup();
  const matt = identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const result = consentRepository.forWorkspace('w1', 'u1').grant({ personId: matt.personId, scope: 'voice_enrollment', purpose: 'family reminders' });
  assert.equal(result.ok, true);
  assert.equal(result.consent.scope, 'voice_enrollment');
  assert.equal(result.consent.purpose, 'family reminders');
  assert.equal(result.consent.status, 'active');
});

test('consent revocation blocks future biometric-reference use (isActive() flips false)', () => {
  const { consentRepository, identityRepository } = setup();
  const matt = identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const repo = consentRepository.forWorkspace('w1', 'u1');
  const granted = repo.grant({ personId: matt.personId, scope: 'voice_enrollment', purpose: 'x' });
  assert.equal(repo.isActive(matt.personId, 'voice_enrollment'), true);
  repo.revoke(granted.consent.consentId);
  assert.equal(repo.isActive(matt.personId, 'voice_enrollment'), false);
});

test('missing consent blocks a biometric provider operation via the policy engine', () => {
  const principal = { userId: 'u1', workspaceId: 'w1' };
  const withoutConsent = evaluatePolicy({ action: 'identity.voice_enroll', resource: { resourceId: 'vp1', sensitivity: 'biometric', workspaceId: 'w1' }, principal, context: { consentActive: false } });
  assert.equal(withoutConsent.decision, 'deny');
  assert.equal(withoutConsent.reasonCode, 'consent_required_or_revoked');
  const withConsent = evaluatePolicy({ action: 'identity.voice_enroll', resource: { resourceId: 'vp1', sensitivity: 'biometric', workspaceId: 'w1' }, principal, context: { consentActive: true } });
  assert.equal(withConsent.decision, 'allow');
});

test('revoking consent freezes the linked voice profile reference without deleting it', () => {
  const { db, consentRepository, identityRepository } = setup();
  const idRepo = identityRepository.forWorkspace('w1', 'u1');
  const matt = idRepo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const consent = consentRepository.forWorkspace('w1', 'u1').grant({ personId: matt.personId, scope: 'voice_enrollment', purpose: 'x' });
  idRepo.recordVoiceProfile({ personId: matt.personId, voiceProfileId: 'vp1', provider: 'deterministic', quality: 0.9, consentId: consent.consent.consentId });
  assert.deepEqual(idRepo.getPerson(matt.personId).voiceProfileIds, ['vp1']);

  consentRepository.forWorkspace('w1', 'u1').revoke(consent.consent.consentId);
  const linked = db.prepare('SELECT voice_profile_id FROM voice_profile_refs WHERE workspace_id = ? AND consent_id = ? AND revoked_at IS NULL').all('w1', consent.consent.consentId);
  for (const row of linked) idRepo.revokeVoiceProfile(row.voice_profile_id);

  assert.deepEqual(idRepo.getPerson(matt.personId).voiceProfileIds, []); // no longer usable
  const ref = idRepo.getVoiceProfileRef('vp1');
  assert.ok(ref); // but the reference row itself still exists (not erased)
  assert.ok(ref.revokedAt);
});

test('consent is tenant-scoped', () => {
  const { consentRepository, identityRepository } = setup();
  const matt = identityRepository.forWorkspace('w1', 'u1').createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const granted = consentRepository.forWorkspace('w1', 'u1').grant({ personId: matt.personId, scope: 'voice_enrollment', purpose: 'x' });
  const other = consentRepository.forWorkspace('w2', 'u2');
  assert.equal(other.get(granted.consent.consentId), null);
  assert.equal(other.isActive(matt.personId, 'voice_enrollment'), false);
});
