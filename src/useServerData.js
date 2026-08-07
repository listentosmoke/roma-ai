// React glue for the Server Data dev panel: migration controls, retention
// cleanup, audit log, and workspace-deletion danger zone. Deliberately thin
// — everything durable/consequential lives in server/routes/dataApi.mjs;
// this hook only calls it and holds the UI-facing results.

import { useCallback, useMemo, useState } from 'react';
import { createDataClient } from './server/dataClient.js';
import { dryRunMigration, importMigration, clearLegacyRecordsAfterVerification, legacyRecordCounts } from './server/migrationClient.js';

export function useServerData() {
  const dataClient = useMemo(() => createDataClient(), []);
  const [migrationPlan, setMigrationPlan] = useState(null);
  const [migrationResult, setMigrationResult] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);
  const [retentionResult, setRetentionResult] = useState(null);
  const [workspacePlan, setWorkspacePlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function guarded(fn) {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e.message ?? String(e)); return null; } finally { setBusy(false); }
  }

  const runDryRun = useCallback(() => guarded(async () => {
    const { records, plan } = await dryRunMigration(dataClient);
    setMigrationPlan({ records, plan });
    return plan;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient]);

  const runImport = useCallback(() => guarded(async () => {
    if (!migrationPlan) return null;
    const result = await importMigration(dataClient, migrationPlan.records);
    setMigrationResult(result);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient, migrationPlan]);

  const clearLocal = useCallback(() => {
    if (!migrationResult?.verify) return; // never clear without a verified import
    clearLegacyRecordsAfterVerification();
    setMigrationPlan(null);
    setMigrationResult(null);
  }, [migrationResult]);

  const loadAudit = useCallback(() => guarded(async () => {
    const res = await dataClient.get('/api/audit?limit=30');
    setAuditEvents(res.events ?? []);
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient]);

  const runRetentionCleanup = useCallback(() => guarded(async () => {
    const res = await dataClient.post('/api/retention/cleanup', {});
    setRetentionResult(res.result);
    return res.result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient]);

  const loadWorkspacePlan = useCallback(() => guarded(async () => {
    const res = await dataClient.post('/api/admin/workspace/delete-plan', {});
    setWorkspacePlan(res.plan);
    return res.plan;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient]);

  const confirmWorkspaceDelete = useCallback(() => guarded(async () => {
    const operationId = `admin_delete_${Date.now()}`;
    const res = await dataClient.post('/api/admin/workspace/delete', { confirm: true, operationId });
    setWorkspacePlan(null);
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dataClient]);

  return {
    legacyCounts: legacyRecordCounts(),
    migrationPlan, migrationResult, auditEvents, retentionResult, workspacePlan, busy, error,
    runDryRun, runImport, clearLocal, loadAudit, runRetentionCleanup, loadWorkspacePlan, confirmWorkspaceDelete,
  };
}
