// Face identity service — enrollment and identification.
//
// CONSENT IS NOT ENFORCED IN THIS BUILD. Voice identity refuses to enrol
// without an active consent record; face identity currently does not, because
// enforcement was turned off for integration. Set FACE_IDENTITY_REQUIRE_CONSENT=1
// to restore it — the consent_id column, the checks, and the revocation path
// all still exist, so this is a switch rather than a rewrite.
//
// That matters more here than anywhere else in Roma: everything else needs
// someone to speak, but a face is captured by being present. A bystander in
// front of the glasses never opted in. See PLAN-FACE-IDENTITY.md.
//
// The output is EVIDENCE, never authentication. A match cannot grant access,
// and it is outranked by anything a human actually said (see
// IDENTITY_EVIDENCE_TYPES). There is no liveness detection: a printed
// photograph may match.

import { createFaceProvider, cosineSimilarity, EMBED_DIMS } from './provider.mjs';
import { createFaceTemplateRepository } from './templateRepository.mjs';

// Measured on the pinned encoder against InsightFace's own group photo:
// different people in one image scored max 0.214 (mean 0.033), while the same
// face across a JPEG re-encode scored 0.998. 0.40 sits well clear of the
// observed impostor ceiling without crowding the genuine range — but it is
// calibrated on ONE photograph and is not an accuracy claim.
const DEFAULT_MATCH_THRESHOLD = Number(process.env.FACE_IDENTITY_MATCH_THRESHOLD ?? 0.40);
// A match must also beat the runner-up by this much, or the frame is ambiguous
// and resolves to nobody rather than to whoever happened to score highest.
const DEFAULT_MARGIN = Number(process.env.FACE_IDENTITY_MATCH_MARGIN ?? 0.06);

export function createFaceIdentityService({
  db,
  provider = createFaceProvider(),
  repository = null,
  requireConsent = process.env.FACE_IDENTITY_REQUIRE_CONSENT === '1',
  matchThreshold = DEFAULT_MATCH_THRESHOLD,
  margin = DEFAULT_MARGIN,
  consentRepository = null,
} = {}) {
  const templates = repository ?? createFaceTemplateRepository({ db });

  function describe() {
    return {
      ...provider.describe(),
      configured: templates.configured,
      requireConsent,
      matchThreshold,
      margin,
      note: requireConsent ? 'consent enforced' : 'CONSENT NOT ENFORCED — development configuration',
    };
  }

  function consentOk(workspaceId, personId) {
    if (!requireConsent) return { ok: true, consentId: null };
    const active = consentRepository?.forWorkspace?.(workspaceId)?.activeFor?.({ personId, purpose: 'face_identity' });
    return active ? { ok: true, consentId: active.consentId } : { ok: false, reasonCode: 'active_consent_required' };
  }

  return {
    describe,
    templates,

    /** Detect every face in an image. No storage, no matching — perception only. */
    async detect(imageBuffer) {
      const faces = await provider.detect(imageBuffer);
      return { ok: true, faces: faces.map(({ score, x1, y1, x2, y2 }) => ({ score, x1, y1, x2, y2 })), count: faces.length };
    },

    /** Enrol the largest face in an image against a person. */
    async enroll({ workspaceId, personId, imageBuffer }) {
      if (!templates.configured) return { ok: false, reasonCode: 'encryption_key_missing' };
      const consent = consentOk(workspaceId, personId);
      if (!consent.ok) return { ok: false, reasonCode: consent.reasonCode };

      const faces = await provider.detect(imageBuffer);
      if (!faces.length) return { ok: false, reasonCode: 'no_face_detected' };
      if (faces.length > 1) return { ok: false, reasonCode: 'multiple_faces', count: faces.length };

      const embedding = await provider.embed(imageBuffer, faces[0]);
      if (embedding.length !== EMBED_DIMS) return { ok: false, reasonCode: 'unexpected_template_size' };
      const described = provider.describe();
      return templates.forWorkspace(workspaceId).enroll({
        personId,
        embedding,
        provider: described.provider,
        model: described.repo,
        modelRevision: described.revision,
        quality: faces[0].score,
        consentId: consent.consentId,
      });
    },

    /**
     * Identify faces in an image against enrolled profiles.
     * Returns candidates, never a decision — the identity resolver decides.
     */
    async identify({ workspaceId, imageBuffer, candidatePersonIds = null }) {
      if (!templates.configured) return { ok: false, reasonCode: 'encryption_key_missing' };
      const scoped = templates.forWorkspace(workspaceId);
      const profiles = scoped.listActive().filter((p) => !candidatePersonIds || candidatePersonIds.includes(p.personId));
      if (!profiles.length) return { ok: true, faces: [], reasonCode: 'no_enrolled_profiles' };

      const enrolled = [];
      for (const profile of profiles) {
        const template = scoped.openTemplate(profile.faceProfileId);
        if (template) enrolled.push({ profile, template });
      }

      const detected = await provider.detect(imageBuffer);
      const results = [];
      for (const face of detected) {
        const embedding = await provider.embed(imageBuffer, face);
        const scored = enrolled
          .map(({ profile, template }) => ({ personId: profile.personId, faceProfileId: profile.faceProfileId, similarity: cosineSimilarity(embedding, template) }))
          .sort((a, b) => b.similarity - a.similarity);

        const best = scored[0] ?? null;
        const runnerUp = scored[1] ?? null;
        // Ambiguity resolves to nobody. Two people who look alike must not be
        // silently collapsed into whichever scored a hair higher.
        const decisive = best
          && best.similarity >= matchThreshold
          && (!runnerUp || best.similarity - runnerUp.similarity >= margin);

        if (decisive) scoped.recordMatch(best.faceProfileId, best.similarity);
        results.push({
          box: { score: face.score, x1: face.x1, y1: face.y1, x2: face.x2, y2: face.y2 },
          match: decisive ? { personId: best.personId, faceProfileId: best.faceProfileId, similarity: best.similarity } : null,
          reasonCode: decisive ? 'matched' : (best && best.similarity >= matchThreshold ? 'ambiguous' : 'below_threshold'),
          bestSimilarity: best?.similarity ?? 0,
        });
      }
      return { ok: true, faces: results };
    },
  };
}
