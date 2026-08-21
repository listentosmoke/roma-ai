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

import { createFaceProvider, cosineSimilarity, averageEmbeddings, faceQuality, EMBED_DIMS } from './provider.mjs';
import { createFaceTemplateRepository } from './templateRepository.mjs';

// Measured on the pinned encoder (flip-augmented) against InsightFace's own
// group photograph. Impostors — six different people in one image — peaked at
// 0.216 (mean 0.041). The same face survived jpeg q40, a 50% downscale, +25%
// brightness, a 1.5px blur and a 7-degree rotation with a WORST score of 0.951.
// That is a separation of 0.735, so 0.50 sits far from both populations: well
// above anything an impostor reached, far below anything genuine lost.
// Calibrated on one photograph, so it is a sane default, not an accuracy claim.
const DEFAULT_MATCH_THRESHOLD = Number(process.env.FACE_IDENTITY_MATCH_THRESHOLD ?? 0.50);
// A match must also beat the runner-up by this much, or the frame is ambiguous
// and resolves to nobody rather than to whoever happened to score highest.
const DEFAULT_MARGIN = Number(process.env.FACE_IDENTITY_MATCH_MARGIN ?? 0.06);

export function createFaceIdentityService({
  db,
  provider = createFaceProvider(),
  repository = null,
  // Enrollment frames are kept as redundancy for the template (see
  // server/faceIdentity/imageStore.mjs). Recognition frames never are.
  imageStore = null,
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
      keepsEnrollmentImages: Boolean(imageStore),
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

    /**
     * Enrol a person from one or more images.
     *
     * Multiple images are averaged into a single template: one frame binds a
     * person to one pose and one lighting condition, which is how recognition
     * quietly gets worse the moment they turn their head.
     */
    async enroll({ workspaceId, personId, imageBuffer, imageBuffers = null }) {
      const images = imageBuffers?.length ? imageBuffers : [imageBuffer];
      const consent = consentOk(workspaceId, personId);
      if (!consent.ok) return { ok: false, reasonCode: consent.reasonCode };

      const embeddings = [];
      const rejected = [];
      // Only the frames that actually contributed are worth keeping: a frame
      // with no face in it is not a picture of this person.
      const usedImages = [];
      let bestQuality = 0;
      for (const image of images) {
        const faces = await provider.detect(image);
        if (!faces.length) { rejected.push('no_face_detected'); continue; }
        if (faces.length > 1) { rejected.push('multiple_faces'); continue; }
        const quality = faceQuality(faces[0]);
        if (!quality.ok) { rejected.push(quality.reasonCode); continue; }
        embeddings.push(await provider.embed(image, faces[0]));
        usedImages.push(image);
        bestQuality = Math.max(bestQuality, faces[0].score);
      }
      if (!embeddings.length) return { ok: false, reasonCode: rejected[0] ?? 'no_usable_face', rejected };

      const template = averageEmbeddings(embeddings);
      if (template?.length !== EMBED_DIMS) return { ok: false, reasonCode: 'unexpected_template_size' };
      const described = provider.describe();
      const result = templates.forWorkspace(workspaceId).enroll({
        personId,
        embedding: template,
        provider: described.provider,
        model: described.repo,
        modelRevision: described.revision,
        quality: bestQuality,
        sampleCount: embeddings.length,
        consentId: consent.consentId,
      });
      if (!result.ok) return result;

      // Keep the frames this template came from, so a model change or a
      // corrupt row means a re-embed rather than asking the person to sit in
      // front of a camera again. Failing to store them is not a failed
      // enrollment — the template is what identifies; these are the backup.
      const saved = imageStore
        ? imageStore.save({ workspaceId, faceProfileId: result.profile.faceProfileId, images: usedImages })
        : { ok: false, stored: 0, reasonCode: 'image_store_disabled' };

      return { ...result, samplesUsed: embeddings.length, rejected, imagesStored: saved.stored, imageReasonCode: saved.ok ? null : saved.reasonCode };
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
        // The same gate enrollment uses, reported rather than enforced: a
        // small, dim or turned-away face still gets a similarity here, but
        // downstream (src/identity/resolver.js) refuses to treat a low-quality
        // observation as evidence about who someone is. Enrollment rejects
        // outright; identification reports, because the Inspector can
        // usefully label a track it would be wrong to build identity on.
        const quality = faceQuality(face);
        results.push({
          box: { score: face.score, x1: face.x1, y1: face.y1, x2: face.x2, y2: face.y2 },
          match: decisive ? { personId: best.personId, faceProfileId: best.faceProfileId, similarity: best.similarity } : null,
          quality: { ok: quality.ok, value: quality.ok ? face.score : 0, reasonCode: quality.ok ? null : quality.reasonCode, size: quality.size },
          reasonCode: decisive ? 'matched' : (best && best.similarity >= matchThreshold ? 'ambiguous' : 'below_threshold'),
          bestSimilarity: best?.similarity ?? 0,
        });
      }
      return { ok: true, faces: results };
    },
  };
}
