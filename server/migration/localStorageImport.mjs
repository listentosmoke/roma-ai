// Explicit, user-controlled localStorage -> server migration. Never runs
// automatically — the browser only ever calls `/api/migration/dry-run` or
// `/api/migration/import` when the user clicks the migration control in the
// Server Data panel (see src/useServerData.js). See SERVER-DATA.md
// "LocalStorage migration" for the full flow and rationale.

import { validateMemory } from '../../src/memory/schema.js';
import { validatePerson, validateRelationship, validateEvidence } from '../../src/identity/schema.js';
import { createOperationLedger } from '../repositories/operationLedger.mjs';

function classifyMemory(raw, existingIds) {
  if (typeof raw?.memoryId !== 'string' || !raw.memoryId) return { status: 'malformed', reason: 'missing memoryId' };
  const validation = validateMemory(raw);
  if (!validation.ok) return { status: 'malformed', reason: validation.errors.join('; ') };
  if (existingIds.has(raw.memoryId)) return { status: 'duplicate', reason: 'already present on the server' };
  return { status: 'valid' };
}
function classifyPerson(raw, existingIds) {
  if (typeof raw?.personId !== 'string' || !raw.personId) return { status: 'malformed', reason: 'missing personId' };
  const validation = validatePerson(raw);
  if (!validation.ok) return { status: 'malformed', reason: validation.errors.join('; ') };
  if (existingIds.has(raw.personId)) return { status: 'duplicate', reason: 'already present on the server' };
  return { status: 'valid' };
}
function classifyRelationship(raw, existingIds) {
  if (typeof raw?.relationshipId !== 'string' || !raw.relationshipId) return { status: 'malformed', reason: 'missing relationshipId' };
  const validation = validateRelationship(raw);
  if (!validation.ok) return { status: 'malformed', reason: validation.errors.join('; ') };
  if (existingIds.has(raw.relationshipId)) return { status: 'duplicate', reason: 'already present on the server' };
  return { status: 'valid' };
}
function classifyEvidence(raw, existingIds) {
  if (typeof raw?.evidenceId !== 'string' || !raw.evidenceId) return { status: 'malformed', reason: 'missing evidenceId' };
  const validation = validateEvidence(raw);
  if (!validation.ok) return { status: 'malformed', reason: validation.errors.join('; ') };
  if (existingIds.has(raw.evidenceId)) return { status: 'duplicate', reason: 'already present on the server' };
  return { status: 'valid' };
}

const MAX_PREVIEW = 20;

/** Read-only dry run: counts by status + a bounded preview (IDs and short reasons only — never full sensitive payloads). */
export function planMigration({ records, repositories }) {
  const existingMemoryIds = new Set(repositories.memory.exportAll().map((m) => m.memoryId));
  const identityExport = repositories.identity.exportAll();
  const existingPersonIds = new Set(identityExport.people.map((p) => p.personId));
  const existingRelationshipIds = new Set(identityExport.relationships.map((r) => r.relationshipId));
  const existingEvidenceIds = new Set(identityExport.evidence.map((e) => e.evidenceId));

  function summarize(items, classify, existingIds, idField) {
    const counts = { valid: 0, duplicate: 0, malformed: 0 };
    const preview = [];
    for (const raw of items ?? []) {
      const { status, reason } = classify(raw, existingIds);
      counts[status] += 1;
      if (preview.length < MAX_PREVIEW) preview.push({ id: raw?.[idField] ?? null, status, reason: reason ?? null });
    }
    return { total: (items ?? []).length, counts, preview };
  }

  return {
    memories: summarize(records.memories, classifyMemory, existingMemoryIds, 'memoryId'),
    people: summarize(records.people, classifyPerson, existingPersonIds, 'personId'),
    relationships: summarize(records.relationships, classifyRelationship, existingRelationshipIds, 'relationshipId'),
    evidence: summarize(records.evidence, classifyEvidence, existingEvidenceIds, 'evidenceId'),
    generatedAt: Date.now(),
  };
}

