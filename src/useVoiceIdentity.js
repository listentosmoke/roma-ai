import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDataClient } from './server/dataClient.js';

const CONSENT_PURPOSE = 'Recognize this consenting person in conversation. Voice recognition is probabilistic and is not authentication.';

export function useVoiceIdentity(voice, { romaSpeaking = false, identityMutationQueue = null } = {}) {
  const client = useMemo(() => createDataClient({ timeoutMs: 30000 }), []);
  const [status, setStatus] = useState(null);
  const [operation, setOperation] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [profilesByPerson, setProfilesByPerson] = useState({});
  const blockedOperationRef = useRef(null);

  const refreshStatus = useCallback(() => client.get('/api/voice/status').then(setStatus).catch((caught) => setStatus({ ok: false, ready: false, error: caught.message })), [client]);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    if (!operation || !romaSpeaking || blockedOperationRef.current === operation.operationId) return;
    blockedOperationRef.current = operation.operationId;
    setError('Voice capture stopped because Roma playback became active. Record a new sample after playback ends.');
    client.post(`/api/voice/captures/${operation.operationId}/flags`, { romaSpeaking: true, playbackActive: true }).catch(() => {});
    voice.endVoiceCapture(operation.operationId).catch(() => {});
  }, [client, operation, romaSpeaking, voice]);

  const loadProfiles = useCallback(async (personId) => {
    const response = await client.get(`/api/voice/people/${encodeURIComponent(personId)}/profiles`);
    setProfilesByPerson((current) => ({ ...current, [personId]: response.profiles ?? [] }));
    return response.profiles ?? [];
  }, [client]);

  const ensureConsent = useCallback(async (personId) => {
    const current = await client.get(`/api/consent?personId=${encodeURIComponent(personId)}`);
    const active = current.consents?.find((consent) => consent.scope === 'voice_identity' && consent.status === 'active');
    if (active) return active;
    const granted = await client.post('/api/consent', { personId, scope: 'voice_identity', purpose: CONSENT_PURPOSE, provider: status?.provider ?? 'local_wavlm' });
    return granted.consent;
  }, [client, status?.provider]);

  const begin = useCallback(async ({ purpose, personId, candidatePersonIds = [], voiceProfileId = null, speakerLabel = 'Current speaker' }) => {
    setError('');
    setResult(null);
    if (!voice?.listening || !voice.sessionId) throw new Error('Start the microphone before beginning a voice sample.');
    if (romaSpeaking) throw new Error('Wait until Roma finishes speaking before capturing a voice sample.');
    const consent = purpose === 'quality_check' ? null : await ensureConsent(personId);
    const started = await client.post('/api/voice/captures', {
      purpose,
      personId,
      candidatePersonIds,
      voiceProfileId,
      consentId: consent?.consentId ?? null,
      sessionId: voice.sessionId,
      interactionId: crypto.randomUUID(),
      speakerLabel,
      romaSpeaking,
      playbackActive: romaSpeaking,
    });
    const acknowledged = await voice.beginVoiceCapture({ operationId: started.operationId, captureToken: started.captureToken });
    if (acknowledged.state !== 'capturing') {
      await client.del(`/api/voice/captures/${started.operationId}`).catch(() => {});
      throw new Error('The microphone stream did not acknowledge bounded voice capture.');
    }
    const next = { ...started, purpose, personId, voiceProfileId, consentId: consent?.consentId ?? null, sessionId: voice.sessionId, speakerLabel, startedAt: Date.now() };
    setOperation(next);
    return next;
  }, [client, ensureConsent, romaSpeaking, voice]);

  const finish = useCallback(async ({ confirmPossibleReplay = false, explicitlyConfirmed = false } = {}) => {
    if (!operation) throw new Error('No voice capture is active.');
    setError('');
    await voice.endVoiceCapture(operation.operationId);
    let response;
    if (operation.purpose === 'enrollment') response = await client.post(`/api/voice/captures/${operation.operationId}/finalize-enrollment`, {});
    else if (operation.purpose === 'profile_update') response = await client.post(`/api/voice/captures/${operation.operationId}/update-profile/${operation.voiceProfileId}`, { explicitlyConfirmed });
    else response = await client.post(`/api/voice/captures/${operation.operationId}/finalize-match`, { confirmPossibleReplay });
    const resultWithScope = { ...response, sessionId: operation.sessionId, speakerLabel: operation.speakerLabel };
    setResult(resultWithScope);
    setOperation(null);
    if (response.profile?.personId ?? operation.personId) await loadProfiles(response.profile?.personId ?? operation.personId).catch(() => {});
    return resultWithScope;
  }, [client, loadProfiles, operation, voice]);

  const cancel = useCallback(async () => {
    if (!operation) return;
    await voice.endVoiceCapture(operation.operationId).catch(() => {});
    await client.del(`/api/voice/captures/${operation.operationId}`).catch(() => {});
    setOperation(null);
  }, [client, operation, voice]);

  const deleteProfile = useCallback(async (personId, voiceProfileId) => {
    // Deleting a profile invalidates any still-queued work referencing it —
    // a delayed link/update for a deleted profile must never replay.
    identityMutationQueue?.cancelWhere((op) => op.category === 'voice_profile' && op.entityId === voiceProfileId, 'profile_deleted');
    const response = await client.del(`/api/voice/profiles/${encodeURIComponent(voiceProfileId)}`);
    await loadProfiles(personId);
    return response;
  }, [client, loadProfiles, identityMutationQueue]);

  const revokeConsent = useCallback(async (personId) => {
    // Consent revocation takes priority over pending biometric-adjacent
    // operations: cancel queued voice-profile mutations BEFORE the revoke
    // call, so nothing revoked can be replayed by a later retry. (Raw
    // biometric operations are never queueable at all — this covers the
    // opaque profile-reference link/unlink mutations.)
    identityMutationQueue?.cancelWhere((op) => op.category === 'voice_profile', 'consent_revoked');
    const current = await client.get(`/api/consent?personId=${encodeURIComponent(personId)}`);
    const active = current.consents?.find((consent) => consent.scope === 'voice_identity' && consent.status === 'active');
    if (!active) return { ok: true, alreadyRevoked: true };
    const response = await client.post(`/api/consent/${encodeURIComponent(active.consentId)}/revoke`, {});
    await loadProfiles(personId);
    return response;
  }, [client, loadProfiles, identityMutationQueue]);

  const candidateDecision = useCallback(async (action, personId) => {
    if (!result?.sessionId || !result?.speakerLabel) throw new Error('No current voice-resolution context is available.');
    const response = await client.post(`/api/voice/resolutions/${action}`, { sessionId: result.sessionId, speakerLabel: result.speakerLabel, personId, interactionId: result.operationId });
    setResult((current) => ({ ...current, manualDecision: response }));
    return response;
  }, [client, result]);

  function guarded(action) {
    return (...args) => Promise.resolve(action(...args)).catch((caught) => { setError(caught.message); throw caught; });
  }

  return {
    status,
    operation,
    result,
    error,
    profilesByPerson,
    refreshStatus,
    loadProfiles: guarded(loadProfiles),
    enroll: guarded((personId) => begin({ purpose: 'enrollment', personId, speakerLabel: voice?.speakers?.at(-1) ?? 'Current speaker' })),
    verify: guarded((personId, voiceProfileId) => begin({ purpose: 'verification', personId, candidatePersonIds: [personId], voiceProfileId, speakerLabel: voice?.speakers?.at(-1) ?? 'Current speaker' })),
    improve: guarded((personId, voiceProfileId) => begin({ purpose: 'profile_update', personId, voiceProfileId, speakerLabel: voice?.speakers?.at(-1) ?? 'Current speaker' })),
    identify: guarded((personId, candidatePersonIds) => begin({ purpose: 'identification', personId, candidatePersonIds })),
    finish: guarded(finish),
    cancel: guarded(cancel),
    deleteProfile: guarded(deleteProfile),
    revokeConsent: guarded(revokeConsent),
    confirmCandidate: guarded((personId) => candidateDecision('confirm', personId)),
    rejectCandidate: guarded((personId) => candidateDecision('reject', personId)),
  };
}

export { CONSENT_PURPOSE };
