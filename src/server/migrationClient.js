// Explicit, user-controlled localStorage -> server migration (browser side).
// Never runs automatically — only from the Server Data panel's "Migrate
// local data" control (src/main.jsx). See SERVER-DATA.md "LocalStorage
// migration" for the full flow.

import { memoryConfig } from '../memory/config.js';
import { identityConfig } from '../identity/config.js';

function readJsonArray(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
}

/** Detect legacy browser records without touching the server. Read-only. */
export function detectLegacyRecords() {
  return {
    memories: readJsonArray(memoryConfig.storageKey),
    people: readJsonArray(identityConfig.storageKey),
    evidence: readJsonArray(`${identityConfig.storageKey}.evidence`),
    relationships: readJsonArray(`${identityConfig.storageKey}.relationships`),
  };
}

export function legacyRecordCounts() {
  const records = detectLegacyRecords();
  return { memories: records.memories.length, people: records.people.length, evidence: records.evidence.length, relationships: records.relationships.length };
}

function generateOperationId() {
  return `migration_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function dryRunMigration(dataClient) {
  const records = detectLegacyRecords();
  const { plan } = await dataClient.post('/api/migration/dry-run', { records });
  return { records, plan };
}

/** Import validated records. Idempotent via operationId — safe to call again with a NEW id; already-imported IDs are skipped either way. Never deletes local records itself — see clearLegacyRecordsAfterVerification(). */
export async function importMigration(dataClient, records) {
  const operationId = generateOperationId();
  const result = await dataClient.post('/api/migration/import', { records, operationId });
  return result;
}

/** Only call after the caller has verified `result.verify` counts match what was expected — per "never delete local records automatically on failed or partial migration." */
export function clearLegacyRecordsAfterVerification() {
  localStorage.removeItem(memoryConfig.storageKey);
  localStorage.removeItem(`${memoryConfig.storageKey}.embeddings`);
  localStorage.removeItem(identityConfig.storageKey);
  localStorage.removeItem(`${identityConfig.storageKey}.evidence`);
  localStorage.removeItem(`${identityConfig.storageKey}.relationships`);
}
