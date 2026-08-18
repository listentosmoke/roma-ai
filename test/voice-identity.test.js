import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../server/db/index.mjs';
import { createBoundedAudioSampleManager } from '../server/voiceIdentity/audioSampleManager.mjs';
import { createTemplateCipher } from '../server/voiceIdentity/crypto.mjs';
import { cosineSimilarity, createWavlmSpeakerProvider } from '../server/voiceIdentity/provider.mjs';
import { createVoiceIdentityService } from '../server/voiceIdentity/service.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { createSqliteConsentRepository } from '../server/repositories/consentRepository.mjs';
import { bridgeDeepgramClient } from '../server/deepgramProxy.mjs';

function pcm({ durationMs = 400, amplitude = 9000, voicedRatio = 0.85, phase = 0 } = {}) {
  const count = Math.round(16000 * durationMs / 1000);
  const out = Buffer.alloc(count * 2);
  const voiced = Math.round(count * voicedRatio);
  for (let i = 0; i < count; i += 1) {
    const sample = i < voiced ? Math.round(amplitude * Math.sin((2 * Math.PI * 180 * i / 16000) + phase)) : 0;
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function start(manager, overrides = {}) {
  return manager.begin({ workspaceId: 'w1', userId: 'u1', sessionId: 's1', interactionId: 'i1', speakerLabel: 'Speaker 0', personId: 'person_matt', purpose: 'enrollment', operationId: `op_${Math.random()}`, ...overrides });
}

function appendAndFinalize(manager, started, audio) {
  assert.equal(manager.append({ operationId: started.operationId, captureToken: started.captureToken, chunk: audio }).ok, true);
  return manager.finalize(started.operationId, 'w1');
}

test('bounded capture is disabled until an explicit operation exists', () => {
  const manager = createBoundedAudioSampleManager();
  assert.deepEqual(manager.append({ operationId: 'missing', captureToken: 'x', chunk: pcm() }), { ok: false, reasonCode: 'capture_not_found' });
});

test('bounded capture copies PCM and cannot be changed by the caller afterward', () => {
  const manager = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  const started = start(manager);
  const audio = pcm();
  const original = Buffer.from(audio);
  manager.append({ operationId: started.operationId, captureToken: started.captureToken, chunk: audio });
  audio.fill(0);
  assert.equal(manager.finalize(started.operationId, 'w1').ok, true);
  assert.deepEqual(manager.consume(started.operationId, 'w1').pcm, original);
});

test('capture enforces byte and duration limits independently', () => {
  const byteManager = createBoundedAudioSampleManager({ limits: { maxBytes: 100 } });
  const byteOp = start(byteManager);
  assert.equal(byteManager.append({ operationId: byteOp.operationId, captureToken: byteOp.captureToken, chunk: Buffer.alloc(102) }).reasonCode, 'sample_byte_limit_exceeded');

  const durationManager = createBoundedAudioSampleManager({ limits: { minDurationMs: 40, maxDurationMs: 100, maxBytes: 100000 } });
  const durationOp = start(durationManager);
  assert.equal(appendAndFinalize(durationManager, durationOp, pcm({ durationMs: 200 })).reasonCode, 'sample_too_long');
});

test('samples expire and cancelled samples are deleted', () => {
  let now = 100;
  const manager = createBoundedAudioSampleManager({ now: () => now, limits: { operationTtlMs: 50 } });
  const expired = start(manager);
  now = 151;
  assert.equal(manager.get(expired.operationId, 'w1'), null);
  const cancelled = start(manager);
  assert.equal(manager.cancel(cancelled.operationId, 'w1').ok, true);
  assert.equal(manager.get(cancelled.operationId, 'w1'), null);
});

test('operation tokens prevent concurrent samples from mixing', () => {
  const manager = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  const a = start(manager, { operationId: 'a' });
  const b = start(manager, { operationId: 'b' });
  assert.equal(manager.append({ operationId: a.operationId, captureToken: b.captureToken, chunk: pcm() }).ok, false);
  assert.equal(manager.append({ operationId: a.operationId, captureToken: a.captureToken, chunk: pcm() }).ok, true);
  assert.equal(manager.get(b.operationId, 'w1').bytesCaptured, 0);
});

for (const [name, flags, reasonCode] of [
  ['overlapping speakers are rejected', { overlapDetected: true }, 'overlapping_speech_detected'],
  ['Roma speech blocks capture', { romaSpeaking: true }, 'roma_playback_excluded'],
  ['active playback blocks capture', { playbackActive: true }, 'roma_playback_excluded'],
]) {
  test(name, () => {
    const manager = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
    const operation = start(manager, flags);
    assert.equal(appendAndFinalize(manager, operation, pcm()).reasonCode, reasonCode);
  });
}

test('short, silence-dominated, clipped, and low-quality samples are rejected with stable reasons', () => {
  const short = createBoundedAudioSampleManager({ limits: { minDurationMs: 500 } });
  assert.equal(appendAndFinalize(short, start(short), pcm({ durationMs: 200 })).reasonCode, 'sample_too_short');

  const silence = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  assert.equal(appendAndFinalize(silence, start(silence), pcm({ durationMs: 1000, voicedRatio: 0.2 })).reasonCode, 'silence_dominated');

  const clipped = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  assert.equal(appendAndFinalize(clipped, start(clipped), pcm({ amplitude: 32767 })).reasonCode, 'clipped_audio');

  const low = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  assert.equal(appendAndFinalize(low, start(low), pcm({ durationMs: 300, voicedRatio: 0.4, amplitude: 700 })).reasonCode, 'low_quality_sample');
});

test('exact reuse is labeled possible replay without claiming liveness detection', () => {
  const manager = createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } });
  const audio = pcm();
  const first = start(manager);
  assert.equal(appendAndFinalize(manager, first, audio).quality.possibleReplay, false);
  manager.consume(first.operationId, 'w1');
  const second = start(manager);
  const result = appendAndFinalize(manager, second, audio);
  assert.equal(result.quality.possibleReplay, true);
  assert.equal('livenessVerified' in result.quality, false);
});

