import { randomUUID } from 'node:crypto';

function metadataFromRow(row) {
  if (!row) return null;
  return {
    voiceProfileId: row.voice_profile_id,
    personId: row.person_id,
    provider: row.provider,
    model: row.model,
    modelRevision: row.model_revision,
    modelVersion: row.model_version,
    templateVersion: row.template_version,
    dimensions: row.dimensions,
    encryptionAlgorithm: row.encryption_algorithm,
    encryptionKeyVersion: row.encryption_key_version,
    sampleCount: row.sample_count,
    aggregateQuality: row.aggregate_quality,
    status: row.status,
    consentId: row.consent_id,
    lastMatchedAt: row.last_matched_at,
    lastSimilarity: row.last_similarity,
    lastQuality: row.last_quality,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    sensitivity: 'biometric',
  };
}

function internalFromRow(row) {
  if (!row) return null;
  return {
    ...metadataFromRow(row),
    encrypted: {
      algorithm: row.encryption_algorithm,
      keyVersion: row.encryption_key_version,
      nonce: row.encryption_nonce,
      authTag: row.encryption_auth_tag,
      ciphertext: row.encrypted_template,
    },
  };
}

export function createVoiceTemplateRepository({ db, now = Date.now } = {}) {
  function forWorkspace(workspaceId, userId) {
    function readInternal(voiceProfileId) {
      return internalFromRow(db.prepare('SELECT * FROM voice_templates WHERE voice_profile_id = ? AND workspace_id = ? AND deleted_at IS NULL').get(voiceProfileId, workspaceId));
    }

    return {
      create({ voiceProfileId = `voice_profile_${randomUUID()}`, personId, consentId, providerResult, encrypted, quality }) {
        const person = db.prepare("SELECT person_id FROM people WHERE person_id = ? AND workspace_id = ? AND status = 'active'").get(personId, workspaceId);
        if (!person) return { ok: false, reasonCode: 'person_not_found' };
        const consent = db.prepare("SELECT * FROM consent_records WHERE consent_id = ? AND workspace_id = ? AND person_id = ? AND scope = 'voice_identity' AND status = 'active'").get(consentId, workspaceId, personId);
        if (!consent) return { ok: false, reasonCode: 'active_consent_required' };
        const at = now();
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO voice_profile_refs (voice_profile_id, workspace_id, person_id, provider, provider_model, quality, consent_id, created_at, revoked_at, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
            .run(voiceProfileId, workspaceId, personId, providerResult.provider, providerResult.model, quality, consentId, at, 'biometric');
          db.prepare(`INSERT INTO voice_templates
            (voice_profile_id, workspace_id, person_id, provider, model, model_revision, model_version, template_version, dimensions, encrypted_template, encryption_algorithm, encryption_nonce, encryption_auth_tag, encryption_key_version, sample_count, aggregate_quality, status, consent_id, created_at, updated_at, sensitivity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?, ?, ?, 'biometric')`)
            .run(voiceProfileId, workspaceId, personId, providerResult.provider, providerResult.model, providerResult.modelRevision, providerResult.modelVersion, providerResult.templateVersion, providerResult.dimensions, encrypted.ciphertext, encrypted.algorithm, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, quality, consentId, at, at);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          if (String(error.message).includes('UNIQUE')) return { ok: false, reasonCode: 'profile_already_exists' };
          throw error;
        }
        return { ok: true, profile: metadataFromRow(db.prepare('SELECT * FROM voice_templates WHERE voice_profile_id = ?').get(voiceProfileId)) };
      },

      replaceTemplate(voiceProfileId, { encrypted, quality, sampleCount, modelVersion, modelRevision, templateVersion, dimensions }) {
        const current = readInternal(voiceProfileId);
        if (!current || current.status !== 'active') return { ok: false, reasonCode: 'profile_not_active' };
        if (current.modelVersion !== modelVersion) return { ok: false, reasonCode: 'incompatible_model_version' };
        db.prepare(`UPDATE voice_templates SET encrypted_template=?, encryption_algorithm=?, encryption_nonce=?, encryption_auth_tag=?, encryption_key_version=?, aggregate_quality=?, sample_count=?, model_revision=?, template_version=?, dimensions=?, updated_at=? WHERE voice_profile_id=? AND workspace_id=?`)
          .run(encrypted.ciphertext, encrypted.algorithm, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, quality, sampleCount, modelRevision, templateVersion, dimensions, now(), voiceProfileId, workspaceId);
        db.prepare('UPDATE voice_profile_refs SET quality=?, provider_model=? WHERE voice_profile_id=? AND workspace_id=?').run(quality, current.model, voiceProfileId, workspaceId);
        return { ok: true, profile: metadataFromRow(db.prepare('SELECT * FROM voice_templates WHERE voice_profile_id = ? AND workspace_id = ? AND deleted_at IS NULL').get(voiceProfileId, workspaceId)) };
      },

      getMetadata(voiceProfileId) {
        return metadataFromRow(db.prepare('SELECT * FROM voice_templates WHERE voice_profile_id = ? AND workspace_id = ? AND deleted_at IS NULL').get(voiceProfileId, workspaceId));
      },

      getForProvider(voiceProfileId) {
        const record = readInternal(voiceProfileId);
        return record?.status === 'active' && !record.revokedAt ? record : null;
      },

      listMetadataForPerson(personId) {
        return db.prepare('SELECT * FROM voice_templates WHERE workspace_id = ? AND person_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(workspaceId, personId).map(metadataFromRow);
      },

      listMetadataForConsent(consentId) {
        return db.prepare('SELECT * FROM voice_templates WHERE workspace_id = ? AND consent_id = ? AND deleted_at IS NULL').all(workspaceId, consentId).map(metadataFromRow);
      },

      listActiveForCandidates(personIds = [], limit = 12) {
        const bounded = [...new Set(personIds)].slice(0, limit);
        if (!bounded.length) return [];
        const placeholders = bounded.map(() => '?').join(',');
        return db.prepare(`SELECT * FROM voice_templates WHERE workspace_id = ? AND person_id IN (${placeholders}) AND status = 'active' AND revoked_at IS NULL AND deleted_at IS NULL ORDER BY last_matched_at DESC, updated_at DESC LIMIT ?`)
          .all(workspaceId, ...bounded, Math.max(1, Math.min(limit, 12))).map(internalFromRow);
      },

      markMatch(voiceProfileId, { similarity, quality }) {
        db.prepare('UPDATE voice_templates SET last_matched_at=?, last_similarity=?, last_quality=?, updated_at=? WHERE voice_profile_id=? AND workspace_id=? AND status=?')
          .run(now(), similarity, quality, now(), voiceProfileId, workspaceId, 'active');
      },

      revokeByConsent(consentId) {
        const at = now();
        const result = db.prepare("UPDATE voice_templates SET status='revoked', revoked_at=?, updated_at=? WHERE workspace_id=? AND consent_id=? AND status='active'").run(at, at, workspaceId, consentId);
        db.prepare('UPDATE voice_profile_refs SET revoked_at=? WHERE workspace_id=? AND consent_id=? AND revoked_at IS NULL').run(at, workspaceId, consentId);
        return { ok: true, revoked: result.changes };
      },

      disableIncompatible(modelVersion) {
        const at = now();
        const result = db.prepare("UPDATE voice_templates SET status='requires_reenrollment', updated_at=? WHERE workspace_id=? AND model_version != ? AND status='active'").run(at, workspaceId, modelVersion);
        return { ok: true, disabled: result.changes };
      },

      delete(voiceProfileId) {
        const profile = readInternal(voiceProfileId);
        if (!profile) return { ok: false, reasonCode: 'profile_not_found' };
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM voice_templates WHERE voice_profile_id = ? AND workspace_id = ?').run(voiceProfileId, workspaceId);
          db.prepare('DELETE FROM voice_profile_refs WHERE voice_profile_id = ? AND workspace_id = ?').run(voiceProfileId, workspaceId);
          db.prepare('INSERT INTO tombstones (tombstone_id, workspace_id, resource_type, resource_id, deletion_kind, deleted_at, operation_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
            .run(`tomb_voice_${randomUUID()}`, workspaceId, 'voice_profile', voiceProfileId, 'hard', now());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return { ok: true, deleted: true, personId: profile.personId };
      },

      count() {
        return db.prepare('SELECT COUNT(*) AS count FROM voice_templates WHERE workspace_id = ? AND deleted_at IS NULL').get(workspaceId).count;
      },
    };
  }
  return { forWorkspace };
}

export { metadataFromRow };
