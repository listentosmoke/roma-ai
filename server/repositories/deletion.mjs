// Referentially safe, workspace-scoped destructive deletion. Every
// destructive multi-record operation here follows the same shape:
//   1. generate a bounded impact plan (read-only, no side effects)
//   2. require explicit confirmation + an idempotent operation ID
//   3. apply inside a transaction
//   4. record a minimal audit event
//   5. verify the records are no longer retrievable
//
// Per-resource deletion (one memory, one person, one relationship, ...) is
// already referentially safe by construction in memoryRepository.mjs /
// identityRepository.mjs (real foreign keys + explicit dangling-reference
// cleanup). This module adds the WORKSPACE-level (all-resources) case.

const WORKSPACE_TABLES = ['memories', 'memory_source_links', 'memory_entity_links', 'people', 'person_aliases', 'identity_evidence', 'relationships', 'voice_profile_refs', 'consent_records', 'sessions', 'interactions'];

export function planWorkspaceDeletion({ db, workspaceId }) {
  const counts = {};
  for (const table of WORKSPACE_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE workspace_id = ?`).get(workspaceId);
    counts[table] = row.n;
  }
  return { workspaceId, counts, generatedAt: Date.now() };
}

/**
 * @param {{ db, workspaceId, operationId, principalId, auditRepository, confirm: boolean, now?: Function }} args
 */
export function deleteWorkspace({ db, workspaceId, operationId, principalId, auditRepository, confirm, now = Date.now }) {
  if (!confirm) return { ok: false, errors: ['confirm must be true for a workspace deletion'] };
  if (!operationId) return { ok: false, errors: ['operationId is required for a workspace deletion'] };

  const plan = planWorkspaceDeletion({ db, workspaceId });
  db.exec('BEGIN');
  try {
    for (const table of WORKSPACE_TABLES) db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    const at = now();
    db.prepare('INSERT INTO tombstones (tombstone_id, workspace_id, resource_type, resource_id, deleted_at, deletion_kind, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`tomb_${at}_workspace`, workspaceId, 'workspace', workspaceId, at, 'hard', operationId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  auditRepository?.forWorkspace(workspaceId).record({
    principalId, action: 'admin.workspace_delete', resourceType: 'workspace', resourceId: workspaceId,
    operationId, outcome: 'deleted', reasonCode: 'confirmed_workspace_deletion', sourceIds: [], redacted: true,
  });

  // Verify: nothing retrievable after the transaction commits.
  const verify = planWorkspaceDeletion({ db, workspaceId });
  const clean = Object.values(verify.counts).every((n) => n === 0);
  return { ok: clean, plan, verified: clean };
}
