// Append-only audit repository. No method here ever UPDATEs or DELETEs a row
// in audit_events — the only mutation is INSERT. Records IDs, actions,
// outcomes, and reason codes; deliberately never raw transcript text, memory
// content, audio, secrets, or biometric material (see `record()`'s doc
// comment — callers pass structural fields only, never full record bodies).

function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { if (text == null) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

let counter = 0;
function generateAuditId(now) {
  counter += 1;
  return `audit_${now}_${counter}`;
}

function rowToEvent(row) {
  return {
    auditId: row.audit_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    operationId: row.operation_id,
    at: row.at,
    policyDecisionId: row.policy_decision_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    sourceIds: fromJson(row.source_ids, []),
    sensitivity: row.sensitivity,
    redacted: Boolean(row.redacted),
    providerOperationRef: row.provider_operation_ref,
  };
}

export function createSqliteAuditRepository({ db, now = Date.now }) {
  function forWorkspace(workspaceId) {
    return {
      /**
       * Record one append-only audit event. `sourceIds` must be an array of
       * IDs only — never raw content. Callers that have sensitive content
       * MUST pass `redacted: true` and omit the content; this repository
       * does not itself inspect or strip content (see server/policy for
       * where redaction actually happens, upstream of this call).
       */
      record({ principalId, action, resourceType, resourceId = null, operationId = null, policyDecisionId = null, outcome, reasonCode = null, sourceIds = [], sensitivity = null, redacted = false, providerOperationRef = null }) {
        const auditId = generateAuditId(now());
        const at = now();
        db.prepare('INSERT INTO audit_events (audit_id, workspace_id, principal_id, action, resource_type, resource_id, operation_id, at, policy_decision_id, outcome, reason_code, source_ids, sensitivity, redacted, provider_operation_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(auditId, workspaceId, principalId, action, resourceType, resourceId, operationId, at, policyDecisionId, outcome, reasonCode, toJson(sourceIds.slice(0, 50)), sensitivity, redacted ? 1 : 0, providerOperationRef);
        return rowToEvent(db.prepare('SELECT * FROM audit_events WHERE audit_id = ?').get(auditId));
      },

      list({ limit = 100, action = null, resourceType = null, since = null } = {}) {
        const clauses = ['workspace_id = ?'];
        const params = [workspaceId];
        if (action) { clauses.push('action = ?'); params.push(action); }
        if (resourceType) { clauses.push('resource_type = ?'); params.push(resourceType); }
        if (since) { clauses.push('at >= ?'); params.push(since); }
        const rows = db.prepare(`SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...params, limit);
        return rows.map(rowToEvent);
      },

      countByOutcome() {
        const rows = db.prepare('SELECT outcome, COUNT(*) as n FROM audit_events WHERE workspace_id = ? GROUP BY outcome').all(workspaceId);
        const out = {};
        for (const r of rows) out[r.outcome] = r.n;
        return out;
      },
    };
  }
  return { forWorkspace };
}