test('Deepgram forwarding receives the exact same binary frame while capture is active', async () => {
  class FakeUpstream {
    static instance;
    constructor() { this.listeners = {}; this.sent = []; FakeUpstream.instance = this; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send(value) { this.sent.push(value); }
    close() {}
  }
  class FakeClient extends EventEmitter {
    constructor() { super(); this.sent = []; this.readyState = 1; this.OPEN = 1; }
    send(value) { this.sent.push(value); }
    close() {}
  }
  const captured = [];
  const client = new FakeClient();
  bridgeDeepgramClient(client, { url: '/api/deepgram/stream?model=nova-3' }, 'test-key', { warn() {} }, { appendFrame(args) { captured.push(Buffer.from(args.chunk)); return { ok: true }; } }, FakeUpstream);
  FakeUpstream.instance.listeners.open();
  client.emit('message', Buffer.from(JSON.stringify({ type: 'VoiceCaptureStart', operationId: 'op', captureToken: 'token' })), false);
  const frame = Buffer.from([1, 2, 3, 4]);
  client.emit('message', frame, true);
  assert.deepEqual(captured[0], frame);
  assert.equal(FakeUpstream.instance.sent[0], frame);
});

const metadata = { workspaceId: 'w1', personId: 'p1', voiceProfileId: 'v1', provider: 'local_wavlm', model: 'm', modelVersion: 'r:q8', templateVersion: 1 };

test('AES-256-GCM fails closed without a key', () => {
  const cipher = createTemplateCipher({ key: null });
  assert.equal(cipher.configured, false);
  assert.throws(() => cipher.encrypt([1, 0], metadata), /BIOMETRIC_ENCRYPTION_KEY/);
});

test('AES-256-GCM round-trips templates and never reuses a nonce', () => {
  const cipher = createTemplateCipher({ key: Buffer.alloc(32, 7) });
  const a = cipher.encrypt([1, 0], metadata);
  const b = cipher.encrypt([1, 0], metadata);
  assert.notEqual(a.nonce, b.nonce);
  assert.deepEqual([...cipher.decrypt(a, metadata)], [1, 0]);
});

test('authenticated metadata tampering makes decryption fail', () => {
  const cipher = createTemplateCipher({ key: Buffer.alloc(32, 8) });
  const record = cipher.encrypt([1, 0], metadata);
  assert.throws(() => cipher.decrypt(record, { ...metadata, personId: 'attacker' }));
});

test('key rotation re-encrypts under the active key version', () => {
  const oldCipher = createTemplateCipher({ key: Buffer.alloc(32, 1), keyVersion: 1 });
  const oldRecord = oldCipher.encrypt([0.5, -0.5], metadata);
  const rotating = createTemplateCipher({ key: Buffer.alloc(32, 2), keyVersion: 2, keyring: { 1: Buffer.alloc(32, 1) } });
  const rotated = rotating.rotate(oldRecord, metadata);
  assert.equal(rotated.keyVersion, 2);
  assert.deepEqual([...rotating.decrypt(rotated, metadata)], [0.5, -0.5]);
});

test('provider scores remain similarities, not fake calibrated probabilities', () => {
  const provider = createWavlmSpeakerProvider();
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);
  assert.equal(provider.compareTemplates({ template: [1, 0], profileTemplate: [1, 0], quality: 1 }).calibratedConfidence, null);
  assert.equal(provider.compareTemplates({ template: [1, 0], profileTemplate: [0, 1], quality: 1 }).decision, 'non_match');
});

