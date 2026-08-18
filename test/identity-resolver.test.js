import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';
import { createEntityResolver } from '../src/identity/resolver.js';

function setup(overrides = {}) {
  const repository = createInMemoryIdentityRepository();
  const voiceProvider = createDeterministicVoiceProvider();
  const resolver = createEntityResolver({ repository, voiceProvider, sessionTimeoutMs: 30 * 60 * 1000, ...overrides });
  return { repository, voiceProvider, resolver };
}

test('a transient speaker label alone is not itself a stable identity — resolve() with no evidence returns unknown', async () => {
  const { resolver } = setup();
  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.personId, null);
  assert.equal(result.reasonCode, 'no_evidence');
});

test('Speaker 0 in two different sessions is never assumed to be the same person', async () => {
  const { resolver } = setup();
  resolver.attribute({ sessionId: 'session_A', speakerLabel: 'Speaker 0', name: 'Matt' });
  const inOtherSession = await resolver.resolve({ sessionId: 'session_B', speakerLabel: 'Speaker 0' });
  assert.equal(inOtherSession.status, 'unknown');
});

test('explicit primary-user attribution ("That was Matt") links a speaker to a person and may confirm a NEW person outright', () => {
  const { resolver, repository } = setup();
  const result = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 1', name: 'Matt' });
  assert.equal(result.status, 'resolved');
  assert.ok(result.personId);
  const person = repository.getPerson(result.personId);
  assert.equal(person.identityStatus, 'confirmed');
  assert.equal(person.displayName, 'Matt');
});

test('a name mention in transcript text does NOT identify the current speaker', async () => {
  const { resolver } = setup();
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' }); // Matt now known
  const result = await resolver.resolve({ sessionId: 's2', speakerLabel: 'Speaker 3', transcriptText: 'Matt said the quote was approved.' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.personId, null);
  assert.equal(result.reasonCode, 'name_mention_not_identity');
});

test('self-identification creates evidence but requires confirmation — never silently resolves session continuity', async () => {
  const { resolver } = setup();
  const result = resolver.selfIdentify({ sessionId: 's1', speakerLabel: 'Speaker 1', name: 'Matt' });
  assert.equal(result.status, 'provisional');
  assert.equal(result.requiresConfirmation, true);
  const followUp = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 1' });
  assert.notEqual(followUp.status, 'resolved'); // no continuity was set
});

test('a confirmed voice match resolves the correct candidate', async () => {
  const { resolver, repository, voiceProvider } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const { voiceProfileId } = await voiceProvider.enroll({ personId: matt.personId, audioRef: { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, consent: true });
  repository.linkVoiceProfile(matt.personId, voiceProfileId);

  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, candidatePersonIds: [matt.personId] });
  assert.equal(result.status, 'resolved');
  assert.equal(result.personId, matt.personId);
  assert.equal(result.reasonCode, 'voice_profile_similarity');
});

test('a medium-confidence voice match remains ambiguous, never silently resolves', async () => {
  const { resolver, repository, voiceProvider } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const { voiceProfileId } = await voiceProvider.enroll({ personId: matt.personId, audioRef: { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, consent: true });
  repository.linkVoiceProfile(matt.personId, voiceProfileId);

  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: { matchKey: 'matt-similar', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, candidatePersonIds: [matt.personId] });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.requiresConfirmation, true);
});

test('a weak voice match produces no resolution', async () => {
  const { resolver, repository, voiceProvider } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const { voiceProfileId } = await voiceProvider.enroll({ personId: matt.personId, audioRef: { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, consent: true });
  repository.linkVoiceProfile(matt.personId, voiceProfileId);

  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: { matchKey: 'nobody', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, candidatePersonIds: [matt.personId] });
  assert.equal(result.status, 'unknown');
});

test('two strong competing candidates remain ambiguous', async () => {
  const { resolver, repository, voiceProvider } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const jon = repository.createPerson({ displayName: 'Jon', identityStatus: 'candidate' }).person;
  const sample = { matchKey: 'shared', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 };
  const mattProfile = await voiceProvider.enroll({ personId: matt.personId, audioRef: sample, consent: true });
  const jonProfile = await voiceProvider.enroll({ personId: jon.personId, audioRef: sample, consent: true });
  repository.linkVoiceProfile(matt.personId, mattProfile.voiceProfileId);
  repository.linkVoiceProfile(jon.personId, jonProfile.voiceProfileId);

  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: sample, candidatePersonIds: [matt.personId, jon.personId] });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reasonCode, 'competing_voice_candidates');
  assert.equal(result.candidateMatches.length, 2);
});

