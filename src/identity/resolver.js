// Entity Resolver — deterministic, application-controlled identity
// resolution. The model may extract a name or trigger an explicit operation
// (via identity/tools.js), but every threshold, confirmation requirement,
// conflict rule, and record mutation below is plain code, not a model
// judgment call. This is what "the model may propose; deterministic code
// controls candidate eligibility/thresholds/merging/splitting/application"
// means in practice.
//
// Two families of operation:
//   - resolve()            — PASSIVE, run automatically once per turn (like
//                             memory.retrieve()) to figure out "who is
//                             probably speaking right now" for the Context
//                             Compiler. Only uses passive signals: bounded
//                             within-session continuity, a voice-match
//                             comparison IF a sample happens to be available,
//                             face observations IF the camera is on, and name
//                             mentions against ALREADY-KNOWN aliases (never
//                             proof of the CURRENT speaker's identity).
//
// Where face evidence fits: Roma is worn, so her camera looks outward and the
// wearer is essentially never in frame. A face therefore answers "who is
// present", not "who is speaking" — usually it is the person being spoken TO.
// So face evidence may CORROBORATE a voice resolution (raising the recorded
// confidence) or CONTRADICT it (forcing `unknown`), but it never promotes a
// resolution by itself and never breaks a voice tie. Presence is reported
// separately, as `presentPersonIds`.
//   - attribute/selfIdentify/confirmMatch/rejectMatch/correctIdentity —
//                             EXPLICIT operations, each corresponding 1:1 to
//                             an identity tool (identity/tools.js). These
//                             always run to completion (they are the direct
//                             result of a deliberate user statement) and are
//                             the only paths that create/confirm/reject a
//                             person record.
//
// Bounded session identity continuity: a speakerLabel resolves to a personId
// for THIS session only, reused while evidence stays consistent, and is
// invalidated on conflict, timeout, session end, or explicit correction.
// `Speaker 0` in one session is never assumed to be `Speaker 0` in another —
// the continuity map is keyed by (sessionId, speakerLabel), never by
// speakerLabel alone.

import { identityEvidenceRank } from './schema.js';

export const RESOLUTION_THRESHOLDS = {
  strongVoiceMatch: 0.85,
  mediumVoiceMatch: 0.55,
  ambiguousMargin: 0.1,
  minVoiceQuality: 0.5,
  // Face thresholds are cosine similarities from the server encoder, on the
  // scale the service itself already gates at 0.50 (see
  // server/faceIdentity/service.mjs for how that number was measured).
  // `strongFaceMatch` sits above the service's own gate: a face only gets to
  // corroborate or contradict a voice resolution when it is comfortably clear
  // of the level at which the server would call it a match at all.
  strongFaceMatch: 0.62,
  mediumFaceMatch: 0.5,
  minFaceQuality: 0.5,
};

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity ends continuity
const MAX_VOICE_CANDIDATES = 12;
const NAME_TOKEN_RE = /\b([A-Z][a-z]{1,30})\b/g;

let resolutionCounter = 0;
function generateResolutionId(now) {
  resolutionCounter += 1;
  return `resolution_${now}_${resolutionCounter}`;
}

function sessionKey(sessionId) {
  return sessionId ?? '__no_session__';
}

/**
 * Deterministic mention detector: only ever matches names ALREADY known to
 * the repository (existing aliases/display names). A brand-new name being
 * discussed produces NO match and therefore no evidence — per spec, a bare
 * mention must never itself create or identify a person.
 */
function detectKnownNameMentions(text, repository) {
  if (!text) return [];
  const tokens = [...new Set([...text.matchAll(NAME_TOKEN_RE)].map((m) => m[1]))];
  const found = new Map();
  for (const token of tokens) {
    for (const person of repository.findByName(token)) found.set(person.personId, person);
  }
  return [...found.values()];
}

/**
 * Bounded face observations from the browser recognizer
 * (src/inspector/faces.js), which has already been through the server
 * matcher: `{ personId, faceProfileId, similarity, quality }`. No image, no
 * embedding, no raw template ever reaches this layer.
 *
 * Anything the user has explicitly rejected for this speaker slot is dropped
 * here, so a rejected suggestion cannot come back through the camera. Repeat
 * sightings of one person collapse to their best observation.
 */
