// F3 — face evidence inside the identity resolver.
//
// The rule this file exists to pin down: Roma is WORN. Her camera looks
// outward, so a face answers "who is present", while resolve() is asking "who
// is speaking". Face evidence may therefore corroborate a voice match or
// contradict it, but it must never promote a resolution on its own, never
// break a voice tie, and never override something a human actually said.
//
// See PLAN-FACE-IDENTITY.md "F3 — evidence and resolution".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';
import { createEntityResolver, RESOLUTION_THRESHOLDS } from '../src/identity/resolver.js';

const SAMPLE = (matchKey) => ({ matchKey, durationMs: 4000, quality: 0.9, speakerPurity: 0.95 });

function setup() {
  const repository = createInMemoryIdentityRepository();
  const voiceProvider = createDeterministicVoiceProvider();
  const resolver = createEntityResolver({ repository, voiceProvider });
  return { repository, voiceProvider, resolver };
}

/** A person with an enrolled voice, so the voice path can actually run. */
async function withVoice({ repository, voiceProvider }, displayName, matchKey) {
  const person = repository.createPerson({ displayName, identityStatus: 'candidate' }).person;
  const { voiceProfileId } = await voiceProvider.enroll({ personId: person.personId, audioRef: SAMPLE(matchKey), consent: true });
  repository.linkVoiceProfile(person.personId, voiceProfileId);
  return person;
}

const seen = (personId, similarity = 0.8, quality = 0.9) => ({ personId, faceProfileId: `face_${personId}`, similarity, quality });

// ── the ordinary case: a face with nobody speaking to corroborate ──────────

test('seeing someone is presence, not speech — a face alone never resolves the speaker', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', faceObservations: [seen(matt.personId, 0.9)] });

  assert.equal(result.status, 'unknown');
  assert.equal(result.personId, null, 'the person in frame is usually the one being spoken TO');
  assert.equal(result.reasonCode, 'face_presence_not_speaker');
  assert.deepEqual(result.presentPersonIds, [matt.personId], 'presence is still reported, just not as identity');
});

test('a face sighting is recorded as face_match evidence, with its profile reference', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', faceObservations: [seen(matt.personId, 0.77)] });

  const [evidence] = repository.listEvidenceForPerson(matt.personId);
  assert.equal(evidence.evidenceType, 'face_match');
  assert.equal(evidence.decision, 'context_only');
  assert.equal(evidence.faceProfileId, `face_${matt.personId}`);
  assert.equal(evidence.sensitivity, 'biometric');
  assert.equal(evidence.score, 0.77);
});

test('a face never sets session continuity, so it cannot quietly persist as an answer', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', faceObservations: [seen(matt.personId, 0.95)] });

  assert.equal(resolver.getContinuity('s1', 'Speaker 0'), null);
});

// ── quality and threshold gating ───────────────────────────────────────────

test('a low-quality sighting is not evidence about who anyone is', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  // The server reports quality 0 for a face its own gate judged unusable —
  // too small, too dim, or turned away (server/faceIdentity/service.mjs).
  const result = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0', faceObservations: [seen(matt.personId, 0.95, 0)] });

  assert.equal(result.reasonCode, 'no_evidence');
  assert.deepEqual(result.presentPersonIds, []);
  assert.equal(repository.listEvidenceForPerson(matt.personId).length, 0, 'an unusable frame writes nothing');
});

test('a similarity below the service threshold is dropped rather than recorded as a weak opinion', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [seen(matt.personId, RESOLUTION_THRESHOLDS.mediumFaceMatch - 0.01)],
  });

  assert.equal(result.reasonCode, 'no_evidence');
  assert.equal(repository.listEvidenceForPerson(matt.personId).length, 0);
});

test('repeat sightings of one person collapse to their best observation', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [seen(matt.personId, 0.61), seen(matt.personId, 0.83), seen(matt.personId, 0.7)],
  });

  assert.deepEqual(result.presentPersonIds, [matt.personId]);
  const evidence = repository.listEvidenceForPerson(matt.personId);
  assert.equal(evidence.length, 1, 'one person seen three times is one observation, not three');
  assert.equal(evidence[0].score, 0.83);
});

