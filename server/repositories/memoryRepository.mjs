// Server-owned, SQLite-backed Memory Repository. Implements the EXACT same
// interface as src/memory/repository.js's createRepositoryCore (create/get/
// update/supersede/findRelated/searchStructured/searchSemantic/markAccessed/
// delete/deleteBySource/exportAll/clearAll) plus one addition (`softDelete`,
// used only by retention cleanup — see server/repositories/retention.mjs) —
// so src/memory/writer.js, retriever.js, and coordinator.js never change.
// Reuses src/memory/schema.js's validateMemory for the exact same validation
// rules the client repository uses.
//
// Every method is tenant-scoped via forWorkspace(workspaceId, userId) — the
// returned object has NO workspaceId parameter on any call, so a route
// handler cannot accidentally pass a client-supplied one through.

import { validateMemory } from '../../src/memory/schema.js';
import { generateMemoryId } from '../../src/memory/repository.js';
import { cosineSimilarity, embeddingMatchesEmbedder } from '../../src/memory/embeddings.js';

function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { if (text == null) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

function rowToMemory(row) {
  return {
    memoryId: row.memory_id,
    schemaVersion: row.schema_version,
    type: row.type,
    subjectId: row.subject_id,
    predicate: row.predicate,
    object: fromJson(row.object, {}),
    summary: row.summary,
    status: row.status,
    importance: row.importance,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    source: {
      interactionId: row.source_interaction_id,
      turnIds: fromJson(row.source_turn_ids, []),
      transcriptIds: fromJson(row.source_transcript_ids, []),
      sceneEventIds: fromJson(row.source_scene_event_ids, []),
      speakerId: row.source_speaker_id,
      evidenceType: row.source_evidence_type,
      extractionMethod: row.source_extraction_method,
      model: row.source_model,
    },
    supersedes: fromJson(row.supersedes, []),
    supersededBy: row.superseded_by,
    contradicts: fromJson(row.contradicts, []),
    tags: fromJson(row.tags, []),
    subjectEntityIds: fromJson(row.subject_entity_ids, []),
    objectEntityIds: fromJson(row.object_entity_ids, []),
    mentionedEntityIds: fromJson(row.mentioned_entity_ids, []),
    speakerEntityId: row.speaker_entity_id,
  };
}

const INSERT_COLUMNS = [
  'memory_id', 'workspace_id', 'user_id', 'schema_version', 'type', 'subject_id', 'predicate', 'object', 'summary', 'status',
  'importance', 'confidence', 'sensitivity', 'valid_from', 'valid_until', 'created_at', 'updated_at', 'last_accessed_at',
  'source_interaction_id', 'source_turn_ids', 'source_transcript_ids', 'source_scene_event_ids', 'source_speaker_id',
  'source_evidence_type', 'source_extraction_method', 'source_model', 'supersedes', 'superseded_by', 'contradicts', 'tags',
  'subject_entity_ids', 'object_entity_ids', 'mentioned_entity_ids', 'speaker_entity_id',
];

function memoryToParams(memory, workspaceId, userId) {
  return [
    memory.memoryId, workspaceId, userId, memory.schemaVersion, memory.type, memory.subjectId, memory.predicate, toJson(memory.object), memory.summary, memory.status,
    memory.importance, memory.confidence, memory.sensitivity, memory.validFrom, memory.validUntil, memory.createdAt, memory.updatedAt, memory.lastAccessedAt,
    memory.source.interactionId, toJson(memory.source.turnIds), toJson(memory.source.transcriptIds), toJson(memory.source.sceneEventIds), memory.source.speakerId,
    memory.source.evidenceType, memory.source.extractionMethod, memory.source.model, toJson(memory.supersedes), memory.supersededBy, toJson(memory.contradicts), toJson(memory.tags),
    toJson(memory.subjectEntityIds), toJson(memory.objectEntityIds), toJson(memory.mentionedEntityIds), memory.speakerEntityId,
  ];
}

function matchesTags(memory, tags) {
  return !tags?.length || tags.some((t) => memory.tags.includes(t));
}

export function createSqliteMemoryRepository({ db, now = Date.now }) {
  function syncEntityLinks(memory, workspaceId) {
    db.prepare('DELETE FROM memory_entity_links WHERE memory_id = ?').run(memory.memoryId);
    const candidateIds = [memory.speakerEntityId, ...memory.subjectEntityIds, ...memory.objectEntityIds, ...memory.mentionedEntityIds].filter(Boolean);
    if (!candidateIds.length) return;
    // Only link entity IDs that actually resolve to an existing person in
    // this workspace — a stale/invalid ID (e.g. a person deleted after the
    // memory was written) is silently skipped here rather than crashing the
    // memory write; the FK constraint still protects every row that DOES
    // get inserted.
    const existing = new Set(
      db.prepare(`SELECT person_id FROM people WHERE workspace_id = ? AND person_id IN (${candidateIds.map(() => '?').join(',')})`)
        .all(workspaceId, ...candidateIds)
        .map((r) => r.person_id),
    );
    const insert = db.prepare('INSERT OR IGNORE INTO memory_entity_links (link_id, workspace_id, memory_id, person_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const at = now();
    let counter = 0;
    const add = (personId, role) => { if (personId && existing.has(personId)) insert.run(`link_${at}_${memory.memoryId}_${counter++}`, workspaceId, memory.memoryId, personId, role, at); };
    add(memory.speakerEntityId, 'speaker');
    for (const id of memory.subjectEntityIds) add(id, 'subject');
    for (const id of memory.objectEntityIds) add(id, 'object');
    for (const id of memory.mentionedEntityIds) add(id, 'mentioned');
  }

  function forWorkspace(workspaceId, userId) {
    function readRow(memoryId, { includeDeleted = false } = {}) {
      const row = db.prepare('SELECT * FROM memories WHERE memory_id = ? AND workspace_id = ?').get(memoryId, workspaceId);
      if (!row) return null;
      if (!includeDeleted && row.deleted_at != null) return null;
      return row;
    }

    const api = {
      create(raw) {
        const memoryId = raw.memoryId ?? generateMemoryId(now());
        const validation = validateMemory({ ...raw, memoryId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
        if (!validation.ok) return { ok: false, memory: null, errors: validation.errors };
        const placeholders = INSERT_COLUMNS.map(() => '?').join(', ');
        db.prepare(`INSERT INTO memories (${INSERT_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...memoryToParams(validation.memory, workspaceId, userId));
        syncEntityLinks(validation.memory, workspaceId);
        return { ok: true, memory: { ...validation.memory }, errors: [] };
      },

      get(memoryId) {
        const row = readRow(memoryId);
        return row ? rowToMemory(row) : null;
      },

      update(memoryId, patch) {
        const row = readRow(memoryId);
        if (!row) return { ok: false, memory: null, errors: [`no memory with id ${memoryId}`] };
        const merged = { ...rowToMemory(row), ...patch, memoryId, updatedAt: now() };
        const validation = validateMemory(merged);
        if (!validation.ok) return { ok: false, memory: null, errors: validation.errors };
        const setClause = INSERT_COLUMNS.filter((c) => !['memory_id', 'workspace_id', 'user_id'].includes(c)).map((c) => `${c} = ?`).join(', ');
        const params = memoryToParams(validation.memory, workspaceId, userId).slice(3); // drop id/workspace/user from the front
        db.prepare(`UPDATE memories SET ${setClause} WHERE memory_id = ? AND workspace_id = ?`).run(...params, memoryId, workspaceId);
        syncEntityLinks(validation.memory, workspaceId);
        return { ok: true, memory: { ...validation.memory }, errors: [] };
      },

      supersede(oldId, newId) {
        const oldRow = readRow(oldId);
        const newRow = readRow(newId);
        if (!oldRow || !newRow) return { ok: false, errors: ['both oldId and newId must exist'] };
        const at = now();
        db.prepare('UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE memory_id = ? AND workspace_id = ?').run('superseded', newId, at, oldId, workspaceId);
        const newSupersedes = fromJson(newRow.supersedes, []);
        if (!newSupersedes.includes(oldId)) {
          db.prepare('UPDATE memories SET supersedes = ?, updated_at = ? WHERE memory_id = ? AND workspace_id = ?').run(toJson([...newSupersedes, oldId]), at, newId, workspaceId);
        }
        return { ok: true, old: api.get(oldId), current: api.get(newId) };
      },

      findRelated({ type, subjectId, predicate, tags = [], includeInactive = false } = {}) {
        const clauses = ['workspace_id = ?', 'deleted_at IS NULL'];
        const params = [workspaceId];
        if (!includeInactive) { clauses.push('status = ?'); params.push('active'); }
        if (type) { clauses.push('type = ?'); params.push(type); }
        if (subjectId) { clauses.push('subject_id = ?'); params.push(subjectId); }
        if (predicate) { clauses.push('predicate = ?'); params.push(predicate); }
        const rows = db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')}`).all(...params);
        return rows.map(rowToMemory).filter((m) => matchesTags(m, tags));
      },

      searchStructured(filters = {}) {
        const clauses = ['workspace_id = ?', 'deleted_at IS NULL'];
        const params = [workspaceId];
        if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
        if (filters.subjectId) { clauses.push('subject_id = ?'); params.push(filters.subjectId); }
        if (filters.predicate) { clauses.push('predicate = ?'); params.push(filters.predicate); }
        if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
        else if (filters.includeInactive !== true) { clauses.push('status = ?'); params.push('active'); }
        if (filters.sensitivity) { clauses.push('sensitivity = ?'); params.push(filters.sensitivity); }
        const rows = db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')}`).all(...params);
        return rows.map(rowToMemory).filter((m) => matchesTags(m, filters.tags));
      },

      async searchSemantic({ text, embedder, limit = 20, candidates } = {}) {
        if (!embedder || !text) return [];
        const pool = candidates ?? api.searchStructured({ status: 'active' });
        const queryVector = await embedder.embed(text);
        const results = [];
        for (const memory of pool) {
          const vector = await embedder.embed(memory.summary);
          results.push({ memory, score: cosineSimilarity(queryVector, vector) });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
      },

      markAccessed(memoryIds = []) {
        if (!memoryIds.length) return;
        const at = now();
        const stmt = db.prepare('UPDATE memories SET last_accessed_at = ? WHERE memory_id = ? AND workspace_id = ?');
        for (const id of memoryIds) stmt.run(at, id, workspaceId);
      },

      /** Hard delete: row removed (FK cascade removes memory_entity_links). Records a 'hard' tombstone — see server/repositories/auditRepository.mjs. */
      delete(memoryId) {
        const row = readRow(memoryId, { includeDeleted: true });
        if (!row) return false;
        const at = now();
        db.exec('BEGIN');
        try {
          const dangling = db.prepare("SELECT memory_id, supersedes, superseded_by, contradicts FROM memories WHERE workspace_id = ? AND (superseded_by = ? OR supersedes LIKE ? OR contradicts LIKE ?)")
            .all(workspaceId, memoryId, `%${memoryId}%`, `%${memoryId}%`);
          for (const d of dangling) {
            const supersedes = fromJson(d.supersedes, []).filter((id) => id !== memoryId);
            const contradicts = fromJson(d.contradicts, []).filter((id) => id !== memoryId);
            const supersededBy = d.superseded_by === memoryId ? null : d.superseded_by;
            db.prepare('UPDATE memories SET supersedes = ?, contradicts = ?, superseded_by = ? WHERE memory_id = ? AND workspace_id = ?')
              .run(toJson(supersedes), toJson(contradicts), supersededBy, d.memory_id, workspaceId);
          }
          db.prepare('DELETE FROM memories WHERE memory_id = ? AND workspace_id = ?').run(memoryId, workspaceId);
          db.prepare('INSERT INTO tombstones (tombstone_id, workspace_id, resource_type, resource_id, deleted_at, deletion_kind) VALUES (?, ?, ?, ?, ?, ?)')
            .run(`tomb_${at}_${memoryId}`, workspaceId, 'memory', memoryId, at, 'hard');
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return true;
      },

      /** Soft delete — used only by retention cleanup (server/repositories/retention.mjs). Row stays (inspectable/recoverable) but `deleted_at` excludes it from every normal read above. Distinguishable from delete() (hard) via tombstones.deletion_kind. */
      softDelete(memoryId) {
        const row = readRow(memoryId);
        if (!row) return false;
        const at = now();
        db.prepare('UPDATE memories SET deleted_at = ? WHERE memory_id = ? AND workspace_id = ?').run(at, memoryId, workspaceId);
        db.prepare('INSERT INTO tombstones (tombstone_id, workspace_id, resource_type, resource_id, deleted_at, deletion_kind) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`tomb_${at}_${memoryId}`, workspaceId, 'memory', memoryId, at, 'soft');
        return true;
      },

      /** Delete every memory sourced from `interactionId`. FK cascade removes memory_entity_links for each — this is the structural fix for the known deleteBySource-doesn't-unlink-identity gap: server/repositories/identityRepository.mjs's getPerson() derives linkedMemoryIds LIVE from memory_entity_links, so a deleted memory is instantly gone from every person's linked list with no separate unlink step required. */
      deleteBySource(interactionId) {
        const rows = db.prepare('SELECT memory_id FROM memories WHERE workspace_id = ? AND source_interaction_id = ? AND deleted_at IS NULL').all(workspaceId, interactionId);
        let count = 0;
        for (const row of rows) if (api.delete(row.memory_id)) count += 1;
        return count;
      },

      exportAll() {
        return db.prepare('SELECT * FROM memories WHERE workspace_id = ? AND deleted_at IS NULL').all(workspaceId).map(rowToMemory);
      },

      /** Dev-only: wipe this workspace's memories. Never touches other workspaces. */
      clearAll() {
        db.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
      },
    };
    return api;
  }

  return { forWorkspace };
}

export { embeddingMatchesEmbedder };
