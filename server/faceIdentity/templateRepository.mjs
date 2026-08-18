// Encrypted face-template storage. Deliberately the same shape as
// server/repositories/voiceTemplateRepository.mjs and using the SAME
// AES-256-GCM cipher and BIOMETRIC_ENCRYPTION_KEY, so there is one key
// management and rotation story for biometrics rather than two.
//
// A template is a 512-d embedding. It never leaves this process in plaintext,
// never enters a prompt, and never reaches the client bundle.

import { createTemplateCipher } from '../voiceIdentity/crypto.mjs';

const TEMPLATE_VERSION = 1;

function rowToProfile(row) {
  return {
    faceProfileId: row.face_profile_id,
    personId: row.person_id,
    provider: row.provider,
    model: row.model,
    modelRevision: row.model_revision,
    dimensions: row.dimensions,
    sampleCount: row.sample_count,
    aggregateQuality: row.aggregate_quality,
    status: row.status,
    consentId: row.consent_id,
    lastMatchedAt: row.last_matched_at,
    lastSimilarity: row.last_similarity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFaceTemplateRepository({ db, cipher = createTemplateCipher(), now = Date.now } = {}) {
  let counter = 0;

  return {
    get configured() { return cipher.configured; },
    status: () => cipher.status(),

    forWorkspace(workspaceId) {
      const api = {
        /** Store an embedding for a person. Returns the profile WITHOUT the template. */
        enroll({ personId, embedding, provider, model, modelRevision, quality = 1, consentId = null }) {
          if (!cipher.configured) return { ok: false, reasonCode: 'encryption_key_missing' };
          if (!personId) return { ok: false, reasonCode: 'person_required' };
          if (!embedding?.length) return { ok: false, reasonCode: 'empty_template' };

          counter += 1;
          const faceProfileId = `face_${now()}_${counter}`;
          const at = now();
          // The associated data binds the ciphertext to this profile and person:
          // a template moved to another row fails authentication instead of
          // silently identifying the wrong human being.
          const sealed = cipher.encrypt(embedding, { workspaceId, personId, profileId: faceProfileId });
          db.prepare(`INSERT INTO face_templates (
            face_profile_id, workspace_id, person_id, provider, model, model_revision, model_version,
            template_version, dimensions, encrypted_template, encryption_algorithm, encryption_nonce,
            encryption_auth_tag, encryption_key_version, sample_count, aggregate_quality, status,
            consent_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            faceProfileId, workspaceId, personId, provider, model, modelRevision, `${modelRevision}:${TEMPLATE_VERSION}`,
            TEMPLATE_VERSION, embedding.length, sealed.ciphertext, sealed.algorithm, sealed.nonce,
            sealed.authTag, sealed.keyVersion, 1, quality, 'active',
            consentId, at, at,
          );
          return { ok: true, profile: api.get(faceProfileId) };
        },

        get(faceProfileId) {
          const row = db.prepare('SELECT * FROM face_templates WHERE face_profile_id = ? AND workspace_id = ?').get(faceProfileId, workspaceId);
          return row ? rowToProfile(row) : null;
        },

        listForPerson(personId) {
          return db.prepare("SELECT * FROM face_templates WHERE workspace_id = ? AND person_id = ? AND status = 'active' ORDER BY created_at")
            .all(workspaceId, personId).map(rowToProfile);
        },

        listActive() {
          return db.prepare("SELECT * FROM face_templates WHERE workspace_id = ? AND status = 'active' ORDER BY created_at").all(workspaceId).map(rowToProfile);
        },

        /** Decrypt one template. The ONLY path plaintext exists on, and it is server-side. */
        openTemplate(faceProfileId) {
          const row = db.prepare('SELECT * FROM face_templates WHERE face_profile_id = ? AND workspace_id = ?').get(faceProfileId, workspaceId);
          if (!row || row.status !== 'active') return null;
          try {
            return cipher.decrypt(
              { algorithm: row.encryption_algorithm, keyVersion: row.encryption_key_version, nonce: row.encryption_nonce, authTag: row.encryption_auth_tag, ciphertext: row.encrypted_template },
              { workspaceId, personId: row.person_id, profileId: row.face_profile_id },
            );
          } catch { return null; } // a tampered or unkeyed row identifies nobody
        },

        recordMatch(faceProfileId, similarity) {
          db.prepare('UPDATE face_templates SET last_matched_at = ?, last_similarity = ?, updated_at = ? WHERE face_profile_id = ? AND workspace_id = ?')
            .run(now(), similarity, now(), faceProfileId, workspaceId);
        },

        /** Revoking is reversible bookkeeping; deleting destroys the biometric. */
        revoke(faceProfileId) {
          const result = db.prepare("UPDATE face_templates SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE face_profile_id = ? AND workspace_id = ?")
            .run(now(), now(), faceProfileId, workspaceId);
          return { ok: result.changes > 0 };
        },

        delete(faceProfileId) {
          const result = db.prepare('DELETE FROM face_templates WHERE face_profile_id = ? AND workspace_id = ?').run(faceProfileId, workspaceId);
          return { ok: result.changes > 0 };
        },

        deleteForPerson(personId) {
          return { deleted: db.prepare('DELETE FROM face_templates WHERE workspace_id = ? AND person_id = ?').run(workspaceId, personId).changes };
        },
      };
      return api;
    },
  };
}
