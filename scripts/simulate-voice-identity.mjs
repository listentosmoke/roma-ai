#!/usr/bin/env node
// Fixture-backed end-to-end voice-identity verification. This uses actual
// recorded speech and the pinned local WavLM encoder through the production
// Audio Sample Manager -> encryption -> SQLite -> Entity Resolver path. It is
// not a physical-microphone or liveness test.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteIdentityRepository } from '../server/repositories/identityRepository.mjs';
import { createSqliteConsentRepository } from '../server/repositories/consentRepository.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';
import { createBoundedAudioSampleManager } from '../server/voiceIdentity/audioSampleManager.mjs';
import { createTemplateCipher } from '../server/voiceIdentity/crypto.mjs';
import { createWavlmSpeakerProvider } from '../server/voiceIdentity/provider.mjs';
import { createVoiceIdentityService } from '../server/voiceIdentity/service.mjs';
import { assembleContext } from '../src/agent/prompt.js';

const fixturePath = join(process.cwd(), '.testdata', 'conversation.m4a');

const temp = join(tmpdir(), `roma-voice-identity-${process.pid}`);
mkdirSync(temp, { recursive: true });

const ffmpegAvailable = (() => {
  try { return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
})();

function extract(name, start, duration) {
  const path = join(temp, `${name}.pcm`);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(duration), '-i', fixturePath, '-ac', '1', '-ar', '16000', '-f', 's16le', path, '-y'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture decode failed: ${result.stderr}`);
  return readFileSync(path);
}

// Pre-extracted PCM fixtures (mono s16le @16kHz, cut from the same
// conversation recording) — the fallback when ffmpeg is not installed, so
// the simulation stays runnable everywhere. Same speakers, near-identical
// windows; absolute similarity scores can differ slightly from an
// ffmpeg-fresh extraction, but every check asserts relative behavior.
const BYTES_PER_SECOND = 16000 * 2;
function cachedClip(file, seconds) {
  const path = join(process.cwd(), '.testdata', file);
  if (!existsSync(path)) throw new Error(`Neither ffmpeg nor the cached PCM fixture ${file} is available — install ffmpeg or restore .testdata/.`);
  return readFileSync(path).subarray(0, seconds * BYTES_PER_SECOND);
}

let clips;
if (ffmpegAvailable && existsSync(fixturePath)) {
  clips = {
    tooShort: extract('short', 140, 1),
    danEnroll: extract('dan-enroll', 140, 8),
    danMatch: extract('dan-match', 150, 8),
    danAlternate: extract('dan-alternate', 160, 8),
    danRetry: extract('dan-retry', 135, 4),
    vanessa: extract('vanessa', 30, 8),
  };
} else {
  console.log('  (ffmpeg unavailable — using the pre-extracted .testdata PCM fixtures)');
  // Measured pairwise WavLM similarities (2026-07): dan-c↔dan-d 0.9722
  // (strong same-speaker), dan-c↔dan-b 0.9759, dan-d↔dan-b 0.9658 (within
  // the 0.04 ambiguity margin of dan-d↔dan-c — required by the ambiguity
  // check), dan-c↔vanessa 0.5525 (non-match). dan-a is the documented
  // false-rejection window (0.5709 vs dan-b) and is used only as the
  // too-short reject clip.
  clips = {
    tooShort: cachedClip('dan-a.pcm', 1),
    danEnroll: cachedClip('dan-c.pcm', 8),
    danMatch: cachedClip('dan-d.pcm', 8),
    danAlternate: cachedClip('dan-b.pcm', 8),
    danRetry: cachedClip('dan-d.pcm', 4),
    vanessa: cachedClip('vanessa.pcm', 8),
  };
}

const checks = [];
function check(label, condition, details = '') {
  assert.ok(condition, label);
  checks.push(label);
  console.log(`  PASS ${String(checks.length).padStart(2, '0')}  ${label}${details ? ` (${details})` : ''}`);
}

const db = openDatabase({ memory: true });
const identityRepository = createSqliteIdentityRepository({ db });
const consentRepository = createSqliteConsentRepository({ db });
const memoryRepository = createSqliteMemoryRepository({ db });
const repositories = { identityRepository, consentRepository };
const provider = createWavlmSpeakerProvider();
const service = createVoiceIdentityService({
  sampleManager: createBoundedAudioSampleManager(),
  provider,
  cipher: createTemplateCipher({ key: randomBytes(32), keyVersion: 1 }),
});
service.configure({ database: db, dataRepositories: repositories });
const principal = { workspaceId: 'sim_workspace', userId: 'sim_user' };
const people = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
const consents = consentRepository.forWorkspace(principal.workspaceId, principal.userId);
const memories = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);

const matt = people.createPerson({ personId: 'person_matt', displayName: 'Matt', identityStatus: 'confirmed' }).person;
memories.create({ memoryId: 'memory_matt_project', type: 'fact', subjectId: matt.personId, predicate: 'project', summary: 'Matt is working on Roma voice identity.', confidence: 1, importance: 0.8, sensitivity: 'normal', source: { evidenceType: 'user_stated' } });
check('Matt exists as a confirmed person without a profile', matt.identityStatus === 'confirmed' && matt.voiceProfileIds.length === 0);

const purpose = 'Conversational speaker recognition only; probabilistic evidence, not authentication.';
console.log(`  CONSENT scope=voice_identity purpose="${purpose}"`);
check('enrollment purpose and consent scope are explicit', purpose.includes('not authentication'));
const mattConsent = consents.grant({ personId: matt.personId, scope: 'voice_identity', purpose, provider: 'local_wavlm' }).consent;
check('consent is active before enrollment', mattConsent.status === 'active');

async function runCapture({ operationId, purpose: capturePurpose, personId, consentId, sessionId, speakerLabel, audio, candidatePersonIds = [], flags = {}, finalize = 'enroll', allowPossibleReplay = false }) {
  const started = service.beginCapture(principal, { operationId, purpose: capturePurpose, personId, consentId, sessionId, interactionId: operationId, speakerLabel, candidatePersonIds, ...flags });
  if (!started.ok) return started;
  const appended = service.appendFrame({ operationId, captureToken: started.captureToken, chunk: audio });
  if (!appended.ok) return appended;
  if (finalize === 'enroll') return service.finalizeEnrollment(principal, operationId);
  if (finalize === 'match') return service.finalizeMatch(principal, operationId, { allowPossibleReplay });
  return started;
}

const short = await runCapture({ operationId: 'short', purpose: 'enrollment', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'enroll_session', speakerLabel: 'Speaker 0', audio: clips.tooShort });
check('too-short enrollment is rejected', short.reasonCode === 'sample_too_short', short.reasonCode);
const playback = await runCapture({ operationId: 'playback', purpose: 'enrollment', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'enroll_session', speakerLabel: 'Speaker 0', audio: clips.danEnroll, flags: { playbackActive: true } });
check('Roma playback contamination is rejected', playback.reasonCode === 'roma_playback_excluded', playback.reasonCode);

const enrollment = await runCapture({ operationId: 'matt_enrollment', purpose: 'enrollment', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'enroll_session', speakerLabel: 'Speaker 0', audio: clips.danEnroll });
check('real WavLM extraction enrolls the passing sample', enrollment.ok && enrollment.profile.model.includes('wavlm'), `${enrollment.providerLatencyMs}ms`);
check('template metadata is biometric and server-safe', enrollment.profile.sensitivity === 'biometric' && !('template' in enrollment.profile) && !('encrypted' in enrollment.profile));
const templateRow = db.prepare('SELECT * FROM voice_templates WHERE voice_profile_id = ?').get(enrollment.profile.voiceProfileId);
check('SQLite stores AES-GCM ciphertext only', templateRow.encryption_algorithm === 'aes-256-gcm' && templateRow.encrypted_template.length > 100);
check('plaintext template columns do not exist', !Object.keys(templateRow).some((key) => /plaintext|embedding|raw_audio/i.test(key)));

const matched = await runCapture({ operationId: 'matt_match', purpose: 'verification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'conversation_session', speakerLabel: 'Speaker 7', audio: clips.danMatch, candidatePersonIds: [matt.personId], finalize: 'match' });
const sameScore = matched.matches?.[0]?.score;
check('same-speaker fixture strongly matches Matt', matched.decision === 'match' && sameScore >= provider.thresholds.strongMatch, `score=${sameScore?.toFixed(4)}`);
check('voice-match evidence enters the Entity Resolver', matched.resolution.status === 'resolved' && matched.resolution.evidenceIds.length === 1, matched.resolution.evidenceIds[0]);
check('stable person resolution is Matt', matched.resolution.personId === matt.personId);

const continuity = service.beginCapture(principal, { operationId: 'continuity_skip', purpose: 'identification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'conversation_session', interactionId: 'continuity_skip', speakerLabel: 'Speaker 7', candidatePersonIds: [matt.personId] });
check('valid session continuity skips redundant encoding', continuity.skipped && continuity.reasonCode === 'session_continuity_active');

const context = assembleContext({
  currentTurn: { speaker: 'Speaker 7', text: 'What are we working on?', at: Date.now() },
  transcriptWindow: [], toolResults: [], tools: [],
  currentSpeaker: { ...matched.resolution, person: { personId: matt.personId, displayName: matt.displayName, identityStatus: matt.identityStatus, confidence: matt.confidence } },
}).messages.map((message) => message.content).join('\n');
check('Context Compiler receives bounded Matt resolution metadata', context.includes('Matt [person_matt]') && context.includes('voice_profile_similarity'));
check('template and ciphertext never enter model context', !context.includes(templateRow.encrypted_template) && !/embedding|encrypted_template/i.test(context));

const wrong = await runCapture({ operationId: 'wrong_speaker', purpose: 'verification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'wrong_session', speakerLabel: 'Speaker 2', audio: clips.vanessa, candidatePersonIds: [matt.personId], finalize: 'match' });
const differentScore = wrong.matches?.[0]?.score;
check('different speaker does not resolve to Matt', wrong.resolution.status === 'unknown' && wrong.decision === 'non_match', `score=${differentScore?.toFixed(4)}`);

const alex = people.createPerson({ personId: 'person_alex', displayName: 'Alex', identityStatus: 'confirmed' }).person;
const alexConsent = consents.grant({ personId: alex.personId, scope: 'voice_identity', purpose, provider: 'local_wavlm' }).consent;
const alexEnrollment = await runCapture({ operationId: 'alex_enrollment', purpose: 'enrollment', personId: alex.personId, consentId: alexConsent.consentId, sessionId: 'alex_enroll', speakerLabel: 'Speaker 9', audio: clips.danAlternate });
check('second candidate has a separate encrypted profile', alexEnrollment.ok && alexEnrollment.profile.voiceProfileId !== enrollment.profile.voiceProfileId);
const ambiguous = await runCapture({ operationId: 'ambiguous_match', purpose: 'identification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'ambiguous_session', speakerLabel: 'Speaker 5', audio: clips.danMatch, candidatePersonIds: [matt.personId, alex.personId], finalize: 'match', allowPossibleReplay: true });
check('two close candidates remain ambiguous', ambiguous.decision === 'ambiguous' && ambiguous.resolution.status === 'ambiguous');
check('ambiguous interaction can proceed unresolved', ambiguous.resolution.personId == null && ambiguous.resolution.requiresConfirmation);

const replay = await runCapture({ operationId: 'replay_match', purpose: 'verification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'replay_session', speakerLabel: 'Speaker 7', audio: clips.danEnroll, candidatePersonIds: [matt.personId], finalize: 'match' });
check('exact recent audio reuse requires confirmation', replay.reasonCode === 'possible_replay' && replay.requiresConfirmation === true);
check('replay warning does not claim verified liveness', !JSON.stringify(replay).includes('livenessVerified'));

const rejection = service.rejectResolution(principal, { sessionId: 'ambiguous_session', interactionId: 'ambiguous_match', speakerLabel: 'Speaker 5', personId: alex.personId });
check('manual candidate rejection is recorded', rejection.status === 'rejected' && rejection.evidenceIds.length === 1);
const retry = await runCapture({ operationId: 'after_rejection', purpose: 'identification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'ambiguous_session', speakerLabel: 'Speaker 5', audio: clips.danRetry, candidatePersonIds: [matt.personId, alex.personId], finalize: 'match' });
check('rejected candidate is not immediately reused', retry.resolution.personId !== alex.personId);

consents.revoke(mattConsent.consentId);
const revoked = service.revokeConsent(principal, mattConsent.consentId);
check('consent revocation disables Matt profile', revoked.revoked === 1 && service.listProfiles(principal, matt.personId)[0].status === 'revoked');
const afterRevocation = service.beginCapture(principal, { operationId: 'after_revoke', purpose: 'identification', personId: matt.personId, consentId: mattConsent.consentId, sessionId: 'conversation_session', interactionId: 'after_revoke', speakerLabel: 'Speaker 7', candidatePersonIds: [matt.personId] });
check('revocation invalidates voice-derived continuity', afterRevocation.reasonCode === 'active_consent_required');
check('revoked profile is excluded from active candidate storage', db.prepare("SELECT COUNT(*) AS n FROM voice_templates WHERE person_id=? AND status='active'").get(matt.personId).n === 0);

const deleted = service.deleteProfile(principal, enrollment.profile.voiceProfileId);
check('encrypted Matt template is hard-deleted', deleted.ok && !db.prepare('SELECT 1 FROM voice_templates WHERE voice_profile_id=?').get(enrollment.profile.voiceProfileId));
check('deleted profile cannot be selected later', service.listProfiles(principal, matt.personId).length === 0);
check('Matt person record remains after profile deletion', people.getPerson(matt.personId)?.status === 'active');
check('Matt non-biometric memory remains after profile deletion', memories.get('memory_matt_project')?.summary.includes('Roma voice identity'));

const diagnostics = service.getDiagnostics(100);
check('bounded diagnostics include scores, thresholds context, evidence and timing without templates', diagnostics.some((event) => event.type === 'identity_decision' && event.scores?.length) && diagnostics.some((event) => event.latencyMs != null) && !JSON.stringify(diagnostics).includes(templateRow.encrypted_template));
check('voice identity never invokes speech or bypasses Speech Gate', !diagnostics.some((event) => /speech|tts|gate_bypass/i.test(event.type)));
check('all fixture audio traversed the bounded sample manager', diagnostics.filter((event) => event.type === 'template_extracted').length >= 5);

console.log('\nFixture verification summary');
console.log(`  model:       ${provider.getProviderStatus().model}`);
console.log(`  model rev:   ${provider.getProviderStatus().modelRevision}`);
console.log(`  dimensions:  ${provider.getProviderStatus().dimensions}`);
console.log(`  thresholds:  strong=${provider.thresholds.strongMatch} candidate=${provider.thresholds.candidate} ambiguity=${provider.thresholds.ambiguityMargin}`);
console.log(`  same score:  ${sameScore.toFixed(4)}`);
console.log(`  other score: ${differentScore.toFixed(4)}`);
console.log(`  checks:      ${checks.length}/${checks.length}`);
console.log('  source:      recorded Vanessa/Dan conversation fixture (not a physical microphone test)');

db.close();
rmSync(temp, { recursive: true, force: true });
