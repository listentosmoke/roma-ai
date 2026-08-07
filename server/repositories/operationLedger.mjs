// Idempotency ledger shared by every mutation route that accepts an
// operation ID (migration import, workspace deletion, etc.) — "Mutation
// operation IDs prevent duplicate writes." A retried request with the SAME
// operationId replays the cached result instead of re-executing the
// mutation.

function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { if (text == null) return fallback; try { return JSON.parse(text); } catch { return fallback; } }

export function createOperationLedger({ db, now = Date.now }) {
  return {
    /** @returns {{ done: true, result: any }|{ done: false }} */
    check(workspaceId, operationId) {
      if (!operationId) return { done: false };
      const row = db.prepare('SELECT result FROM operation_ids WHERE operation_id = ? AND workspace_id = ?').get(operationId, workspaceId);
      if (!row) return { done: false };
      return { done: true, result: fromJson(row.result, null) };
    },
    record(workspaceId, operationId, action, result) {
      if (!operationId) return;
      db.prepare('INSERT OR REPLACE INTO operation_ids (operation_id, workspace_id, action, result, created_at) VALUES (?, ?, ?, ?, ?)').run(operationId, workspaceId, action, toJson(result), now());
    },
  };
}
