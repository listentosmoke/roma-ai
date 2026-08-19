// Server-owned, SQLite-backed Person Repository. Implements the interface
// src/identity/repository.js's client repository exposes (createPerson/
// getPerson/updatePerson/findByName/findByAlias/findCandidates/listPeople/
// addEvidence/getEvidence/listEvidenceForPerson/linkVoiceProfile/
// unlinkVoiceProfile/linkMemory/unlinkMemory/mergePeople/splitPerson/
// deletePerson/exportPerson/exportAll + relationship CRUD), so
// src/identity/resolver.js and coordinator.js never change.
//
// KEY DESIGN DIFFERENCE FROM THE CLIENT REPOSITORY: aliases, voice-profile
// references, relationship memberships, linked memories, and evidence are
// all normalized tables with real foreign keys here (person_aliases,
// voice_profile_refs, relationships, memory_entity_links, identity_evidence)
// instead of denormalized JSON arrays on the person row. getPerson()
// reconstructs `aliases`/`voiceProfileIds`/`relationshipIds`/
// `linkedMemoryIds`/`sourceEvidenceIds` by querying those tables live. This
// is what structurally fixes the known "deleteBySource doesn't unlink
// identity" gap (see memoryRepository.mjs) — there is no separate array to
// forget to update; the join simply stops returning a deleted memory.

import { validatePerson, validateEvidence, validateRelationship } from '../../src/identity/schema.js';
import { generatePersonId, generateEvidenceId, generateRelationshipId } from '../../src/identity/repository.js';

