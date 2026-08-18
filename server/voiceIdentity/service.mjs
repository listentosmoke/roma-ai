import { randomUUID } from 'node:crypto';
import { createBoundedAudioSampleManager } from './audioSampleManager.mjs';
import { createWavlmSpeakerProvider } from './provider.mjs';
import { createTemplateCipher } from './crypto.mjs';
import { createVoiceTemplateRepository } from '../repositories/voiceTemplateRepository.mjs';
import { createOperationLedger } from '../repositories/operationLedger.mjs';
import { createEntityResolver } from '../../src/identity/resolver.js';

function normalizeAverage(previous, next, previousWeight) {
  const out = new Float32Array(previous.length);
  let square = 0;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (previous[i] * previousWeight + next[i]) / (previousWeight + 1);
    square += out[i] * out[i];
  }
  const norm = Math.sqrt(square);
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

function cipherMetadata(profile) {
  return {
    workspaceId: profile.workspaceId,
    personId: profile.personId,
    voiceProfileId: profile.voiceProfileId,
    provider: profile.provider,
    model: profile.model,
    modelVersion: profile.modelVersion,
    templateVersion: profile.templateVersion,
  };
}

export function createVoiceIdentityService({
  sampleManager = createBoundedAudioSampleManager(),
  provider = createWavlmSpeakerProvider(),
  cipher = createTemplateCipher(),
  now = Date.now,
} = {}) {
  let db = null;
  let repositories = null;
  let templateRepository = null;
  let ledger = null;
  const requests = new Map();
  const resolverByWorkspace = new Map();
  const providerResults = new Map();
  const diagnostics = [];

  function trace(event) {
    diagnostics.push({ at: now(), ...event });
    if (diagnostics.length > 100) diagnostics.splice(0, diagnostics.length - 100);
  }

  function configure({ database, dataRepositories }) {
    if (db && db !== database) {
      requests.clear();
      providerResults.clear();
      resolverByWorkspace.clear();
    }
    db = database;
    repositories = dataRepositories;
    templateRepository = createVoiceTemplateRepository({ db, now });
    ledger = createOperationLedger({ db, now });
    return api;
  }

  function requireConfigured() {
    if (!db || !repositories || !templateRepository) throw new Error('Voice identity service is not connected to the data repositories.');
  }

  function workspaceRepos(principal) {
    requireConfigured();
    return {
      identity: repositories.identityRepository.forWorkspace(principal.workspaceId, principal.userId),
      consent: repositories.consentRepository.forWorkspace(principal.workspaceId, principal.userId),
      templates: templateRepository.forWorkspace(principal.workspaceId, principal.userId),
    };
  }

  function getResolver(principal) {
    const key = `${principal.workspaceId}:${principal.userId}`;
    if (!resolverByWorkspace.has(key)) {
      const identity = repositories.identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const adapter = {
        async identify({ audioRef, candidateProfileIds = [] }) {
          const result = providerResults.get(audioRef?.id ?? audioRef);
          if (!result) return { ok: false, matches: [], reasonCode: 'provider_result_expired' };
          const allowed = new Set(candidateProfileIds);
          return { ok: true, matches: result.matches.filter((match) => allowed.has(match.voiceProfileId)), provider: 'local_wavlm', providerModel: result.model };
        },
      };
      resolverByWorkspace.set(key, createEntityResolver({ repository: identity, voiceProvider: adapter, now, voiceThresholds: {
        strongVoiceMatch: provider.thresholds.strongMatch,
        mediumVoiceMatch: provider.thresholds.candidate,
        ambiguousMargin: provider.thresholds.ambiguityMargin,
        minVoiceQuality: provider.thresholds.minQuality,
      } }));
    }
    return resolverByWorkspace.get(key);
  }

  function providerAvailable() {
    return cipher.configured && provider.getProviderStatus().available;
  }

  function beginCapture(principal, body) {
    requireConfigured();
    if (!providerAvailable()) return { ok: false, reasonCode: cipher.configured ? 'provider_unavailable' : 'encryption_key_missing' };
    const purpose = body.purpose;
    const repos = workspaceRepos(principal);
    if (purpose === 'identification' && body.sessionId && body.speakerLabel) {
      const continuity = getResolver(principal).getContinuity(body.sessionId, body.speakerLabel);
      if (continuity) return { ok: false, skipped: true, reasonCode: 'session_continuity_active', resolution: { status: 'resolved', personId: continuity.personId, evidenceIds: continuity.evidenceIds } };
    }
    const person = body.personId ? repos.identity.getPerson(body.personId) : null;
    if (purpose === 'enrollment' || purpose === 'verification' || purpose === 'profile_update') {
      if (!person || person.status !== 'active') return { ok: false, reasonCode: 'person_not_found' };
    }
    let consent = null;
    if (purpose !== 'quality_check') {
      consent = body.consentId ? repos.consent.get(body.consentId) : null;
      if (!consent || consent.status !== 'active' || consent.personId !== body.personId || consent.scope !== 'voice_identity') {
        return { ok: false, reasonCode: 'active_consent_required' };
      }
    }
    const operationId = body.operationId ?? randomUUID();
    const started = sampleManager.begin({
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      sessionId: body.sessionId,
      interactionId: body.interactionId,
      speakerLabel: body.speakerLabel,
      personId: body.personId,
      purpose,
      consentId: consent?.consentId ?? null,
      romaSpeaking: body.romaSpeaking,
      playbackActive: body.playbackActive,
      overlapDetected: body.overlapDetected,
      operationId,
    });
    if (started.ok) requests.set(operationId, {
      principal: { ...principal },
      purpose,
      personId: body.personId ?? null,
      consentId: consent?.consentId ?? null,
      candidatePersonIds: [...new Set(body.candidatePersonIds ?? [])].slice(0, provider.thresholds.maxCandidates),
      claimedVoiceProfileId: body.voiceProfileId ?? null,
      sessionId: body.sessionId,
      interactionId: body.interactionId ?? null,
      speakerLabel: body.speakerLabel ?? null,
      createdAt: now(),
    });
    trace({ type: 'capture_begin', operationId, sessionId: body.sessionId, speakerLabel: body.speakerLabel ?? null, purpose, state: started.ok ? 'capturing' : 'rejected', reasonCode: started.reasonCode ?? null });
    return started;
  }

  function appendFrame(args) {
    return sampleManager.append(args);
  }

  function updateCaptureFlags(principal, operationId, flags) {
    return sampleManager.setFlags(operationId, principal.workspaceId, flags);
  }

  function cancelCapture(principal, operationId) {
    requests.delete(operationId);
    providerResults.delete(operationId);
    return sampleManager.cancel(operationId, principal.workspaceId);
  }

  async function finalizeSample(principal, operationId) {
    const request = requests.get(operationId);
    if (!request || request.principal.workspaceId !== principal.workspaceId || request.principal.userId !== principal.userId) return { ok: false, reasonCode: 'capture_not_found' };
    const finalized = sampleManager.finalize(operationId, principal.workspaceId);
    if (!finalized.ok) { trace({ type: 'capture_rejected', operationId, reasonCode: finalized.reasonCode, quality: finalized.quality }); requests.delete(operationId); return finalized; }
    const sample = sampleManager.consume(operationId, principal.workspaceId);
    if (!sample) return { ok: false, reasonCode: 'capture_not_ready' };
    const extraction = await provider.extractTemplate({ pcm: sample.pcm, quality: sample.quality.quality });
    sample.pcm.fill(0);
    if (!extraction.ok) { trace({ type: 'extraction_rejected', operationId, reasonCode: extraction.reasonCode }); requests.delete(operationId); return extraction; }
    trace({ type: 'template_extracted', operationId, durationMs: sample.quality.durationMs, usableSpeechMs: sample.quality.usableSpeechMs, quality: sample.quality.quality, overlapDetected: sample.quality.overlapDetected, playbackExcluded: sample.quality.playbackExcluded, provider: extraction.provider, model: extraction.model, modelVersion: extraction.modelVersion, latencyMs: extraction.latencyMs });
    return { ok: true, request, sample: { ...sample, pcm: undefined }, extraction };
  }

  async function finalizeEnrollment(principal, operationId) {
    requireConfigured();
    const replay = ledger.check(principal.workspaceId, operationId);
    if (replay.done) return replay.result;
    const outcome = await finalizeSample(principal, operationId);
    if (!outcome.ok) return outcome;
    const { request, sample, extraction } = outcome;
    try {
      if (request.purpose !== 'enrollment') return { ok: false, reasonCode: 'wrong_operation_purpose' };
      if (sample.quality.possibleReplay) return { ok: false, reasonCode: 'possible_replay', requiresNewSample: true, quality: sample.quality };
      const repos = workspaceRepos(principal);
      const voiceProfileId = randomUUID();
      const metadata = {
        workspaceId: principal.workspaceId,
        personId: request.personId,
        voiceProfileId,
        provider: extraction.provider,
        model: extraction.model,
        modelVersion: extraction.modelVersion,
        templateVersion: extraction.templateVersion,
      };
      const encrypted = cipher.encrypt(extraction.template, metadata);
      const created = repos.templates.create({ voiceProfileId, personId: request.personId, consentId: request.consentId, providerResult: extraction, encrypted, quality: sample.quality.quality });
      const result = created.ok ? {
        ok: true,
        operationId,
        profile: created.profile,
        quality: sample.quality,
        providerLatencyMs: extraction.latencyMs,
        reasonCode: 'voice_enrolled',
      } : created;
      if (result.ok) ledger.record(principal.workspaceId, operationId, 'identity.voice_enroll', result);
      trace({ type: result.ok ? 'profile_enrolled' : 'enrollment_rejected', operationId, voiceProfileId: result.profile?.voiceProfileId ?? null, reasonCode: result.reasonCode });
      return result;
    } finally {
      extraction.template.fill(0);
      requests.delete(operationId);
    }
  }

  async function finalizeMatch(principal, operationId, { allowPossibleReplay = false, isStillCurrent = () => true } = {}) {
    const outcome = await finalizeSample(principal, operationId);
    if (!outcome.ok) return outcome;
    const { request, sample, extraction } = outcome;
    const candidates = [];
    try {
      if (!['verification', 'identification'].includes(request.purpose)) return { ok: false, reasonCode: 'wrong_operation_purpose' };
      if (sample.quality.possibleReplay && !allowPossibleReplay) return { ok: false, reasonCode: 'possible_replay', requiresConfirmation: true, quality: sample.quality };
      if (!isStillCurrent()) return { ok: false, reasonCode: 'stale_identity_result' };

      const repos = workspaceRepos(principal);
      let candidatePersonIds = request.candidatePersonIds;
      if (request.purpose === 'verification') candidatePersonIds = [request.personId];
      if (!candidatePersonIds.length) return { ok: false, reasonCode: 'no_relevant_candidates' };
      const encryptedProfiles = repos.templates.listActiveForCandidates(candidatePersonIds, provider.thresholds.maxCandidates);
      for (const profile of encryptedProfiles) {
        if (profile.modelVersion !== extraction.modelVersion) continue;
        const template = cipher.decrypt(profile.encrypted, cipherMetadata({ ...profile, workspaceId: principal.workspaceId }));
        candidates.push({ voiceProfileId: profile.voiceProfileId, personId: profile.personId, template });
      }
      if (!candidates.length) return { ok: false, reasonCode: 'no_compatible_profiles' };
      const identified = provider.identifyTemplates({ template: extraction.template, candidateProfiles: candidates, quality: sample.quality.quality });
      if (!isStillCurrent()) return { ok: false, reasonCode: 'stale_identity_result' };

      providerResults.set(operationId, { ...identified, model: extraction.model });
      const resolver = getResolver(principal);
      const resolution = await resolver.resolve({
        sessionId: request.sessionId,
        interactionId: request.interactionId,
        speakerLabel: request.speakerLabel ?? 'Unknown speaker',
        voiceSampleRef: { id: operationId },
        candidatePersonIds,
      }, { isStillCurrent });
      if (resolution.personId && identified.matches[0]) repos.templates.markMatch(identified.matches[0].voiceProfileId, { similarity: identified.matches[0].score, quality: sample.quality.quality });
      trace({ type: 'identity_decision', operationId, candidateCount: candidates.length, scores: identified.matches.slice(0, provider.thresholds.maxCandidates).map((match) => ({ personId: match.personId, voiceProfileId: match.voiceProfileId, similarity: match.score })), decision: identified.decision, reasonCode: identified.reasonCode, evidenceIds: resolution.evidenceIds ?? [], resolverStatus: resolution.status });
      return {
        ok: true,
        operationId,
        decision: identified.decision,
        reasonCode: identified.reasonCode,
        matches: identified.matches.map(({ template: _template, ...match }) => match),
        resolution,
        quality: sample.quality,
        providerLatencyMs: extraction.latencyMs,
        thresholds: provider.thresholds,
      };
    } finally {
      extraction.template.fill(0);
      for (const candidate of candidates) candidate.template.fill(0);
      providerResults.delete(operationId);
      requests.delete(operationId);
    }
  }

  async function updateProfile(principal, operationId, voiceProfileId, { explicitlyConfirmed = false } = {}) {
    const outcome = await finalizeSample(principal, operationId);
    if (!outcome.ok) return outcome;
    const { request, sample, extraction } = outcome;
    let oldTemplate = null;
    let combined = null;
    try {
      const repos = workspaceRepos(principal);
      if (request.purpose !== 'profile_update') return { ok: false, reasonCode: 'wrong_operation_purpose' };
      if (request.claimedVoiceProfileId && request.claimedVoiceProfileId !== voiceProfileId) return { ok: false, reasonCode: 'profile_scope_mismatch' };
      if (sample.quality.possibleReplay) return { ok: false, reasonCode: 'possible_replay', requiresNewSample: true, quality: sample.quality };
      const person = repos.identity.getPerson(request.personId);
      if (!person || person.identityStatus !== 'confirmed') return { ok: false, reasonCode: 'confirmed_person_required' };
      const profile = repos.templates.getForProvider(voiceProfileId);
      if (!profile || profile.personId !== request.personId) return { ok: false, reasonCode: 'profile_not_found' };
      if (profile.consentId !== request.consentId) return { ok: false, reasonCode: 'active_consent_required' };
      if (profile.modelVersion !== extraction.modelVersion) return { ok: false, reasonCode: 'incompatible_model_version' };
      oldTemplate = cipher.decrypt(profile.encrypted, cipherMetadata({ ...profile, workspaceId: principal.workspaceId }));
      const comparison = provider.compareTemplates({ template: extraction.template, profileTemplate: oldTemplate, quality: sample.quality.quality });
      if (comparison.decision !== 'match' && !explicitlyConfirmed) return { ok: false, reasonCode: comparison.decision === 'candidate' ? 'ambiguous_update' : 'profile_update_not_verified', comparison };
      combined = normalizeAverage(oldTemplate, extraction.template, profile.sampleCount);
      const encrypted = cipher.encrypt(combined, cipherMetadata({ ...profile, workspaceId: principal.workspaceId }));
      const quality = (profile.aggregateQuality * profile.sampleCount + sample.quality.quality) / (profile.sampleCount + 1);
      const result = repos.templates.replaceTemplate(voiceProfileId, { encrypted, quality, sampleCount: profile.sampleCount + 1, modelVersion: extraction.modelVersion, modelRevision: extraction.modelRevision, templateVersion: extraction.templateVersion, dimensions: extraction.dimensions });
      return { ...result, operationId, comparison, quality: sample.quality };
    } finally {
      oldTemplate?.fill(0);
      combined?.fill(0);
      extraction.template.fill(0);
      requests.delete(operationId);
    }
  }

  function revokeConsent(principal, consentId) {
    const repos = workspaceRepos(principal);
    const profiles = repos.templates.listMetadataForConsent(consentId);
    const result = repos.templates.revokeByConsent(consentId);
    const resolver = getResolver(principal);
    for (const personId of new Set(profiles.map((profile) => profile.personId))) resolver.invalidateForPerson(personId);
    trace({ type: 'consent_revoked', consentId, revokedProfiles: result.revoked });
    return result;
  }

  function deleteProfile(principal, voiceProfileId) {
    const repos = workspaceRepos(principal);
    const profile = repos.templates.getMetadata(voiceProfileId);
    const result = repos.templates.delete(voiceProfileId);
    if (profile) getResolver(principal).invalidateForPerson(profile.personId);
    trace({ type: 'profile_deleted', voiceProfileId, personId: profile?.personId ?? null, deleted: result.ok });
    return result;
  }

  function listProfiles(principal, personId) {
    const templates = workspaceRepos(principal).templates;
    templates.disableIncompatible(provider.getProviderStatus().modelVersion);
    return templates.listMetadataForPerson(personId);
  }

  function confirmResolution(principal, body) {
    if (!body?.sessionId || !body?.speakerLabel || !body?.personId || !workspaceRepos(principal).identity.getPerson(body.personId)) return { status: 'unknown', reasonCode: 'invalid_resolution_request', evidenceIds: [] };
    const result = getResolver(principal).confirmMatch(body);
    trace({ type: 'manual_confirmation', sessionId: body.sessionId, speakerLabel: body.speakerLabel, personId: body.personId, evidenceIds: result.evidenceIds ?? [], reasonCode: result.reasonCode });
    return result;
  }

  function rejectResolution(principal, body) {
    if (!body?.sessionId || !body?.speakerLabel || !body?.personId || !workspaceRepos(principal).identity.getPerson(body.personId)) return { status: 'unknown', reasonCode: 'invalid_resolution_request', evidenceIds: [] };
    const result = getResolver(principal).rejectMatch(body);
    trace({ type: 'manual_rejection', sessionId: body.sessionId, speakerLabel: body.speakerLabel, personId: body.personId, evidenceIds: result.evidenceIds ?? [], reasonCode: result.reasonCode });
    return result;
  }

  function correctResolution(principal, body) {
    if (!body?.sessionId || !body?.speakerLabel || !body?.correctName) return { status: 'unknown', reasonCode: 'invalid_resolution_request', evidenceIds: [] };
    const result = getResolver(principal).correctIdentity(body);
    trace({ type: 'manual_correction', sessionId: body.sessionId, speakerLabel: body.speakerLabel, personId: result.personId, previousPersonId: result.previousPersonId ?? null, evidenceIds: result.evidenceIds ?? [], reasonCode: result.reasonCode });
    return result;
  }

  const api = {
    configure,
    beginCapture,
    appendFrame,
    updateCaptureFlags,
    cancelCapture,
    finalizeEnrollment,
    finalizeMatch,
    updateProfile,
    revokeConsent,
    deleteProfile,
    listProfiles,
    confirmResolution,
    rejectResolution,
    correctResolution,
    getCapture(principal, operationId) { return sampleManager.get(operationId, principal.workspaceId); },
    getProviderStatus() {
      return { ...provider.getProviderStatus(), encryption: cipher.status(), captureLimits: sampleManager.limits(), ready: Boolean(db) && providerAvailable() };
    },
    warmup: () => provider.warmup(),
    getDiagnostics(limit = 50) { return diagnostics.slice(-Math.max(1, Math.min(Number(limit) || 50, 100))); },
    sampleManager,
    provider,
    cipher,
  };
  return api;
}

let sharedService = null;
export function getSharedVoiceIdentityService() {
  sharedService ??= createVoiceIdentityService();
  return sharedService;
}