function normalizeFaceObservations(raw, rejected, thresholds) {
  if (!Array.isArray(raw)) return [];
  const byPerson = new Map();
  for (const observation of raw) {
    const personId = observation?.personId;
    if (!personId || rejected.has(personId)) continue;
    const similarity = Number(observation.similarity);
    // A missing quality is treated as unusable rather than perfect: the
    // caller that knows the detector score is the one that must supply it.
    const quality = Number(observation.quality ?? 0);
    if (!Number.isFinite(similarity) || similarity < thresholds.mediumFaceMatch) continue;
    if (!Number.isFinite(quality) || quality < thresholds.minFaceQuality) continue;
    const existing = byPerson.get(personId);
    if (existing && existing.similarity >= similarity) continue;
    byPerson.set(personId, {
      personId,
      faceProfileId: observation.faceProfileId ?? null,
      similarity,
      quality,
      provider: typeof observation.provider === 'string' ? observation.provider : null,
      providerModel: typeof observation.providerModel === 'string' ? observation.providerModel : null,
    });
  }
  return [...byPerson.values()].sort((a, b) => b.similarity - a.similarity);
}

/**
 * @param {{ repository: object, voiceProvider?: object, now?: Function, sessionTimeoutMs?: number, voiceThresholds?: object }} deps
 */
