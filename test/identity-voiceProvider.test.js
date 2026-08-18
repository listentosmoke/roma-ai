import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeterministicVoiceProvider, createUnavailableVoiceProvider, createVoiceProvider } from '../src/identity/voiceProvider.js';

function goodSample(matchKey, overrides = {}) {
  return { matchKey, durationMs: 4000, quality: 0.9, speakerPurity: 0.95, ...overrides };
}

test('successful enrollment returns a voiceProfileId and provider metadata', async () => {
  const provider = createDeterministicVoiceProvider();
  const result = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  assert.equal(result.ok, true);
  assert.match(result.voiceProfileId, /^voice_profile_/);
  assert.equal(result.provider, 'deterministic_test_voice_provider');
});

test('a strong match scores at/above the strong threshold', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const result = await provider.compare({ audioRef: goodSample('matt'), voiceProfileId });
  assert.equal(result.ok, true);
  assert.ok(result.score >= 0.85);
});

test('a weak (unrelated) match scores low', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const result = await provider.compare({ audioRef: goodSample('someone-else'), voiceProfileId });
  assert.ok(result.score < 0.55);
});

test('an ambiguous (similar-key) match scores in the medium band', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const result = await provider.compare({ audioRef: goodSample('matt-similar'), voiceProfileId });
  assert.ok(result.score >= 0.55 && result.score < 0.85);
});

test('identify() ranks candidates and reports personId per match', async () => {
  const provider = createDeterministicVoiceProvider();
  const a = await provider.enroll({ personId: 'person_a', audioRef: goodSample('matt'), consent: true });
  const b = await provider.enroll({ personId: 'person_b', audioRef: goodSample('jon'), consent: true });
  const result = await provider.identify({ audioRef: goodSample('matt'), candidateProfileIds: [a.voiceProfileId, b.voiceProfileId] });
  assert.equal(result.ok, true);
  assert.equal(result.matches[0].personId, 'person_a');
  assert.ok(result.matches[0].score > result.matches[1].score);
});

test('a low-quality sample is rejected for both enrollment and comparison', async () => {
  const provider = createDeterministicVoiceProvider();
  const enrolled = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt', { quality: 0.1 }), consent: true });
  assert.equal(enrolled.ok, false);
  assert.equal(enrolled.reasonCode, 'low_quality_sample');
});

test('overlapping speech (low speaker purity) is rejected for enrollment', async () => {
  const provider = createDeterministicVoiceProvider();
  const result = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt', { speakerPurity: 0.2 }), consent: true });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'overlapping_speech_detected');
});

test("Roma's own TTS playback can never be enrolled or matched", async () => {
  const provider = createDeterministicVoiceProvider();
  const enrolled = await provider.enroll({ personId: 'p1', audioRef: goodSample('roma-tts', { isPlayback: true }), consent: true });
  assert.equal(enrolled.ok, false);
  assert.equal(enrolled.reasonCode, 'roma_playback_excluded');

  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const compared = await provider.compare({ audioRef: goodSample('matt', { isPlayback: true }), voiceProfileId });
  assert.equal(compared.ok, false);
  assert.equal(compared.reasonCode, 'roma_playback_excluded');
});

test('enrollment requires explicit consent', async () => {
  const provider = createDeterministicVoiceProvider();
  const result = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: false });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'consent_required');
});

test('a cancelled (aborted) enrollment creates no profile', async () => {
  const provider = createDeterministicVoiceProvider();
  const controller = new AbortController();
  controller.abort();
  const result = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});

test('a deleted voice profile is no longer matchable', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const deleted = provider.deleteProfile(voiceProfileId);
  assert.equal(deleted.deleted, true);
  const compared = await provider.compare({ audioRef: goodSample('matt'), voiceProfileId });
  assert.equal(compared.ok, false);
  assert.equal(compared.reasonCode, 'profile_not_found');
  assert.equal(provider.getProfileMetadata(voiceProfileId), null);
});

test('getProfileMetadata never exposes matchKey/audio-shaped data', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const meta = provider.getProfileMetadata(voiceProfileId);
  assert.ok(!('matchKey' in meta));
  assert.ok(!('audioRef' in meta));
});

test('deterministic provider results are repeatable', async () => {
  const provider = createDeterministicVoiceProvider();
  const { voiceProfileId } = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  const r1 = await provider.compare({ audioRef: goodSample('matt'), voiceProfileId });
  const r2 = await provider.compare({ audioRef: goodSample('matt'), voiceProfileId });
  assert.equal(r1.score, r2.score);
});

test('the unavailable provider honestly reports every operation as unavailable, never silently mock-succeeding', async () => {
  const provider = createUnavailableVoiceProvider();
  assert.equal(provider.getProviderStatus().available, false);
  const enrolled = await provider.enroll({ personId: 'p1', audioRef: goodSample('matt'), consent: true });
  assert.equal(enrolled.ok, false);
  assert.equal(enrolled.reasonCode, 'provider_unavailable');
  const compared = await provider.compare({ audioRef: goodSample('matt'), voiceProfileId: 'x' });
  assert.equal(compared.ok, false);
  const identified = await provider.identify({ audioRef: goodSample('matt'), candidateProfileIds: ['x'] });
  assert.equal(identified.ok, false);
});

test('createVoiceProvider factory defaults to unavailable (production never silently gets the deterministic provider)', () => {
  assert.equal(createVoiceProvider({}).getProviderStatus().mode, 'unavailable');
  assert.equal(createVoiceProvider({ mode: 'deterministic' }).getProviderStatus().mode, 'deterministic');
});