test('verification candidate and ambiguity decisions use provider-specific thresholds', () => {
  const provider = createWavlmSpeakerProvider();
  const candidate = provider.compareTemplates({ template: [1, 0], profileTemplate: [0.82, Math.sqrt(1 - 0.82 ** 2)], quality: 1 });
  assert.equal(candidate.decision, 'candidate');
  const identified = provider.identifyTemplates({ template: [1, 0], quality: 1, candidateProfiles: [
    { voiceProfileId: 'v1', personId: 'p1', template: [0.90, Math.sqrt(1 - 0.90 ** 2)] },
    { voiceProfileId: 'v2', personId: 'p2', template: [0.88, Math.sqrt(1 - 0.88 ** 2)] },
  ] });
  assert.equal(identified.decision, 'ambiguous');
});

test('identification candidate sets and provider work queues are bounded', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const runtimeLoader = async () => ({
    AutoProcessor: { from_pretrained: async () => (audio) => ({ input_values: audio }) },
    AutoModel: { from_pretrained: async () => async () => { await waiting; return { embeddings: { data: [1, 0] } }; } },
  });
  const provider = createWavlmSpeakerProvider({ maxQueue: 1, runtimeLoader });
  const first = provider.extractTemplate({ pcm: Buffer.alloc(320), quality: 1 });
  const second = await provider.extractTemplate({ pcm: Buffer.alloc(320), quality: 1 });
  assert.equal(second.reasonCode, 'provider_queue_full');
  release();
  assert.equal((await first).ok, true);
  const profiles = Array.from({ length: 20 }, (_, i) => ({ voiceProfileId: `v${i}`, personId: `p${i}`, template: [1, 0] }));
  assert.equal(provider.identifyTemplates({ template: [1, 0], candidateProfiles: profiles }).candidateCount, 12);
});

function createFakeProvider() {
  const thresholds = { strongMatch: 0.86, candidate: 0.80, nonMatch: 0.65, ambiguityMargin: 0.04, minQuality: 0.55, maxCandidates: 12 };
  return {
    thresholds,
    async extractTemplate({ pcm: audio, quality }) {
      return { ok: true, template: new Float32Array([1, audio.readInt16LE(0) / 32768]), dimensions: 2, quality, provider: 'fixture_real_path', model: 'fixture-speaker-encoder', modelRevision: '1', modelVersion: '1:q8', templateVersion: 1, latencyMs: 2 };
    },
    compareTemplates({ template, profileTemplate, quality }) {
      const score = cosineSimilarity(template, profileTemplate);
      return { ok: true, score, similarity: score, quality, calibratedConfidence: null, decision: score >= 0.86 ? 'match' : score >= 0.80 ? 'candidate' : 'non_match', reasonCode: score >= 0.86 ? 'strong_similarity' : 'different_speaker' };
    },
    identifyTemplates({ template, candidateProfiles, quality }) {
      const matches = candidateProfiles.slice(0, 12).map((profile) => ({ ...this.compareTemplates({ template, profileTemplate: profile.template, quality }), personId: profile.personId, voiceProfileId: profile.voiceProfileId })).sort((a, b) => b.score - a.score);
      return { ok: true, matches, candidateCount: matches.length, decision: matches[0]?.decision ?? 'non_match', reasonCode: matches[0]?.reasonCode ?? 'no_candidates' };
    },
    getProviderStatus: () => ({ available: true, mode: 'local_real', provider: 'fixture_real_path', model: 'fixture-speaker-encoder', modelVersion: '1:q8' }),
    warmup: async () => ({ ok: true }),
  };
}