export function createEntityResolver({ repository, voiceProvider = null, now = Date.now, sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS, voiceThresholds = {} } = {}) {
  const resolutionThresholds = { ...RESOLUTION_THRESHOLDS, ...voiceThresholds };
  const continuityStore = new Map(); // sessionId -> Map(speakerLabel -> { personId, resolvedAt, evidenceIds, expiresAt })
  const rejectedStore = new Map(); // sessionId -> Map(speakerLabel -> Set(personId))

  function getContinuity(sessionId, speakerLabel, time) {
    const slot = continuityStore.get(sessionKey(sessionId))?.get(speakerLabel);
    if (!slot) return null;
    if (slot.expiresAt != null && time > slot.expiresAt) {
      continuityStore.get(sessionKey(sessionId))?.delete(speakerLabel);
      return null;
    }
    return slot;
  }

  function setContinuity(sessionId, speakerLabel, personId, time, evidenceIds) {
    const key = sessionKey(sessionId);
    if (!continuityStore.has(key)) continuityStore.set(key, new Map());
    continuityStore.get(key).set(speakerLabel, { personId, resolvedAt: time, evidenceIds, expiresAt: time + sessionTimeoutMs });
  }

  function getRejected(sessionId, speakerLabel) {
    return rejectedStore.get(sessionKey(sessionId))?.get(speakerLabel) ?? new Set();
  }

  function addRejected(sessionId, speakerLabel, personId) {
    const key = sessionKey(sessionId);
    if (!rejectedStore.has(key)) rejectedStore.set(key, new Map());
    const perSpeaker = rejectedStore.get(key);
    if (!perSpeaker.has(speakerLabel)) perSpeaker.set(speakerLabel, new Set());
    perSpeaker.get(speakerLabel).add(personId);
  }

  function clearRejected(sessionId, speakerLabel) {
    rejectedStore.get(sessionKey(sessionId))?.delete(speakerLabel);
  }

  function cancelledOrStale(signal, isStillCurrent, speakerLabel, time) {
    if (signal?.aborted) return { resolutionId: generateResolutionId(time), status: 'cancelled', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [], requiresConfirmation: false, reasonCode: 'cancelled' };
    if (!isStillCurrent()) return { resolutionId: generateResolutionId(time), status: 'stale', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [], requiresConfirmation: false, reasonCode: 'superseded_turn' };
    return null;
  }

  /** Find-or-create a person for an explicit naming operation. Never merges same-name people automatically. */
  function findOrCreateForName(name, { identityStatus, provisionalReason, time }) {
    const candidates = repository.findByName(name);
    if (candidates.length > 1) return { ambiguous: true, candidates };
    if (candidates.length === 1) return { ambiguous: false, person: candidates[0], created: false };
    const created = repository.createPerson({
      displayName: name,
      identityStatus,
      aliases: [{ alias: name, type: 'name', confidence: 0.9 }],
      provisionalReason: provisionalReason ?? null,
      lastObservedAt: time,
    });
    return { ambiguous: false, person: created.person, created: true, errors: created.errors };
  }

  function ambiguousResult(candidates, speakerLabel, time, reasonCode) {
    return {
      resolutionId: generateResolutionId(time),
      status: 'ambiguous',
      personId: null,
      candidateMatches: candidates.map((c) => ({ personId: c.personId, score: 1, confidence: c.confidence, reasonCodes: [reasonCode] })),
      speakerLabel,
      evidenceIds: [],
      requiresConfirmation: true,
      reasonCode,
    };
  }

  /**
   * PASSIVE resolution for the current turn's speaker. Never invents a
   * resolution from name mentions or weak evidence alone — a memory must
   * show at least one real, application-approved signal.
   */
  async function resolve({
    sessionId = null,
    interactionId = null,
    turnId = null,
    speakerLabel,
    transcriptIds = [],
    transcriptText = '',
    voiceSampleRef = null,
    faceObservations = [],
    candidatePersonIds = [],
    time = now(),
  } = {}, { signal, isStillCurrent = () => true } = {}) {
    const early = cancelledOrStale(signal, isStillCurrent, speakerLabel, time);
    if (early) return early;

    const rejected = getRejected(sessionId, speakerLabel);
    const faces = normalizeFaceObservations(faceObservations, rejected, resolutionThresholds);
    // Only a face clear of `strongFaceMatch` is allowed to corroborate or
    // contradict a voice resolution. Weaker ones are still recorded, but they
    // never change an outcome.
    const strongFaces = faces.filter((f) => f.similarity >= resolutionThresholds.strongFaceMatch);
    const presentPersonIds = faces.map((f) => f.personId);

    function addFaceEvidence(face, decision, reasonCode) {
      return repository.addEvidence({
        evidenceType: 'face_match', personId: face.personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
        faceProfileId: face.faceProfileId, provider: face.provider, providerModel: face.providerModel,
        score: face.similarity, confidence: face.similarity, quality: face.quality, decision, reasonCode,
      }).evidence.evidenceId;
    }

    const continuity = getContinuity(sessionId, speakerLabel, time);
    if (continuity) {
      // An explicit confirmation/attribution/correction lives here. A camera
      // must not be able to unseat it, so face evidence is not even consulted
      // — it is only reported as presence.
      return { resolutionId: generateResolutionId(time), status: 'resolved', personId: continuity.personId, candidateMatches: [], speakerLabel, evidenceIds: continuity.evidenceIds, requiresConfirmation: false, reasonCode: 'session_continuity', presentPersonIds };
    }

    if (voiceSampleRef && voiceProvider) {
      const pool = (candidatePersonIds.length ? candidatePersonIds.map((id) => repository.getPerson(id)).filter(Boolean) : repository.listPeople({ status: 'active' }).filter((p) => p.voiceProfileIds.length))
        .filter((p) => !rejected.has(p.personId))
        .slice(0, MAX_VOICE_CANDIDATES);
      const profileToPerson = new Map();
      const profileIds = [];
      for (const person of pool) for (const voiceProfileId of person.voiceProfileIds) { profileToPerson.set(voiceProfileId, person.personId); profileIds.push(voiceProfileId); }

      if (profileIds.length) {
        const identifyResult = await voiceProvider.identify({ audioRef: voiceSampleRef, candidateProfileIds: profileIds, signal });
        const lateCheck = cancelledOrStale(signal, isStillCurrent, speakerLabel, time);
        if (lateCheck) return lateCheck;

        if (identifyResult.ok && identifyResult.matches.length) {
          const eligible = identifyResult.matches.filter((m) => m.score >= resolutionThresholds.mediumVoiceMatch && m.quality >= resolutionThresholds.minVoiceQuality);
          if (eligible.length) {
            const [top, second] = eligible;
            const personId = profileToPerson.get(top.voiceProfileId) ?? top.personId;
            const strong = top.score >= resolutionThresholds.strongVoiceMatch && (!second || top.score - second.score >= resolutionThresholds.ambiguousMargin);

            if (strong) {
              const corroborating = strongFaces.find((f) => f.personId === personId) ?? null;
              // A confident face on somebody ELSE, with nobody confirming the
              // voice's answer, is a genuine conflict between two biometrics.
              // It resolves to unknown — never to whichever scored higher.
              // Both readings are kept as candidate evidence so the
              // disagreement is inspectable rather than silently discarded.
              const contradicting = !corroborating && strongFaces.length ? strongFaces[0] : null;

              if (contradicting) {
                const voiceEvidence = repository.addEvidence({
                  evidenceType: 'voice_match', personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
                  voiceSampleRef: typeof voiceSampleRef === 'string' ? voiceSampleRef : (voiceSampleRef?.id ?? null),
                  provider: identifyResult.provider, providerModel: identifyResult.providerModel,
                  score: top.score, confidence: top.score, quality: top.quality, decision: 'candidate', reasonCode: 'cross_modal_disagreement',
                });
                const faceEvidenceIds = strongFaces.map((face) => addFaceEvidence(face, 'candidate', 'cross_modal_disagreement'));
                return {
                  resolutionId: generateResolutionId(time),
                  status: 'unknown',
                  personId: null,
                  candidateMatches: [
                    { personId, score: top.score, confidence: top.score, reasonCodes: ['voice_profile_similarity', 'cross_modal_disagreement'] },
                    ...strongFaces.map((face) => ({ personId: face.personId, score: face.similarity, confidence: face.similarity, reasonCodes: ['face_profile_similarity', 'cross_modal_disagreement'] })),
                  ],
                  speakerLabel,
                  evidenceIds: [voiceEvidence.evidence.evidenceId, ...faceEvidenceIds],
                  requiresConfirmation: true,
                  reasonCode: 'cross_modal_disagreement',
                  presentPersonIds,
                };
              }

              const evidence = repository.addEvidence({
                evidenceType: 'voice_match', personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
                voiceSampleRef: typeof voiceSampleRef === 'string' ? voiceSampleRef : (voiceSampleRef?.id ?? null),
                provider: identifyResult.provider, providerModel: identifyResult.providerModel,
                score: top.score, confidence: top.score, quality: top.quality, decision: 'resolved',
                reasonCode: corroborating ? 'cross_modal_agreement' : 'voice_profile_similarity',
              });
              const evidenceIds = [evidence.evidence.evidenceId];
              if (corroborating) evidenceIds.push(addFaceEvidence(corroborating, 'resolved', 'cross_modal_agreement'));
              setContinuity(sessionId, speakerLabel, personId, time, evidenceIds);
              return { resolutionId: generateResolutionId(time), status: 'resolved', personId, candidateMatches: [], speakerLabel, evidenceIds, requiresConfirmation: false, reasonCode: corroborating ? 'cross_modal_agreement' : 'voice_profile_similarity', presentPersonIds };
            }

            // Medium-confidence or competing candidates: record as candidate
            // evidence, but NEVER silently resolve — matches spec's "medium
            // confidence voice match remains ambiguous" / "competing
            // candidates remain ambiguous" rules exactly.
            const evidenceIds = eligible.map((m) => {
              const pid = profileToPerson.get(m.voiceProfileId) ?? m.personId;
              const evidence = repository.addEvidence({
                evidenceType: 'voice_match', personId: pid, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
                voiceSampleRef: typeof voiceSampleRef === 'string' ? voiceSampleRef : (voiceSampleRef?.id ?? null),
                provider: identifyResult.provider, providerModel: identifyResult.providerModel,
                score: m.score, confidence: m.score, quality: m.quality, decision: 'candidate', reasonCode: 'voice_profile_similarity',
              });
              return evidence.evidence.evidenceId;
            });
            // A face is NOT allowed to break a voice tie. Under a worn
            // camera the person in frame is usually the one being spoken TO,
            // so letting presence settle "who is speaking" would confidently
            // pick the wrong candidate. Face readings are recorded alongside
            // the ambiguity; a human still settles it.
            const faceEvidenceIds = faces.map((face) => addFaceEvidence(face, 'candidate', 'face_seen_during_ambiguous_voice'));
            return {
              resolutionId: generateResolutionId(time),
              status: 'ambiguous',
              personId: null,
              candidateMatches: [
                ...eligible.map((m) => ({ personId: profileToPerson.get(m.voiceProfileId) ?? m.personId, score: m.score, confidence: m.score, reasonCodes: ['voice_profile_similarity'] })),
                ...faces.map((face) => ({ personId: face.personId, score: face.similarity, confidence: face.similarity, reasonCodes: ['face_profile_similarity'] })),
              ],
              speakerLabel,
              evidenceIds: [...evidenceIds, ...faceEvidenceIds],
              requiresConfirmation: true,
              reasonCode: eligible.length > 1 ? 'competing_voice_candidates' : 'single_unconfirmed_candidate',
              presentPersonIds,
            };
          }
        }
      }
    }

    // Face with no voice to corroborate it. This is the ordinary case for a
    // worn camera, and it is NOT a speaker resolution: seeing someone means
    // they are present, not that they are the one talking — most often they
    // are the person the wearer is talking to. It is recorded as presence
    // context and reported through `presentPersonIds`, and it deliberately
    // never sets session continuity.
    const faceEvidenceIds = faces.map((face) => addFaceEvidence(face, 'context_only', 'face_present_not_speaking'));

    // Passive name-mention context: NEVER identifies the current speaker —
    // only recorded as context evidence for a KNOWN existing person.
    const mentioned = detectKnownNameMentions(transcriptText, repository);
    if (mentioned.length) {
      const evidenceIds = mentioned.map((person) => repository.addEvidence({
        evidenceType: 'name_mention', personId: person.personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
        decision: 'context_only', reasonCode: 'name_mentioned_in_transcript',
      }).evidence.evidenceId);
      return { resolutionId: generateResolutionId(time), status: 'unknown', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [...faceEvidenceIds, ...evidenceIds], requiresConfirmation: false, reasonCode: 'name_mention_not_identity', presentPersonIds };
    }

    return {
      resolutionId: generateResolutionId(time),
      status: 'unknown',
      personId: null,
      candidateMatches: faces.map((face) => ({ personId: face.personId, score: face.similarity, confidence: face.similarity, reasonCodes: ['face_profile_similarity'] })),
      speakerLabel,
      evidenceIds: faceEvidenceIds,
      requiresConfirmation: false,
      reasonCode: faces.length ? 'face_presence_not_speaker' : 'no_evidence',
      presentPersonIds,
    };
  }

  /** "That was Matt." / "Speaker 1 is Matt." — explicit attribution by the primary user about (usually) someone else. High authority: may confirm a person outright. */
  function attribute({ sessionId = null, interactionId = null, turnId = null, speakerLabel, name, transcriptIds = [], time = now() }) {
    if (!name || !String(name).trim()) return { resolutionId: generateResolutionId(time), status: 'unknown', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [], requiresConfirmation: false, reasonCode: 'missing_name' };
    const found = findOrCreateForName(name, { identityStatus: 'confirmed', time });
    if (found.ambiguous) return ambiguousResult(found.candidates, speakerLabel, time, 'multiple_people_share_name');

    let person = found.person;
    if (!found.created && person.identityStatus !== 'confirmed' && person.identityStatus !== 'disputed') {
      repository.updatePerson(person.personId, { identityStatus: 'confirmed' });
      person = repository.getPerson(person.personId);
    }
    const evidence = repository.addEvidence({
      evidenceType: 'explicit_user_attribution', personId: person.personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
      decision: 'resolved', confidence: 0.9, reasonCode: found.created ? 'new_person_from_attribution' : 'existing_person_attribution',
    });
    clearRejected(sessionId, speakerLabel);
    setContinuity(sessionId, speakerLabel, person.personId, time, [evidence.evidence.evidenceId]);
    return { resolutionId: generateResolutionId(time), status: 'resolved', personId: person.personId, candidateMatches: [], speakerLabel, evidenceIds: [evidence.evidence.evidenceId], requiresConfirmation: false, reasonCode: found.created ? 'new_person_from_attribution' : 'existing_person_attribution' };
  }

  /** "Roma, this is Matt speaking." — self-identification. Evidence, but per spec requires confirmation before becoming strongly verified — never auto-resolves session continuity. */
  function selfIdentify({ sessionId = null, interactionId = null, turnId = null, speakerLabel, name, transcriptIds = [], time = now() }) {
    if (!name || !String(name).trim()) return { resolutionId: generateResolutionId(time), status: 'unknown', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [], requiresConfirmation: false, reasonCode: 'missing_name' };
    const found = findOrCreateForName(name, { identityStatus: 'provisional', provisionalReason: 'self-identification pending confirmation', time });
    if (found.ambiguous) return ambiguousResult(found.candidates, speakerLabel, time, 'multiple_people_share_name');

    const evidence = repository.addEvidence({
      evidenceType: 'explicit_self_identification', personId: found.person.personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
      decision: 'candidate', confidence: 0.6, reasonCode: 'self_identification_requires_confirmation',
    });
    return { resolutionId: generateResolutionId(time), status: 'provisional', personId: found.person.personId, candidateMatches: [{ personId: found.person.personId, score: 0.6, confidence: 0.6, reasonCodes: ['self_identification_requires_confirmation'] }], speakerLabel, evidenceIds: [evidence.evidence.evidenceId], requiresConfirmation: true, reasonCode: 'self_identification_requires_confirmation' };
  }

  /** User (or dev panel) confirms a candidate match — the only other path (besides attribute/correction) that can move a person to 'confirmed' and lock in session continuity. */
  function confirmMatch({ sessionId = null, interactionId = null, turnId = null, speakerLabel, personId, confirmedBy = 'user', time = now() }) {
    const person = repository.getPerson(personId);
    if (!person) return { resolutionId: generateResolutionId(time), status: 'unknown', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [], requiresConfirmation: false, reasonCode: 'person_not_found' };
    if (person.identityStatus === 'provisional' || person.identityStatus === 'candidate') repository.updatePerson(personId, { identityStatus: 'confirmed' });
    const evidence = repository.addEvidence({
      evidenceType: 'manual_confirmation', personId, speakerLabel, sessionId, interactionId, turnId,
      decision: 'confirmed', confirmedBy, confidence: 0.98, reasonCode: 'user_confirmed_match',
    });
    clearRejected(sessionId, speakerLabel);
    setContinuity(sessionId, speakerLabel, personId, time, [evidence.evidence.evidenceId]);
    return { resolutionId: generateResolutionId(time), status: 'resolved', personId, candidateMatches: [], speakerLabel, evidenceIds: [evidence.evidence.evidenceId], requiresConfirmation: false, reasonCode: 'manual_confirmation' };
  }

  /** User rejects a candidate — creates NEGATIVE evidence so Roma does not immediately repeat the same suggestion for this session/speaker slot. */
  function rejectMatch({ sessionId = null, interactionId = null, turnId = null, speakerLabel, personId, time = now() }) {
    const evidence = repository.addEvidence({
      evidenceType: 'manual_rejection', personId, speakerLabel, sessionId, interactionId, turnId,
      decision: 'rejected', reasonCode: 'user_rejected_match',
    });
    addRejected(sessionId, speakerLabel, personId);
    const continuity = getContinuity(sessionId, speakerLabel, time);
    if (continuity?.personId === personId) continuityStore.get(sessionKey(sessionId))?.delete(speakerLabel);
    return { resolutionId: generateResolutionId(time), status: 'rejected', personId: null, candidateMatches: [], speakerLabel, evidenceIds: [evidence.evidence.evidenceId], requiresConfirmation: false, reasonCode: 'manual_rejection' };
  }

  /** "I was wrong; that was Jon, not Matt." — highest-authority evidence; invalidates the earlier resolution for this session/speaker slot and re-resolves. */
  function correctIdentity({ sessionId = null, interactionId = null, turnId = null, speakerLabel, correctName, transcriptIds = [], time = now() }) {
    const previous = getContinuity(sessionId, speakerLabel, time);
    if (previous) {
      repository.addEvidence({ evidenceType: 'correction', personId: previous.personId, speakerLabel, sessionId, interactionId, turnId, decision: 'corrected', reasonCode: 'superseded_by_correction' });
      addRejected(sessionId, speakerLabel, previous.personId);
      continuityStore.get(sessionKey(sessionId))?.delete(speakerLabel);
    }
    const found = findOrCreateForName(correctName, { identityStatus: 'confirmed', time });
    if (found.ambiguous) return { ...ambiguousResult(found.candidates, speakerLabel, time, 'multiple_people_share_name'), previousPersonId: previous?.personId ?? null };

    let person = found.person;
    if (!found.created && person.identityStatus !== 'confirmed') {
      repository.updatePerson(person.personId, { identityStatus: 'confirmed' });
      person = repository.getPerson(person.personId);
    }
    const evidence = repository.addEvidence({
      evidenceType: 'correction', personId: person.personId, speakerLabel, sessionId, interactionId, turnId, transcriptIds,
      decision: 'resolved', confidence: 0.95, reasonCode: 'correction',
    });
    setContinuity(sessionId, speakerLabel, person.personId, time, [evidence.evidence.evidenceId]);
    return { resolutionId: generateResolutionId(time), status: 'resolved', personId: person.personId, candidateMatches: [], speakerLabel, evidenceIds: [evidence.evidence.evidenceId], requiresConfirmation: false, reasonCode: 'correction', previousPersonId: previous?.personId ?? null };
  }

  function invalidateSpeaker(sessionId, speakerLabel) {
    continuityStore.get(sessionKey(sessionId))?.delete(speakerLabel);
  }

  function invalidateSession(sessionId) {
    continuityStore.delete(sessionKey(sessionId));
    rejectedStore.delete(sessionKey(sessionId));
  }

  /** Invalidate every cached continuity entry pointing at `personId` — used after a merge/split/delete so a stale cached resolution can never survive the operation. */
  function invalidateForPerson(personId) {
    for (const sessionMap of continuityStore.values()) {
      for (const [speakerLabel, slot] of [...sessionMap.entries()]) {
        if (slot.personId === personId) sessionMap.delete(speakerLabel);
      }
    }
  }

  /**
   * Adopt a bounded result that has already passed the server-side voice
   * provider AND this same Entity Resolver. This never accepts raw provider
   * output, creates evidence, or upgrades a person; it only mirrors validated
   * session continuity into the browser runtime so the next Context Compiler
   * pass can use the safe person/evidence references.
   */
  function acceptServerResolution({ sessionId, speakerLabel, personId, evidenceIds = [], status, reasonCode = 'voice_profile_similarity', time = now() } = {}) {
    if (status !== 'resolved' || !sessionId || !speakerLabel || !personId || !evidenceIds.length) return { ok: false, reasonCode: 'invalid_server_resolution' };
    const person = repository.getPerson(personId);
    if (!person || person.status !== 'active') return { ok: false, reasonCode: 'person_not_found' };
    if (getRejected(sessionId, speakerLabel).has(personId)) return { ok: false, reasonCode: 'manual_rejection_preserved' };
    setContinuity(sessionId, speakerLabel, personId, time, evidenceIds.slice(0, 4));
    return { ok: true, status: 'resolved', personId, speakerLabel, evidenceIds: evidenceIds.slice(0, 4), reasonCode };
  }

  return {
    resolve,
    attribute,
    selfIdentify,
    confirmMatch,
    rejectMatch,
    correctIdentity,
    invalidateSpeaker,
    invalidateSession,
    invalidateForPerson,
    acceptServerResolution,
    endSession: invalidateSession,
    /** Read-only peek at current continuity, for diagnostics/tests — never writes evidence. */
    getContinuity: (sessionId, speakerLabel, time = now()) => getContinuity(sessionId, speakerLabel, time),
  };
}

export { identityEvidenceRank };
