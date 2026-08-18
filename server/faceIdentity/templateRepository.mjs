// Face-template storage.
//
// Templates are stored as PLAIN base64 float32 — no application-level
// encryption. The device this runs on uses full-disk encryption, so a second
// at-rest layer was judged redundant for a local single-user deployment.
// Migration 0006 records what that trades away: the AES-GCM layer also bound
// each template to its workspace+person+profile, so a row edited to point at a
// different person failed to open rather than misidentifying them.
//
// Voice templates are NOT affected and remain AES-256-GCM encrypted.
//
// A template is a 512-d embedding. It still never crosses the wire, never
// enters a prompt, and never reaches the client bundle.

const TEMPLATE_VERSION = 2; // 2 = plaintext storage

function encodeTemplate(embedding) {
  return Buffer.from(new Float32Array(embedding).buffer).toString('base64');
}

function decodeTemplate(text) {
  if (!text) return null;
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

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

export function createFaceTemplateRepository({ db, now = Date.now } = {}) {
  let counter = 0;

  return {
    // Nothing to configure: no key is needed to store or read a template, so
    // face identity no longer fails closed without BIOMETRIC_ENCRYPTION_KEY.
    get configured() { return true; },
    status: () => ({ atRestEncryption: false, note: 'plaintext templates; relies on full-disk encryption' }),

    forWorkspace(workspaceId) {
      const api = {
        /** Store an embedding for a person. Returns the profile WITHOUT the template. */
        enroll({ personId, embedding, provider, model, modelRevision, quality = 1, sampleCount = 1, consentId = null }) {
          if (!personId) return { ok: false, reasonCode: 'person_required' };
          if (!embedding?.length) return { ok: false, reasonCode: 'empty_template' };

          counter += 1;
          const faceProfileId = `face_${now()}_${counter}`;
          const at = now();
          db.prepare(`INSERT INTO face_templates (
            face_profile_id, workspace_id, person_id, provider, model, model_revision, model_version,
            template_version, dimensions, template_plain, encrypted_template, encryption_algorithm,
            encryption_nonce, encryption_auth_tag, encryption_key_version, sample_count,
            aggregate_quality, status, consent_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            faceProfileId, workspaceId, personId, provider, model, modelRevision, `${modelRevision}:${TEMPLATE_VERSION}`,
            TEMPLATE_VERSION, embedding.length, encodeTemplate(embedding), '', 'none',
            '', '', 0, sampleCount,
            quality, 'active', consentId, at, at,
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

        /** Read one template back as a Float32Array. Server-side only. */
        openTemplate(faceProfileId) {
          const row = db.prepare('SELECT * FROM face_templates WHERE face_profile_id = ? AND workspace_id = ?').get(faceProfileId, workspaceId);
          if (!row || row.status !== 'active') return null;
          try {
            const template = decodeTemplate(row.template_plain);
            // A malformed row identifies nobody rather than producing a vector
            // of the wrong length that could score against anything.
            return template && template.length === row.dimensions ? template : null;
          } catch { return null; }
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
