// Provider-independent voice identity interface + implementations.
//
// FEASIBILITY FINDING (see IDENTITY.md "Provider limitations" for the full
// writeup): this repository has NO server-side persistence (server/groqApi.js
// is a stateless proxy — no database, no file storage) and NO bounded
// raw-audio-sample pipeline (src/audio.js streams PCM16 frames directly to
// Deepgram over a WebSocket; the browser never buffers or retains them, and
// Deepgram's diarization returns only numeric speaker indices, never named
// voice recognition). Building a "real" voice-identity provider today would
// require either fabricating audio capture that does not exist, or inventing
// a recognition signal from transcript text/speaker labels — both of which
// this phase's spec explicitly forbids.
//
// So: this module ships the full provider-independent INTERFACE (so a real
// server-side provider can be plugged in later without any caller changing)
// plus a DETERMINISTIC test/dev provider that exercises every required
// scenario, and an honestly-unavailable provider that is what production
// actually gets wired to. Nothing here pretends transcript-derived or
// speaker-label-derived signal is biometric recognition.

const STRONG_MATCH_SCORE = 0.92;
const SIMILAR_KEY_SCORE = 0.65; // "ambiguous" tier
const UNRELATED_KEY_SCORE = 0.15;

export const VOICE_MATCH_THRESHOLDS = {
  strong: 0.85, // >= this + adequate quality may resolve automatically
  medium: 0.55, // [medium, strong) => candidate/ambiguous, never silent resolution
  minQuality: 0.5,
  minSpeakerPurity: 0.6,
  minDurationMs: 1500,
  maxDurationMs: 15000,
};

/**
 * A "sample" here is a BOUNDED reference + metadata, never raw audio bytes —
 * `{ matchKey, durationMs, quality, speakerPurity, encoding, isPlayback }`.
 * `matchKey` is an explicit test-fixture label (e.g. "matt"), not a derived
 * biometric feature — see file header. Real callers of a future server
 * provider would instead pass an opaque server-side sample reference.
 */
function normalizeSample(audioRef) {
  if (audioRef && typeof audioRef === 'object') {
    return {
      matchKey: typeof audioRef.matchKey === 'string' ? audioRef.matchKey : null,
      durationMs: Number.isFinite(audioRef.durationMs) ? audioRef.durationMs : 4000,
      quality: typeof audioRef.quality === 'number' ? audioRef.quality : 0.8,
      speakerPurity: typeof audioRef.speakerPurity === 'number' ? audioRef.speakerPurity : 0.9,
      encoding: audioRef.encoding ?? 'pcm16',
      isPlayback: Boolean(audioRef.isPlayback),
    };
  }
  // A bare string ref with no metadata can't be validated — treat as unknown/low quality rather than guessing good quality.
  return { matchKey: typeof audioRef === 'string' ? audioRef : null, durationMs: 0, quality: 0, speakerPurity: 0, encoding: null, isPlayback: false };
}

function validateSample(sample) {
  if (sample.isPlayback) return { ok: false, reasonCode: 'roma_playback_excluded', note: "Roma's own TTS playback cannot be enrolled or matched as a human voice." };
  if (!sample.matchKey) return { ok: false, reasonCode: 'invalid_sample', note: 'No usable voice sample reference was provided.' };
  if (sample.durationMs < VOICE_MATCH_THRESHOLDS.minDurationMs || sample.durationMs > VOICE_MATCH_THRESHOLDS.maxDurationMs) {
    return { ok: false, reasonCode: 'invalid_sample_duration', note: `Sample duration ${sample.durationMs}ms is outside the allowed ${VOICE_MATCH_THRESHOLDS.minDurationMs}-${VOICE_MATCH_THRESHOLDS.maxDurationMs}ms range.` };
  }
  if (sample.quality < VOICE_MATCH_THRESHOLDS.minQuality) return { ok: false, reasonCode: 'low_quality_sample', note: `Sample quality ${sample.quality} is below the minimum ${VOICE_MATCH_THRESHOLDS.minQuality}.` };
  if (sample.speakerPurity < VOICE_MATCH_THRESHOLDS.minSpeakerPurity) return { ok: false, reasonCode: 'overlapping_speech_detected', note: `Speaker purity ${sample.speakerPurity} indicates overlapped/unclear speech.` };
  return { ok: true };
}

function scoreAgainst(sampleKey, profileKey) {
  if (sampleKey === profileKey) return STRONG_MATCH_SCORE;
  if (sampleKey === `${profileKey}-similar` || profileKey === `${sampleKey}-similar`) return SIMILAR_KEY_SCORE;
  return UNRELATED_KEY_SCORE;
}

let profileCounter = 0;
function generateProfileId(now) {
  profileCounter += 1;
  return `voice_profile_${now}_${profileCounter}`;
}