// ── cross-modal: agreement ────────────────────────────────────────────────

test('face and voice agreeing resolves, and says so in the reason code', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    faceObservations: [seen(matt.personId, 0.88)],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.personId, matt.personId);
  assert.equal(result.reasonCode, 'cross_modal_agreement');
  assert.equal(result.evidenceIds.length, 2, 'both modalities are recorded, not just the winner');

  const types = fixture.repository.listEvidenceForPerson(matt.personId).map((e) => e.evidenceType);
  assert.ok(types.includes('voice_match') && types.includes('face_match'));
});

test('a strong voice with no camera on still resolves exactly as it always did', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    faceObservations: [],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.reasonCode, 'voice_profile_similarity');
});

// ── cross-modal: disagreement ─────────────────────────────────────────────

test('face and voice disagreeing resolves to UNKNOWN — never to the higher score', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');
  const jon = fixture.repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),          // the voice says Matt…
    faceObservations: [seen(jon.personId, 0.93)], // …the camera is confident about Jon
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.personId, null);
  assert.equal(result.reasonCode, 'cross_modal_disagreement');
  assert.equal(result.requiresConfirmation, true, 'a human can settle it');
  assert.deepEqual(result.candidateMatches.map((c) => c.personId).sort(), [jon.personId, matt.personId].sort());
});

test('a disagreement keeps BOTH readings as candidates, so the conflict stays inspectable', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');
  const jon = fixture.repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    faceObservations: [seen(jon.personId, 0.93)],
    candidatePersonIds: [matt.personId],
  });

  const voiceEvidence = fixture.repository.listEvidenceForPerson(matt.personId).at(-1);
  const faceEvidence = fixture.repository.listEvidenceForPerson(jon.personId).at(-1);
  assert.equal(voiceEvidence.decision, 'candidate');
  assert.equal(voiceEvidence.reasonCode, 'cross_modal_disagreement');
  assert.equal(faceEvidence.decision, 'candidate');
  assert.equal(faceEvidence.reasonCode, 'cross_modal_disagreement');
});

test('a disagreement leaves no continuity behind — the next turn starts clean', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');
  const jon = fixture.repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    faceObservations: [seen(jon.personId, 0.93)],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(fixture.resolver.getContinuity('s1', 'Speaker 0'), null);
});

test('a face that is merely present, below the strong threshold, does not veto a voice match', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');
  const jon = fixture.repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    // Above the service's own gate, below `strongFaceMatch`: enough to note
    // that Jon was in shot, not enough to overrule who was heard speaking.
    faceObservations: [seen(jon.personId, RESOLUTION_THRESHOLDS.strongFaceMatch - 0.05)],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.personId, matt.personId);
});

// ── a face may not break a tie ────────────────────────────────────────────

test('a face does NOT settle an ambiguous voice match, even when it agrees with one candidate', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt-similar'),   // medium confidence only
    faceObservations: [seen(matt.personId, 0.95)],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.candidateMatches.some((c) => c.reasonCodes.includes('face_profile_similarity')), 'the sighting is still on the record');
});

// ── nothing about a face outranks a person's own words ────────────────────

test('a face cannot override a manual confirmation', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  const jon = repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;
  resolver.confirmMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: matt.personId });

  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [seen(jon.personId, 0.99)],
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.personId, matt.personId, 'the confirmation stands');
  assert.equal(result.reasonCode, 'session_continuity');
  assert.deepEqual(result.presentPersonIds, [jon.personId], 'Jon is reported as present, not as the speaker');
});

test('a face cannot override a correction, even a very confident one', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const corrected = resolver.correctIdentity({ sessionId: 's1', speakerLabel: 'Speaker 0', correctName: 'Jon' });

  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [seen(matt.personId, 0.99)],
  });

  assert.equal(result.personId, corrected.personId, 'still Jon');
  assert.notEqual(result.personId, matt.personId);
});