function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { if (text == null) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

export function createSqliteIdentityRepository({ db, now = Date.now }) {
  function forWorkspace(workspaceId, userId) {
    function readAliases(personId) {
      return db.prepare('SELECT * FROM person_aliases WHERE person_id = ? ORDER BY created_at').all(personId)
        .map((r) => ({ alias: r.alias, normalizedAlias: r.normalized_alias, type: r.type, confidence: r.confidence, sourceEvidenceIds: fromJson(r.source_evidence_ids, []) }));
    }
    function readVoiceProfileIds(personId) {
      return db.prepare('SELECT voice_profile_id FROM voice_profile_refs WHERE person_id = ? AND revoked_at IS NULL').all(personId).map((r) => r.voice_profile_id);
    }
    // Face profiles are not a separate ref table: face_templates already
    // carries person_id, so the person's list is derived from the templates
    // that actually exist rather than from a second list that could drift.
    function readFaceProfileIds(personId) {
      try {
        return db.prepare("SELECT face_profile_id FROM face_templates WHERE workspace_id = ? AND person_id = ? AND status = 'active'").all(workspaceId, personId).map((r) => r.face_profile_id);
      } catch {
        return []; // the face_identity migration has not run in this database
      }
    }
    function readRelationshipIds(personId) {
      return db.prepare('SELECT relationship_id FROM relationships WHERE workspace_id = ? AND (from_entity_id = ? OR to_entity_id = ?)').all(workspaceId, personId, personId).map((r) => r.relationship_id);
    }
    function readLinkedMemoryIds(personId) {
      return [...new Set(db.prepare('SELECT memory_id FROM memory_entity_links WHERE person_id = ?').all(personId).map((r) => r.memory_id))];
    }
    function readSourceEvidenceIds(personId) {
      return db.prepare('SELECT evidence_id FROM identity_evidence WHERE workspace_id = ? AND person_id = ?').all(workspaceId, personId).map((r) => r.evidence_id);
    }

    function rowToPerson(row) {
      return {
        personId: row.person_id,
        schemaVersion: row.schema_version,
        entityType: row.entity_type,
        displayName: row.display_name,
        status: row.status,
        identityStatus: row.identity_status,
        aliases: readAliases(row.person_id),
        roles: fromJson(row.roles, []),
        attributes: fromJson(row.attributes, {}),
        voiceProfileIds: readVoiceProfileIds(row.person_id),
        faceProfileIds: readFaceProfileIds(row.person_id),
        relationshipIds: readRelationshipIds(row.person_id),
        linkedMemoryIds: readLinkedMemoryIds(row.person_id),
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastObservedAt: row.last_observed_at,
        mergedInto: row.merged_into,
        supersedes: fromJson(row.supersedes, []),
        sourceEvidenceIds: readSourceEvidenceIds(row.person_id),
        provisionalReason: row.provisional_reason,
      };
    }

    function readPersonRow(personId, { includeInactive = true } = {}) {
      const row = db.prepare('SELECT * FROM people WHERE person_id = ? AND workspace_id = ?').get(personId, workspaceId);
      if (!row) return null;
      if (!includeInactive && row.status !== 'active') return null;
      return row;
    }

    function writeAliases(personId, aliases) {
      db.prepare('DELETE FROM person_aliases WHERE person_id = ?').run(personId);
      const insert = db.prepare('INSERT INTO person_aliases (alias_id, workspace_id, person_id, alias, normalized_alias, type, confidence, source_evidence_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const at = now();
      let i = 0;
      for (const a of aliases) insert.run(`alias_${at}_${personId}_${i++}`, workspaceId, personId, a.alias, a.normalizedAlias, a.type, a.confidence, toJson(a.sourceEvidenceIds), at);
    }

    const PERSON_CORE_COLUMNS = ['person_id', 'workspace_id', 'user_id', 'schema_version', 'entity_type', 'display_name', 'status', 'identity_status', 'roles', 'attributes', 'confidence', 'sensitivity', 'created_at', 'updated_at', 'last_observed_at', 'merged_into', 'supersedes', 'provisional_reason'];
    function personToParams(person) {
      return [person.personId, workspaceId, userId, person.schemaVersion, person.entityType, person.displayName, person.status, person.identityStatus, toJson(person.roles), toJson(person.attributes), person.confidence, person.sensitivity, person.createdAt, person.updatedAt, person.lastObservedAt, person.mergedInto, toJson(person.supersedes), person.provisionalReason];
    }

    const api = {
      createPerson(raw) {
        const personId = raw.personId ?? generatePersonId(now());
        const validation = validatePerson({ ...raw, personId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
        if (!validation.ok) return { ok: false, person: null, errors: validation.errors };
        const placeholders = PERSON_CORE_COLUMNS.map(() => '?').join(', ');
        db.prepare(`INSERT INTO people (${PERSON_CORE_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...personToParams(validation.person));
        writeAliases(personId, validation.person.aliases);
        return { ok: true, person: api.getPerson(personId), errors: [] };
      },

      getPerson(personId) {
        const row = readPersonRow(personId);
        return row ? rowToPerson(row) : null;
      },

      updatePerson(personId, patch) {
        const row = readPersonRow(personId);
        if (!row) return { ok: false, person: null, errors: [`no person with id ${personId}`] };
        const merged = { ...rowToPerson(row), ...patch, personId, updatedAt: now() };
        const validation = validatePerson(merged);
        if (!validation.ok) return { ok: false, person: null, errors: validation.errors };
        const setClause = PERSON_CORE_COLUMNS.filter((c) => !['person_id', 'workspace_id', 'user_id'].includes(c)).map((c) => `${c} = ?`).join(', ');
        const params = personToParams(validation.person).slice(3);
        db.prepare(`UPDATE people SET ${setClause} WHERE person_id = ? AND workspace_id = ?`).run(...params, personId, workspaceId);
        if (patch.aliases) writeAliases(personId, validation.person.aliases);
        return { ok: true, person: api.getPerson(personId), errors: [] };
      },

      findByName(name, { includeInactive = false } = {}) {
        const needle = String(name ?? '').trim().toLowerCase();
        if (!needle) return [];
        const statusClause = includeInactive ? '' : "AND p.status = 'active'";
        const rows = db.prepare(`
          SELECT DISTINCT p.* FROM people p LEFT JOIN person_aliases a ON a.person_id = p.person_id
          WHERE p.workspace_id = ? ${statusClause} AND (LOWER(p.display_name) = ? OR a.normalized_alias = ?)
        `).all(workspaceId, needle, needle);
        return rows.map(rowToPerson);
      },

      findByAlias(alias) { return api.findByName(alias); },

      findCandidates({ query = '', includeInactive = false, limit = 10 } = {}) {
        const needle = String(query ?? '').trim().toLowerCase();
        if (!needle) return [];
        const statusClause = includeInactive ? '' : "AND p.status = 'active'";
        const rows = db.prepare(`
          SELECT DISTINCT p.* FROM people p LEFT JOIN person_aliases a ON a.person_id = p.person_id
          WHERE p.workspace_id = ? ${statusClause} AND (LOWER(p.display_name) LIKE ? OR a.normalized_alias LIKE ?)
          LIMIT ?
        `).all(workspaceId, `%${needle}%`, `%${needle}%`, limit);
        return rows.map(rowToPerson);
      },

      listPeople(filters = {}) {
        const clauses = ['workspace_id = ?'];
        const params = [workspaceId];
        if (!filters.includeInactive) { clauses.push("status != 'deleted'"); }
        if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
        if (filters.identityStatus) { clauses.push('identity_status = ?'); params.push(filters.identityStatus); }
        if (filters.sensitivity) { clauses.push('sensitivity = ?'); params.push(filters.sensitivity); }
        const rows = db.prepare(`SELECT * FROM people WHERE ${clauses.join(' AND ')}`).all(...params);
        return rows.map(rowToPerson);
      },

      addEvidence(raw) {
        const evidenceId = raw.evidenceId ?? generateEvidenceId(now());
        const validation = validateEvidence({ ...raw, evidenceId, createdAt: raw.createdAt ?? now() });
        if (!validation.ok) return { ok: false, evidence: null, errors: validation.errors };
        const e = validation.evidence;
        db.prepare(`INSERT INTO identity_evidence (evidence_id, workspace_id, user_id, schema_version, evidence_type, person_id, speaker_label, session_id, interaction_id, turn_id, transcript_ids, voice_sample_ref, face_profile_id, provider, provider_model, score, confidence, quality, decision, reason_code, confirmed_by, created_at, expires_at, sensitivity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(e.evidenceId, workspaceId, userId, e.schemaVersion, e.evidenceType, e.personId, e.speakerLabel, e.sessionId, e.interactionId, e.turnId, toJson(e.transcriptIds), e.voiceSampleRef, e.faceProfileId, e.provider, e.providerModel, e.score, e.confidence, e.quality, e.decision, e.reasonCode, e.confirmedBy, e.createdAt, e.expiresAt, e.sensitivity);
        if (e.personId) db.prepare('UPDATE people SET last_observed_at = ? WHERE person_id = ? AND workspace_id = ?').run(e.createdAt, e.personId, workspaceId);
        return { ok: true, evidence: e, errors: [] };
      },

      getEvidence(evidenceId) {
        const row = db.prepare('SELECT * FROM identity_evidence WHERE evidence_id = ? AND workspace_id = ?').get(evidenceId, workspaceId);
        return row ? rowToEvidence(row) : null;
      },

      listEvidenceForPerson(personId) {
        const person = api.getPerson(personId);
        const ids = [personId, ...(person?.supersedes ?? [])];
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM identity_evidence WHERE workspace_id = ? AND person_id IN (${placeholders}) ORDER BY created_at`).all(workspaceId, ...ids);
        return rows.map(rowToEvidence);
      },

      linkVoiceProfile(personId, voiceProfileId) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        db.prepare('INSERT OR IGNORE INTO voice_profile_refs (voice_profile_id, workspace_id, person_id, provider, provider_model, quality, consent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(voiceProfileId, workspaceId, personId, 'unspecified', null, null, null, now());
        return { ok: true, person: api.getPerson(personId) };
      },

      /** Full metadata variant used by the enrollment route (identity/coordinator.js's enrollVoice result). */
      recordVoiceProfile({ personId, voiceProfileId, provider, providerModel, quality, consentId }) {
        db.prepare('INSERT OR REPLACE INTO voice_profile_refs (voice_profile_id, workspace_id, person_id, provider, provider_model, quality, consent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(voiceProfileId, workspaceId, personId, provider ?? 'unspecified', providerModel ?? null, quality ?? null, consentId ?? null, now());
      },

      unlinkVoiceProfile(personId, voiceProfileId) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        db.prepare('DELETE FROM voice_profile_refs WHERE voice_profile_id = ? AND person_id = ? AND workspace_id = ?').run(voiceProfileId, personId, workspaceId);
        return { ok: true, person: api.getPerson(personId) };
      },

      /**
       * Called after the face service has already stored a template
       * (server/routes/faceApi.mjs). The person's faceProfileIds are derived
       * from face_templates, so there is no second list to update — what this
       * adds is the evidence trail, so "why do you think that is Matt" can be
       * answered for a face the same way it can for a voice.
       */
      attachFaceProfile(personId, faceProfileId, { provider = null, providerModel = null, quality = null, sampleCount = null } = {}) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        api.addEvidence({
          evidenceType: 'face_enrollment', personId, faceProfileId, provider, providerModel, quality,
          decision: 'enrolled', reasonCode: sampleCount > 1 ? `explicit_enrollment_${sampleCount}_samples` : 'explicit_enrollment', sensitivity: 'biometric',
        });
        return { ok: true, person: api.getPerson(personId) };
      },

      /** Consent revocation freezes future use WITHOUT erasing the reference (see server/repositories/consentRepository.mjs). */
      revokeVoiceProfile(voiceProfileId) {
        db.prepare('UPDATE voice_profile_refs SET revoked_at = ? WHERE voice_profile_id = ? AND workspace_id = ?').run(now(), voiceProfileId, workspaceId);
      },

      getVoiceProfileRef(voiceProfileId) {
        const row = db.prepare('SELECT * FROM voice_profile_refs WHERE voice_profile_id = ? AND workspace_id = ?').get(voiceProfileId, workspaceId);
        if (!row) return null;
        return { voiceProfileId: row.voice_profile_id, personId: row.person_id, provider: row.provider, providerModel: row.provider_model, quality: row.quality, consentId: row.consent_id, createdAt: row.created_at, revokedAt: row.revoked_at, sensitivity: row.sensitivity };
      },

      linkMemory(personId, memoryId) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        db.prepare('INSERT OR IGNORE INTO memory_entity_links (link_id, workspace_id, memory_id, person_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`link_${now()}_${memoryId}_${personId}`, workspaceId, memoryId, personId, 'mentioned', now());
        return { ok: true, person: api.getPerson(personId) };
      },

      unlinkMemory(personId, memoryId) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        db.prepare('DELETE FROM memory_entity_links WHERE memory_id = ? AND person_id = ? AND workspace_id = ?').run(memoryId, personId, workspaceId);
        return { ok: true, person: api.getPerson(personId) };
      },

      mergePeople(sourcePersonIds, targetPersonId, { reasonCode = 'user_merge' } = {}) {
        const target = readPersonRow(targetPersonId);
        if (!target) return { ok: false, errors: [`no target person ${targetPersonId}`] };
        const sources = sourcePersonIds.filter((id) => id !== targetPersonId).map((id) => readPersonRow(id)).filter(Boolean);
        if (!sources.length) return { ok: false, errors: ['no valid source people to merge'] };
        const at = now();

        db.exec('BEGIN');
        try {
          const targetAliasNorms = new Set(readAliases(targetPersonId).map((a) => a.normalizedAlias));
          for (const source of sources) {
            // Aliases: move non-duplicate ones, drop duplicates.
            for (const alias of readAliases(source.person_id)) {
              if (targetAliasNorms.has(alias.normalizedAlias)) db.prepare('DELETE FROM person_aliases WHERE person_id = ? AND normalized_alias = ?').run(source.person_id, alias.normalizedAlias);
              else { db.prepare('UPDATE person_aliases SET person_id = ? WHERE person_id = ? AND normalized_alias = ?').run(targetPersonId, source.person_id, alias.normalizedAlias); targetAliasNorms.add(alias.normalizedAlias); }
            }
            // Voice profile refs: move.
            db.prepare('UPDATE voice_profile_refs SET person_id = ? WHERE person_id = ?').run(targetPersonId, source.person_id);
            try { db.prepare('UPDATE face_templates SET person_id = ? WHERE person_id = ? AND workspace_id = ?').run(targetPersonId, source.person_id, workspaceId); } catch { /* face_identity migration absent */ }
            // Memory entity links: move, skipping ones that would duplicate an existing (memory_id, target, role) row.
            const links = db.prepare('SELECT * FROM memory_entity_links WHERE person_id = ?').all(source.person_id);
            for (const link of links) {
              const dupe = db.prepare('SELECT 1 FROM memory_entity_links WHERE memory_id = ? AND person_id = ? AND role = ?').get(link.memory_id, targetPersonId, link.role);
              if (dupe) db.prepare('DELETE FROM memory_entity_links WHERE link_id = ?').run(link.link_id);
              else db.prepare('UPDATE memory_entity_links SET person_id = ? WHERE link_id = ?').run(targetPersonId, link.link_id);
            }
            // Relationships: repoint, skipping duplicate active edges (same type + counterparty).
            const relRows = db.prepare('SELECT * FROM relationships WHERE workspace_id = ? AND (from_entity_id = ? OR to_entity_id = ?)').all(workspaceId, source.person_id, source.person_id);
            for (const r of relRows) {
              const repointedFrom = r.from_entity_id === source.person_id ? targetPersonId : r.from_entity_id;
              const repointedTo = r.to_entity_id === source.person_id ? targetPersonId : r.to_entity_id;
              if (repointedFrom === repointedTo) continue;
              if (r.status === 'active') {
                const other = repointedFrom === targetPersonId ? repointedTo : repointedFrom;
                const dupe = db.prepare("SELECT 1 FROM relationships WHERE workspace_id = ? AND status = 'active' AND type = ? AND relationship_id != ? AND ((from_entity_id = ? AND to_entity_id = ?) OR (from_entity_id = ? AND to_entity_id = ?))")
                  .get(workspaceId, r.type, r.relationship_id, targetPersonId, other, other, targetPersonId);
                if (dupe) continue; // leave source's edge as historical, do not duplicate
              }
              db.prepare('UPDATE relationships SET from_entity_id = ?, to_entity_id = ?, updated_at = ? WHERE relationship_id = ?').run(repointedFrom, repointedTo, at, r.relationship_id);
            }
            // Mark source merged — never deleted; evidence stays under its original person_id (merge-chain traversal in listEvidenceForPerson).
            db.prepare("UPDATE people SET status = 'merged', identity_status = 'merged', merged_into = ?, updated_at = ? WHERE person_id = ?").run(targetPersonId, at, source.person_id);
          }
          const targetSupersedes = new Set(fromJson(target.supersedes, []));
          for (const s of sources) { targetSupersedes.add(s.person_id); for (const id of fromJson(s.supersedes, [])) targetSupersedes.add(id); }
          const targetConfidence = Math.max(target.confidence, ...sources.map((s) => s.confidence));
          db.prepare('UPDATE people SET supersedes = ?, confidence = ?, updated_at = ? WHERE person_id = ?').run(toJson([...targetSupersedes]), targetConfidence, at, targetPersonId);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return { ok: true, target: api.getPerson(targetPersonId), mergedIds: sources.map((s) => s.person_id), conflicts: [] };
      },

      splitPerson(personId, splitPlan = {}) {
        const source = readPersonRow(personId);
        if (!source) return { ok: false, errors: [`no person with id ${personId}`] };
        let targetId = splitPlan.targetPersonId;
        if (targetId && !readPersonRow(targetId)) return { ok: false, errors: [`no target person ${targetId}`] };
        if (!targetId) {
          const created = api.createPerson({ displayName: splitPlan.newDisplayName ?? rowToPerson(source).displayName, identityStatus: 'candidate', sensitivity: source.sensitivity, provisionalReason: `split from ${personId}` });
          if (!created.ok) return created;
          targetId = created.person.personId;
        }
        const at = now();
        db.exec('BEGIN');
        try {
          const aliasTexts = new Set((splitPlan.aliasTexts ?? []).map((a) => String(a).trim().toLowerCase()));
          for (const norm of aliasTexts) db.prepare('UPDATE person_aliases SET person_id = ? WHERE person_id = ? AND normalized_alias = ?').run(targetId, personId, norm);

          const voiceMoveIds = new Set(splitPlan.voiceProfileIds ?? []);
          for (const id of voiceMoveIds) db.prepare('UPDATE voice_profile_refs SET person_id = ? WHERE voice_profile_id = ? AND person_id = ?').run(targetId, id, personId);

          const faceMoveIds = new Set(splitPlan.faceProfileIds ?? []);
          for (const id of faceMoveIds) {
            try { db.prepare('UPDATE face_templates SET person_id = ? WHERE face_profile_id = ? AND person_id = ? AND workspace_id = ?').run(targetId, id, personId, workspaceId); } catch { /* face_identity migration absent */ }
          }

          const evidenceMoveIds = new Set(splitPlan.evidenceIds ?? []);
          for (const id of evidenceMoveIds) db.prepare('UPDATE identity_evidence SET person_id = ? WHERE evidence_id = ? AND person_id = ?').run(targetId, id, personId);

          const relationshipMoveIds = new Set(splitPlan.relationshipIds ?? []);
          for (const id of relationshipMoveIds) {
            const r = db.prepare('SELECT * FROM relationships WHERE relationship_id = ?').get(id);
            if (!r) continue;
            const from = r.from_entity_id === personId ? targetId : r.from_entity_id;
            const to = r.to_entity_id === personId ? targetId : r.to_entity_id;
            db.prepare('UPDATE relationships SET from_entity_id = ?, to_entity_id = ?, updated_at = ? WHERE relationship_id = ?').run(from, to, at, id);
          }

          const memoryMoveIds = new Set(splitPlan.memoryIds ?? []);
          for (const memoryId of memoryMoveIds) {
            const links = db.prepare('SELECT * FROM memory_entity_links WHERE memory_id = ? AND person_id = ?').all(memoryId, personId);
            for (const link of links) db.prepare('UPDATE memory_entity_links SET person_id = ? WHERE link_id = ?').run(targetId, link.link_id);
          }

          db.prepare('UPDATE people SET confidence = ?, updated_at = ? WHERE person_id = ?').run(Math.max(0, source.confidence * 0.9), at, personId);
          db.prepare('UPDATE people SET confidence = ?, updated_at = ? WHERE person_id = ?').run(Math.max(0, readPersonRow(targetId).confidence * 0.9), at, targetId);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return { ok: true, source: api.getPerson(personId), target: api.getPerson(targetId) };
      },

      deletePerson(personId) {
        const person = readPersonRow(personId);
        if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
        const at = now();
        db.prepare("UPDATE people SET status = 'deleted', identity_status = 'deleted', updated_at = ? WHERE person_id = ?").run(at, personId);
        // Forgetting a person must also stop the camera recognising them —
        // otherwise a deleted record keeps producing face evidence about
        // somebody the user asked Roma to forget.
        try { db.prepare("UPDATE face_templates SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE person_id = ? AND workspace_id = ?").run(at, at, personId, workspaceId); } catch { /* face_identity migration absent */ }
        return { ok: true, person: api.getPerson(personId) };
      },

      exportPerson(personId) {
        const person = api.getPerson(personId);
        if (!person) return null;
        return { person, evidence: api.listEvidenceForPerson(personId), relationships: api.listRelationships({ entityId: personId, includeInactive: true }) };
      },

      exportAll() {
        return {
          people: api.listPeople({ includeInactive: true }),
          evidence: db.prepare('SELECT * FROM identity_evidence WHERE workspace_id = ?').all(workspaceId).map(rowToEvidence),
          relationships: api.listRelationships({ includeInactive: true }),
        };
      },

      // ── relationships ──────────────────────────────────────────────────────

      createRelationship(raw) {
        const relationshipId = raw.relationshipId ?? generateRelationshipId(now());
        const validation = validateRelationship({ ...raw, relationshipId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
        if (!validation.ok) return { ok: false, relationship: null, errors: validation.errors };
        const r = validation.relationship;
        db.prepare('INSERT INTO relationships (relationship_id, workspace_id, user_id, schema_version, from_entity_id, to_entity_id, type, label, direction, status, confidence, sensitivity, valid_from, valid_until, created_at, updated_at, source_evidence_ids, linked_memory_ids, supersedes, contradicts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(r.relationshipId, workspaceId, userId, r.schemaVersion, r.fromEntityId, r.toEntityId, r.type, r.label, r.direction, r.status, r.confidence, r.sensitivity, r.validFrom, r.validUntil, r.createdAt, r.updatedAt, toJson(r.sourceEvidenceIds), toJson(r.linkedMemoryIds), toJson(r.supersedes), toJson(r.contradicts));
        return { ok: true, relationship: r, errors: [] };
      },

      getRelationship(relationshipId) {
        const row = db.prepare('SELECT * FROM relationships WHERE relationship_id = ? AND workspace_id = ?').get(relationshipId, workspaceId);
        return row ? rowToRelationship(row) : null;
      },

      updateRelationship(relationshipId, patch) {
        const row = db.prepare('SELECT * FROM relationships WHERE relationship_id = ? AND workspace_id = ?').get(relationshipId, workspaceId);
        if (!row) return { ok: false, relationship: null, errors: [`no relationship with id ${relationshipId}`] };
        const merged = { ...rowToRelationship(row), ...patch, relationshipId, updatedAt: now() };
        const validation = validateRelationship(merged);
        if (!validation.ok) return { ok: false, relationship: null, errors: validation.errors };
        const r = validation.relationship;
        db.prepare('UPDATE relationships SET from_entity_id=?, to_entity_id=?, type=?, label=?, direction=?, status=?, confidence=?, sensitivity=?, valid_from=?, valid_until=?, updated_at=?, source_evidence_ids=?, linked_memory_ids=?, supersedes=?, contradicts=? WHERE relationship_id = ? AND workspace_id = ?')
          .run(r.fromEntityId, r.toEntityId, r.type, r.label, r.direction, r.status, r.confidence, r.sensitivity, r.validFrom, r.validUntil, r.updatedAt, toJson(r.sourceEvidenceIds), toJson(r.linkedMemoryIds), toJson(r.supersedes), toJson(r.contradicts), relationshipId, workspaceId);
        return { ok: true, relationship: r, errors: [] };
      },

      supersedeRelationship(oldId, newId) {
        const oldRow = db.prepare('SELECT * FROM relationships WHERE relationship_id = ? AND workspace_id = ?').get(oldId, workspaceId);
        const newRow = db.prepare('SELECT * FROM relationships WHERE relationship_id = ? AND workspace_id = ?').get(newId, workspaceId);
        if (!oldRow || !newRow) return { ok: false, errors: ['both oldId and newId must exist'] };
        const at = now();
        db.prepare("UPDATE relationships SET status = 'superseded', updated_at = ? WHERE relationship_id = ? AND workspace_id = ?").run(at, oldId, workspaceId);
        const supersedes = fromJson(newRow.supersedes, []);
        if (!supersedes.includes(oldId)) db.prepare('UPDATE relationships SET supersedes = ?, updated_at = ? WHERE relationship_id = ? AND workspace_id = ?').run(toJson([...supersedes, oldId]), at, newId, workspaceId);
        return { ok: true, old: api.getRelationship(oldId), current: api.getRelationship(newId) };
      },

      listRelationships(filters = {}) {
        const clauses = ['workspace_id = ?'];
        const params = [workspaceId];
        if (!filters.includeInactive) { clauses.push("status = 'active'"); }
        if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
        if (filters.entityId) { clauses.push('(from_entity_id = ? OR to_entity_id = ?)'); params.push(filters.entityId, filters.entityId); }
        if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
        const rows = db.prepare(`SELECT * FROM relationships WHERE ${clauses.join(' AND ')}`).all(...params);
        return rows.map(rowToRelationship);
      },

      deleteRelationship(relationshipId) {
        const result = db.prepare('DELETE FROM relationships WHERE relationship_id = ? AND workspace_id = ?').run(relationshipId, workspaceId);
        return result.changes > 0;
      },

      clearAll() {
        db.prepare('DELETE FROM people WHERE workspace_id = ?').run(workspaceId);
        db.prepare('DELETE FROM person_aliases WHERE workspace_id = ?').run(workspaceId);
        db.prepare('DELETE FROM identity_evidence WHERE workspace_id = ?').run(workspaceId);
        db.prepare('DELETE FROM relationships WHERE workspace_id = ?').run(workspaceId);
        db.prepare('DELETE FROM voice_profile_refs WHERE workspace_id = ?').run(workspaceId);
      },
    };

    function rowToEvidence(row) {
      return { evidenceId: row.evidence_id, schemaVersion: row.schema_version, evidenceType: row.evidence_type, personId: row.person_id, speakerLabel: row.speaker_label, sessionId: row.session_id, interactionId: row.interaction_id, turnId: row.turn_id, transcriptIds: fromJson(row.transcript_ids, []), voiceSampleRef: row.voice_sample_ref, faceProfileId: row.face_profile_id ?? null, provider: row.provider, providerModel: row.provider_model, score: row.score, confidence: row.confidence, quality: row.quality, decision: row.decision, reasonCode: row.reason_code, confirmedBy: row.confirmed_by, createdAt: row.created_at, expiresAt: row.expires_at, sensitivity: row.sensitivity };
    }
    function rowToRelationship(row) {
      return { relationshipId: row.relationship_id, schemaVersion: row.schema_version, fromEntityId: row.from_entity_id, toEntityId: row.to_entity_id, type: row.type, label: row.label, direction: row.direction, status: row.status, confidence: row.confidence, sensitivity: row.sensitivity, validFrom: row.valid_from, validUntil: row.valid_until, createdAt: row.created_at, updatedAt: row.updated_at, sourceEvidenceIds: fromJson(row.source_evidence_ids, []), linkedMemoryIds: fromJson(row.linked_memory_ids, []), supersedes: fromJson(row.supersedes, []), contradicts: fromJson(row.contradicts, []) };
    }

    return api;
  }

  return { forWorkspace };
}