/**
 * Deterministic, repeatable voice-identity provider for tests, simulation,
 * and (clearly labeled as such in the People panel) local development. Never
 * presented as real biometric recognition — see getProviderStatus().
 */
export function createDeterministicVoiceProvider({ now = Date.now } = {}) {
  const profiles = new Map(); // voiceProfileId -> { personId, matchKey, quality, consent, createdAt }
  const PROVIDER = 'deterministic_test_voice_provider';
  const MODEL = 'deterministic-v1';

  return {
    getProviderStatus() {
      return { available: true, mode: 'deterministic', provider: PROVIDER, providerModel: MODEL, reason: 'Deterministic test/dev provider — not real biometric recognition.' };
    },

    async enroll({ personId, audioRef, consent, signal } = {}) {
      if (signal?.aborted) return { ok: false, cancelled: true, reasonCode: 'cancelled' };
      if (!consent) return { ok: false, reasonCode: 'consent_required', note: 'Voice enrollment requires explicit consent.' };
      if (!personId) return { ok: false, reasonCode: 'missing_person_id' };
      const sample = normalizeSample(audioRef);
      const validation = validateSample(sample);
      if (!validation.ok) return { ok: false, reasonCode: validation.reasonCode, note: validation.note };

      const voiceProfileId = generateProfileId(now());
      profiles.set(voiceProfileId, { personId, matchKey: sample.matchKey, quality: sample.quality, consent: true, createdAt: now(), provider: PROVIDER, providerModel: MODEL });
      return { ok: true, voiceProfileId, quality: sample.quality, provider: PROVIDER, providerModel: MODEL, reasonCode: 'enrolled' };
    },

    async compare({ audioRef, voiceProfileId, signal } = {}) {
      if (signal?.aborted) return { ok: false, cancelled: true, reasonCode: 'cancelled' };
      const profile = profiles.get(voiceProfileId);
      if (!profile) return { ok: false, reasonCode: 'profile_not_found', note: 'No such voice profile (it may have been deleted).' };
      const sample = normalizeSample(audioRef);
      const validation = validateSample(sample);
      if (!validation.ok) return { ok: false, reasonCode: validation.reasonCode, note: validation.note };
      const score = scoreAgainst(sample.matchKey, profile.matchKey);
      return { ok: true, score, quality: sample.quality, provider: PROVIDER, providerModel: MODEL };
    },

    async identify({ audioRef, candidateProfileIds = [], signal } = {}) {
      if (signal?.aborted) return { ok: false, cancelled: true, reasonCode: 'cancelled' };
      const sample = normalizeSample(audioRef);
      const validation = validateSample(sample);
      if (!validation.ok) return { ok: false, reasonCode: validation.reasonCode, note: validation.note };
      const matches = candidateProfileIds
        .map((voiceProfileId) => {
          const profile = profiles.get(voiceProfileId);
          if (!profile) return null;
          return { voiceProfileId, personId: profile.personId, score: scoreAgainst(sample.matchKey, profile.matchKey), quality: sample.quality };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      return { ok: true, matches, provider: PROVIDER, providerModel: MODEL };
    },

    deleteProfile(voiceProfileId) {
      const existed = profiles.delete(voiceProfileId);
      return { ok: true, deleted: existed };
    },

    getProfileMetadata(voiceProfileId) {
      const profile = profiles.get(voiceProfileId);
      if (!profile) return null;
      // Sanitized — no raw sample/matchKey template exposed beyond what a real profile record would show.
      return { voiceProfileId, personId: profile.personId, quality: profile.quality, consent: profile.consent, createdAt: profile.createdAt, provider: profile.provider, providerModel: profile.providerModel };
    },
  };
}

/**
 * What production actually gets wired to today: honestly unavailable. Every
 * operation reports why, rather than silently behaving like a mock while
 * claiming to be real (see IDENTITY.md "Provider limitations").
 */
export function createUnavailableVoiceProvider() {
  const REASON = 'No server-side voice-identity provider is configured. This environment has no persistent server database and no bounded raw-audio-sample capture pipeline (audio streams directly to Deepgram; the browser never buffers it) — real voice matching requires a future server audio-capture + secure profile-storage phase. See IDENTITY.md "Provider limitations".';
  const unavailable = { ok: false, reasonCode: 'provider_unavailable', note: REASON };
  return {
    getProviderStatus() { return { available: false, mode: 'unavailable', provider: null, providerModel: null, reason: REASON }; },
    async enroll() { return unavailable; },
    async compare() { return unavailable; },
    async identify() { return unavailable; },
    deleteProfile() { return { ok: false, deleted: false, reasonCode: 'provider_unavailable' }; },
    getProfileMetadata() { return null; },
  };
}

export function createVoiceProvider({ mode = 'unavailable', now } = {}) {
  if (mode === 'deterministic') return createDeterministicVoiceProvider({ now });
  return createUnavailableVoiceProvider();
}