/** Idempotent import: an identical operationId replays the cached report; a record whose ID already exists server-side is skipped (never duplicated) even across two DIFFERENT operationIds — running the import twice is always safe. */
export function applyMigration({ db, workspaceId, records, repositories, operationId, now = Date.now }) {
  const ledger = createOperationLedger({ db, now });
  const cached = ledger.check(workspaceId, operationId);
  if (cached.done) return { ...cached.result, alreadyApplied: true };

  const report = { memoriesImported: 0, memoriesSkipped: 0, peopleImported: 0, peopleSkipped: 0, relationshipsImported: 0, relationshipsSkipped: 0, evidenceImported: 0, evidenceSkipped: 0, errors: [] };

  // People first (so memory speakerEntityId/subjectEntityIds FK-link correctly), then evidence/relationships, then memories.
  // Every record is ID-checked (typeof === 'string') before touching the
  // repository — a malformed record with no ID must be skipped/reported,
  // never crash the whole import.
  for (const raw of records.people ?? []) {
    if (typeof raw?.personId !== 'string' || !raw.personId) { report.peopleSkipped += 1; report.errors.push({ id: null, errors: ['missing personId'] }); continue; }
    if (repositories.identity.getPerson(raw.personId)) { report.peopleSkipped += 1; continue; }
    const result = repositories.identity.createPerson(raw);
    if (result.ok) report.peopleImported += 1; else { report.peopleSkipped += 1; report.errors.push({ id: raw.personId, errors: result.errors }); }
  }
  const existingEvidenceIds = new Set(repositories.identity.exportAll().evidence.map((e) => e.evidenceId));
  for (const raw of records.evidence ?? []) {
    if (typeof raw?.evidenceId !== 'string' || !raw.evidenceId) { report.evidenceSkipped += 1; report.errors.push({ id: null, errors: ['missing evidenceId'] }); continue; }
    if (existingEvidenceIds.has(raw.evidenceId)) { report.evidenceSkipped += 1; continue; }
    const result = repositories.identity.addEvidence(raw);
    if (result.ok) report.evidenceImported += 1; else { report.evidenceSkipped += 1; report.errors.push({ id: raw.evidenceId, errors: result.errors }); }
  }
  for (const raw of records.relationships ?? []) {
    if (typeof raw?.relationshipId !== 'string' || !raw.relationshipId) { report.relationshipsSkipped += 1; report.errors.push({ id: null, errors: ['missing relationshipId'] }); continue; }
    if (repositories.identity.getRelationship(raw.relationshipId)) { report.relationshipsSkipped += 1; continue; }
    const result = repositories.identity.createRelationship(raw);
    if (result.ok) report.relationshipsImported += 1; else { report.relationshipsSkipped += 1; report.errors.push({ id: raw.relationshipId, errors: result.errors }); }
  }
  for (const raw of records.memories ?? []) {
    if (typeof raw?.memoryId !== 'string' || !raw.memoryId) { report.memoriesSkipped += 1; report.errors.push({ id: null, errors: ['missing memoryId'] }); continue; }
    if (repositories.memory.get(raw.memoryId)) { report.memoriesSkipped += 1; continue; }
    const result = repositories.memory.create(raw);
    if (result.ok) report.memoriesImported += 1; else { report.memoriesSkipped += 1; report.errors.push({ id: raw.memoryId, errors: result.errors }); }
  }

  const verify = {
    memoriesPresent: (records.memories ?? []).filter((r) => typeof r?.memoryId === 'string' && repositories.memory.get(r.memoryId)).length,
    peoplePresent: (records.people ?? []).filter((r) => typeof r?.personId === 'string' && repositories.identity.getPerson(r.personId)).length,
  };

  const result = { report, verify, alreadyApplied: false };
  ledger.record(workspaceId, operationId, 'migration.import', result);
  return result;
}