test('manual rejection creates negative evidence and is not immediately re-suggested for the same session/speaker', async () => {
  const { resolver, repository, voiceProvider } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const sample = { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 };
  const profile = await voiceProvider.enroll({ personId: matt.personId, audioRef: sample, consent: true });
  repository.linkVoiceProfile(matt.personId, profile.voiceProfileId);

  const first = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: sample, candidatePersonIds: [matt.personId] });
  assert.equal(first.status, 'resolved');
  resolver.rejectMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: matt.personId });
  const evidence = repository.listEvidenceForPerson(matt.personId);
  assert.ok(evidence.some((e) => e.evidenceType === 'manual_rejection'));

  const second = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', voiceSampleRef: sample, candidatePersonIds: [matt.personId] });
  assert.notEqual(second.personId, matt.personId); // rejected candidate excluded from re-suggestion
});

test('manual correction outranks an earlier resolution and invalidates it', () => {
  const { resolver, repository } = setup();
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const before = resolver.getContinuity('s1', 'Speaker 0');
  const mattId = before.personId;

  const corrected = resolver.correctIdentity({ sessionId: 's1', speakerLabel: 'Speaker 0', correctName: 'Jon' });
  assert.equal(corrected.status, 'resolved');
  assert.notEqual(corrected.personId, mattId);
  assert.equal(corrected.previousPersonId, mattId);

  const evidence = repository.listEvidenceForPerson(mattId);
  assert.ok(evidence.some((e) => e.evidenceType === 'correction'));
  const after = resolver.getContinuity('s1', 'Speaker 0');
  assert.equal(after.personId, corrected.personId);
});

test('within-session speaker continuity is reused without writing new evidence', async () => {
  const { resolver, repository } = setup();
  const result = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const evidenceCountBefore = repository.listEvidenceForPerson(result.personId).length;

  const again = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  assert.equal(again.status, 'resolved');
  assert.equal(again.personId, result.personId);
  assert.equal(again.reasonCode, 'session_continuity');
  assert.equal(repository.listEvidenceForPerson(result.personId).length, evidenceCountBefore); // no duplicate evidence written
});

test('session continuity ends on timeout, and endSession() invalidates it immediately', async () => {
  let clock = 1000;
  const { resolver } = setup({ sessionTimeoutMs: 100, now: () => clock });
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt', time: clock });
  clock += 500; // past the 100ms timeout
  const afterTimeout = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', time: clock });
  assert.notEqual(afterTimeout.reasonCode, 'session_continuity');

  const { resolver: resolver2 } = setup();
  resolver2.attribute({ sessionId: 's2', speakerLabel: 'Speaker 0', name: 'Matt' });
  resolver2.endSession('s2');
  const afterEnd = await resolver2.resolve({ sessionId: 's2', speakerLabel: 'Speaker 0' });
  assert.notEqual(afterEnd.reasonCode, 'session_continuity');
});

test('a provisional person is not automatically confirmed merely by repeated self-identification', () => {
  const { resolver, repository } = setup();
  const first = resolver.selfIdentify({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  resolver.selfIdentify({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  resolver.selfIdentify({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  assert.equal(repository.getPerson(first.personId).identityStatus, 'provisional');
});

test('incidental background speech (no name, no voice sample) creates no durable person', async () => {
  const { repository, resolver } = setup();
  await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 2', transcriptText: 'the weather has been nice lately' });
  assert.equal(repository.listPeople({}).length, 0);
});

test('repeated identical attribution operations do not create duplicate person records (idempotent find-or-create)', () => {
  const { resolver, repository } = setup();
  const a = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const b = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  assert.equal(a.personId, b.personId);
  assert.equal(repository.listPeople({}).length, 1);
});

test('same-name people are never merged automatically — attribution against two existing Matts returns ambiguous', () => {
  const { resolver, repository } = setup();
  repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
  repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
  const result = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidateMatches.length, 2);
  assert.equal(repository.listPeople({}).length, 2); // nothing new created
});

test('a cancelled resolution (aborted signal) returns status "cancelled"', async () => {
  const { resolver } = setup();
  const controller = new AbortController();
  controller.abort();
  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
});

test('a late/stale resolution (isStillCurrent fails) returns status "stale" and is discarded by the caller', async () => {
  const { resolver } = setup();
  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' }, { isStillCurrent: () => false });
  assert.equal(result.status, 'stale');
});

test('confirmMatch upgrades identityStatus to confirmed and sets session continuity', () => {
  const { resolver, repository } = setup();
  const provisional = resolver.selfIdentify({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const confirmed = resolver.confirmMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: provisional.personId });
  assert.equal(confirmed.status, 'resolved');
  assert.equal(repository.getPerson(provisional.personId).identityStatus, 'confirmed');
});

test('invalidateForPerson clears continuity for every session/speaker slot pointing at that person', async () => {
  const { resolver } = setup();
  const a = resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  resolver.attribute({ sessionId: 's2', speakerLabel: 'Speaker 5', name: 'Matt' });
  resolver.invalidateForPerson(a.personId);
  const r1 = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  const r2 = await resolver.resolve({ sessionId: 's2', speakerLabel: 'Speaker 5' });
  assert.notEqual(r1.reasonCode, 'session_continuity');
  assert.notEqual(r2.reasonCode, 'session_continuity');
});
