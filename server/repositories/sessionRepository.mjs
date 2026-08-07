// Server-owned real-time session state with optimistic concurrency. Bounded
// fields only (see SESSION_FIELDS) — no raw unrestricted conversation
// history is ever stored here (that stays in the runtime's bounded
// transcript window, unchanged — see AGENT.md).
//
// Every update must supply the version it read; a stale version is rejected
// rather than silently overwritten, so a late tool/memory/retrieval/identity
// result can never clobber newer state (see SERVER-DATA.md "Optimistic
// concurrency").

function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { if (text == null) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

let counter = 0;
function generateSessionId(now) { counter += 1; return `session_${now}_${counter}`; }

const JSON_FIELDS = ['currentResolvedSpeakers', 'engagementState', 'activeGoals', 'currentToolOperationIds', 'pendingRetrievalIds', 'pendingMemoryWriteIds', 'pendingIdentityResolutionIds'];
const SCALAR_FIELDS = ['activeInteractionId', 'activeTurnId', 'cancellationGeneration', 'lastAcceptedTranscriptSeq', 'currentSpeechAuthorizationId'];

function rowToSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    version: row.version,
    activeInteractionId: row.active_interaction_id,
    activeTurnId: row.active_turn_id,
    currentResolvedSpeakers: fromJson(row.current_resolved_speakers, {}),
    engagementState: fromJson(row.engagement_state, null),
    activeGoals: fromJson(row.active_goals, []),
    cancellationGeneration: row.cancellation_generation,
    lastAcceptedTranscriptSeq: row.last_accepted_transcript_seq,
    currentToolOperationIds: fromJson(row.current_tool_operation_ids, []),
    pendingRetrievalIds: fromJson(row.pending_retrieval_ids, []),
    pendingMemoryWriteIds: fromJson(row.pending_memory_write_ids, []),
    pendingIdentityResolutionIds: fromJson(row.pending_identity_resolution_ids, []),
    currentSpeechAuthorizationId: row.current_speech_authorization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity

export function createSqliteSessionRepository({ db, now = Date.now }) {
  function forWorkspace(workspaceId, userId) {
    function readRow(sessionId) {
      return db.prepare('SELECT * FROM sessions WHERE session_id = ? AND workspace_id = ?').get(sessionId, workspaceId);
    }

    return {
      start({ sessionId, ttlMs = DEFAULT_TTL_MS } = {}) {
        const id = sessionId ?? generateSessionId(now());
        const at = now();
        db.prepare(`INSERT INTO sessions (session_id, workspace_id, user_id, version, active_interaction_id, active_turn_id, current_resolved_speakers, engagement_state, active_goals, cancellation_generation, last_accepted_transcript_seq, current_tool_operation_ids, pending_retrieval_ids, pending_memory_write_ids, pending_identity_resolution_ids, current_speech_authorization_id, created_at, updated_at, expires_at, status)
          VALUES (?, ?, ?, 1, NULL, NULL, ?, NULL, ?, 0, 0, ?, ?, ?, ?, NULL, ?, ?, ?, 'active')`)
          .run(id, workspaceId, userId, toJson({}), toJson([]), toJson([]), toJson([]), toJson([]), toJson([]), at, at, at + ttlMs);
        return rowToSession(readRow(id));
      },

      get(sessionId) {
        const row = readRow(sessionId);
        if (!row) return null;
        if (row.status !== 'active' || row.expires_at < now()) return null; // expired sessions are excluded from normal reads
        return rowToSession(row);
      },

      /** @returns {{ok:true, session}|{ok:false, reasonCode:'stale_version'|'not_found'|'expired', current: object|null}} */
      update(sessionId, patch, expectedVersion) {
        const row = readRow(sessionId);
        if (!row) return { ok: false, reasonCode: 'not_found', current: null };
        if (row.status !== 'active' || row.expires_at < now()) return { ok: false, reasonCode: 'expired', current: rowToSession(row) };
        if (row.version !== expectedVersion) return { ok: false, reasonCode: 'stale_version', current: rowToSession(row) };

        const current = rowToSession(row);
        const merged = { ...current, ...patch };
        const at = now();
        const setClauses = [];
        const params = [];
        for (const field of SCALAR_FIELDS) {
          const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
          setClauses.push(`${column} = ?`);
          params.push(merged[field] ?? null);
        }
        for (const field of JSON_FIELDS) {
          const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
          setClauses.push(`${column} = ?`);
          params.push(toJson(merged[field]));
        }
        setClauses.push('version = ?', 'updated_at = ?');
        params.push(current.version + 1, at);
        if (patch.ttlMs) { setClauses.push('expires_at = ?'); params.push(at + patch.ttlMs); }
        params.push(sessionId, workspaceId);
        db.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE session_id = ? AND workspace_id = ?`).run(...params);
        return { ok: true, session: rowToSession(readRow(sessionId)) };
      },

      end(sessionId) {
        const result = db.prepare("UPDATE sessions SET status = 'deleted', updated_at = ? WHERE session_id = ? AND workspace_id = ?").run(now(), sessionId, workspaceId);
        return result.changes > 0;
      },

      listExpired(atTime = now()) {
        return db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status = 'active' AND expires_at < ?").all(workspaceId, atTime).map(rowToSession);
      },

      /** Retention cleanup: mark expired ACTIVE sessions as expired. Explicit, callable, deterministic — never a background timer (see server/repositories/retention.mjs). */
      expireStale(atTime = now()) {
        const stale = this.listExpired(atTime);
        for (const s of stale) db.prepare("UPDATE sessions SET status = 'expired', updated_at = ? WHERE session_id = ?").run(atTime, s.sessionId);
        return stale.length;
      },
    };
  }
  return { forWorkspace };
}
