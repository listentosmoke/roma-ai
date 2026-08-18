-- Sync-reliability hardening (stabilization phase).
--
-- operation_ids previously used operation_id ALONE as the primary key, so an
-- INSERT OR REPLACE from one workspace could overwrite another workspace's
-- ledger entry (a cross-tenant clobbering path — operation IDs must stay
-- tenant-scoped). Rebuild with a composite (operation_id, workspace_id) key.
-- All existing rows are preserved; the rebuild runs once, guarded by the
-- schema_migrations ledger.
CREATE TABLE IF NOT EXISTS operation_ids_v2 (
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, workspace_id)
);
INSERT OR IGNORE INTO operation_ids_v2 (operation_id, workspace_id, action, result, created_at)
  SELECT operation_id, workspace_id, action, result, created_at FROM operation_ids;
DROP TABLE operation_ids;
ALTER TABLE operation_ids_v2 RENAME TO operation_ids;
CREATE INDEX IF NOT EXISTS idx_operation_ids_workspace ON operation_ids(workspace_id, created_at);