function serviceFixture() {
  const db = openDatabase({ memory: true });
  const identityRepository = createSqliteIdentityRepository({ db });
  const consentRepository = createSqliteConsentRepository({ db });
  const repositories = { identityRepository, consentRepository };
  const service = createVoiceIdentityService({ sampleManager: createBoundedAudioSampleManager({ limits: { minDurationMs: 100 } }), provider: createFakeProvider(), cipher: createTemplateCipher({ key: Buffer.alloc(32, 4) }) });
  service.configure({ database: db, dataRepositories: repositories });
  const principal = { workspaceId: 'w1', userId: 'u1' };
  const identity = identityRepository.forWorkspace('w1', 'u1');
  const person = identity.createPerson({ personId: 'person_matt', displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const consent = consentRepository.forWorkspace('w1', 'u1').grant({ personId: person.personId, scope: 'voice_identity', purpose: 'Conversational recognition only', provider: 'fixture_real_path' }).consent;
  return { db, service, principal, identity, consentRepository: consentRepository.forWorkspace('w1', 'u1'), person, consent };
}

async function capture(service, principal, { purpose = 'enrollment', personId = 'person_matt', consentId, operationId = `op_${Math.random()}`, candidatePersonIds = [], phase = 0, flags = {} } = {}) {
  const started = service.beginCapture(principal, { purpose, personId, consentId, operationId, candidatePersonIds, sessionId: 'session_1', interactionId: operationId, speakerLabel: 'Speaker 0', ...flags });
  if (!started.ok) return started;
  service.appendFrame({ operationId, captureToken: started.captureToken, chunk: pcm({ phase }) });
  return started;
}

test('service requires an existing person and active explicit consent', () => {
  const fixture = serviceFixture();
  assert.equal(fixture.service.beginCapture(fixture.principal, { purpose: 'enrollment', personId: 'missing', consentId: fixture.consent.consentId, sessionId: 's' }).reasonCode, 'person_not_found');
  assert.equal(fixture.service.beginCapture(fixture.principal, { purpose: 'enrollment', personId: fixture.person.personId, sessionId: 's' }).reasonCode, 'active_consent_required');
  fixture.consentRepository.revoke(fixture.consent.consentId);
  assert.equal(fixture.service.beginCapture(fixture.principal, { purpose: 'enrollment', personId: fixture.person.personId, consentId: fixture.consent.consentId, sessionId: 's' }).reasonCode, 'active_consent_required');
  fixture.db.close();
});

test('successful enrollment stores only an encrypted template and safe API metadata', async () => {
  const fixture = serviceFixture();
  const started = await capture(fixture.service, fixture.principal, { consentId: fixture.consent.consentId, operationId: 'enroll_1' });
  const result = await fixture.service.finalizeEnrollment(fixture.principal, started.operationId);
  assert.equal(result.ok, true);
  assert.equal('encrypted' in result.profile, false);
  assert.equal('template' in result.profile, false);
  const row = fixture.db.prepare('SELECT * FROM voice_templates').get();
  assert.equal(row.encryption_algorithm, 'aes-256-gcm');
  assert.notEqual(row.encrypted_template, Buffer.from(new Float32Array([1, 0]).buffer).toString('base64'));
  assert.equal(fixture.identity.getPerson(fixture.person.personId).voiceProfileIds.length, 1);
  fixture.db.close();
});

test('duplicate enrollment operation IDs replay one mutation rather than creating another profile', async () => {
  const fixture = serviceFixture();
  const started = await capture(fixture.service, fixture.principal, { consentId: fixture.consent.consentId, operationId: 'idempotent' });
  const first = await fixture.service.finalizeEnrollment(fixture.principal, started.operationId);
  const second = await fixture.service.finalizeEnrollment(fixture.principal, started.operationId);
  assert.equal(second.profile.voiceProfileId, first.profile.voiceProfileId);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM voice_templates').get().n, 1);
  fixture.db.close();
});

test('matching skips empty candidates and cannot see another tenant template', async () => {
  const fixture = serviceFixture();
  const started = await capture(fixture.service, fixture.principal, { purpose: 'identification', consentId: fixture.consent.consentId, operationId: 'no_candidates', candidatePersonIds: [], phase: 0.2 });
  assert.equal((await fixture.service.finalizeMatch(fixture.principal, started.operationId)).reasonCode, 'no_relevant_candidates');
  assert.equal(fixture.service.listProfiles({ workspaceId: 'w2', userId: 'u2' }, fixture.person.personId).length, 0);
  fixture.db.close();
});

test('strong voice results enter Entity Resolver and create biometric voice_match evidence', async () => {
  const fixture = serviceFixture();
  const enrollment = await capture(fixture.service, fixture.principal, { consentId: fixture.consent.consentId, operationId: 'enroll_match' });
  await fixture.service.finalizeEnrollment(fixture.principal, enrollment.operationId);
  const match = await capture(fixture.service, fixture.principal, { purpose: 'verification', consentId: fixture.consent.consentId, operationId: 'verify_match', candidatePersonIds: [fixture.person.personId], phase: 0.3 });
  const result = await fixture.service.finalizeMatch(fixture.principal, match.operationId);
  assert.equal(result.ok, true);
  assert.equal(result.resolution.status, 'resolved');
  const evidence = fixture.identity.listEvidenceForPerson(fixture.person.personId).find((item) => item.evidenceType === 'voice_match');
  assert.equal(evidence.sensitivity, 'biometric');
  assert.equal(evidence.voiceSampleRef, 'verify_match');
  fixture.db.close();
});

test('revocation immediately removes candidates and deletion preserves the person', async () => {
  const fixture = serviceFixture();
  const enrollment = await capture(fixture.service, fixture.principal, { consentId: fixture.consent.consentId, operationId: 'enroll_revoke' });
  const enrolled = await fixture.service.finalizeEnrollment(fixture.principal, enrollment.operationId);
  fixture.consentRepository.revoke(fixture.consent.consentId);
  assert.equal(fixture.service.revokeConsent(fixture.principal, fixture.consent.consentId).revoked, 1);
  assert.equal(fixture.service.listProfiles(fixture.principal, fixture.person.personId)[0].status, 'revoked');
  assert.equal(fixture.service.deleteProfile(fixture.principal, enrolled.profile.voiceProfileId).ok, true);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM voice_templates').get().n, 0);
  assert.equal(fixture.identity.getPerson(fixture.person.personId).status, 'active');
  fixture.db.close();
});

test('late identity results are discarded before they can resolve a person', async () => {
  const fixture = serviceFixture();
  const enrollment = await capture(fixture.service, fixture.principal, { consentId: fixture.consent.consentId, operationId: 'enroll_stale' });
  await fixture.service.finalizeEnrollment(fixture.principal, enrollment.operationId);
  const match = await capture(fixture.service, fixture.principal, { purpose: 'verification', consentId: fixture.consent.consentId, operationId: 'verify_stale', candidatePersonIds: [fixture.person.personId], phase: 0.4 });
  const result = await fixture.service.finalizeMatch(fixture.principal, match.operationId, { isStillCurrent: () => false });
  assert.equal(result.reasonCode, 'stale_identity_result');
  fixture.db.close();
});

test('no biometric template or server key identifier appears in the production browser bundle', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = await readdir(new URL('../dist/assets/', import.meta.url));
  const js = (await Promise.all(files.filter((file) => file.endsWith('.js')).map((file) => readFile(new URL(`../dist/assets/${file}`, import.meta.url), 'utf8')))).join('\n');
  assert.equal(js.includes('BIOMETRIC_ENCRYPTION_KEY'), false);
  assert.equal(js.includes('encrypted_template'), false);
});