test('a rejected suggestion cannot come back through the camera', async () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'candidate' }).person;
  resolver.rejectMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: matt.personId });

  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [seen(matt.personId, 0.99)],
  });

  assert.deepEqual(result.presentPersonIds, [], 'a rejected person is not even reported as present for this speaker');
  assert.equal(result.reasonCode, 'no_evidence');
});

test('a rejected person cannot veto a voice match either', async () => {
  const fixture = setup();
  const matt = await withVoice(fixture, 'Matt', 'matt');
  const jon = fixture.repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;
  fixture.resolver.rejectMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: jon.personId });

  const result = await fixture.resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    voiceSampleRef: SAMPLE('matt'),
    faceObservations: [seen(jon.personId, 0.99)],
    candidatePersonIds: [matt.personId],
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.personId, matt.personId);
});

// ── malformed input ───────────────────────────────────────────────────────

test('malformed face observations are ignored rather than trusted', async () => {
  const { resolver } = setup();
  const result = await resolver.resolve({
    sessionId: 's1', speakerLabel: 'Speaker 0',
    faceObservations: [null, {}, { personId: '' }, { personId: 'p1', similarity: 'very high', quality: 0.9 }, { personId: 'p2', similarity: 0.9 }],
  });
  assert.deepEqual(result.presentPersonIds, [], 'a missing quality is unusable, not perfect');
  assert.equal(result.reasonCode, 'no_evidence');
});

// ── the path real voice identity actually takes ───────────────────────────
//
// resolve()'s voice branch is unreachable in the running app: the browser has
// no bounded raw-audio pipeline, so runtime.js always passes voiceSampleRef:
// null. Real voice matches arrive through acceptServerResolution instead. The
// cross-modal rule therefore has to hold HERE, or it is true in tests and
// false in production — which is exactly what it was.

function serverResolution(personId) {
  return { sessionId: 's1', speakerLabel: 'Speaker 0', personId, evidenceIds: ['evidence_voice_1'], status: 'resolved' };
}

test('a server voice resolution is adopted when the camera agrees, and says so', () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  const result = resolver.acceptServerResolution({ ...serverResolution(matt.personId), faceObservations: [seen(matt.personId, 0.9)] });

  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, 'cross_modal_agreement');
  assert.equal(resolver.getContinuity('s1', 'Speaker 0').personId, matt.personId);
  const evidence = repository.listEvidenceForPerson(matt.personId).at(-1);
  assert.equal(evidence.evidenceType, 'face_match');
  assert.equal(evidence.decision, 'resolved');
});

test('a server voice resolution is REFUSED when the camera is confident about someone else', () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const jon = repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  const result = resolver.acceptServerResolution({ ...serverResolution(matt.personId), faceObservations: [seen(jon.personId, 0.93)] });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'cross_modal_disagreement');
  assert.equal(result.contradictedBy, jon.personId);
  assert.equal(resolver.getContinuity('s1', 'Speaker 0'), null, 'nothing is adopted on a disagreement');
  assert.equal(repository.listEvidenceForPerson(jon.personId).at(-1).reasonCode, 'cross_modal_disagreement');
});

test('a server voice resolution with no camera on behaves exactly as before', () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;

  const result = resolver.acceptServerResolution(serverResolution(matt.personId));

  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, 'voice_profile_similarity');
  assert.equal(resolver.getContinuity('s1', 'Speaker 0').personId, matt.personId);
});

test('a merely-present face does not veto a server voice resolution', () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const jon = repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;

  const result = resolver.acceptServerResolution({
    ...serverResolution(matt.personId),
    faceObservations: [seen(jon.personId, RESOLUTION_THRESHOLDS.strongFaceMatch - 0.05)],
  });

  assert.equal(result.ok, true, 'someone in shot is usually the person being spoken TO');
});

test('a rejected person cannot block a server voice resolution through the camera', () => {
  const { resolver, repository } = setup();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const jon = repository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;
  resolver.rejectMatch({ sessionId: 's1', speakerLabel: 'Speaker 0', personId: jon.personId });

  const result = resolver.acceptServerResolution({ ...serverResolution(matt.personId), faceObservations: [seen(jon.personId, 0.99)] });

  assert.equal(result.ok, true);
});
