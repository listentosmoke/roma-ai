// Provider-independent Person Repository. Same shared-core pattern as
// memory/repository.js: one core (createRepositoryCore) parameterized by
// load/save I/O, instantiated as:
//
//   - createInMemoryIdentityRepository()      — deterministic Map-backed
//                                                store, for tests/simulation.
//   - createLocalStorageIdentityRepository()  — the one local durable
//                                                provider this phase ships
//                                                for DEVELOPMENT ONLY.
//
// IMPORTANT — localStorage is development-only person METADATA storage. It
// never holds raw audio, voice embeddings, or biometric templates (those, if
// a real voice provider existed, would live server-side — see
// identity/voiceProvider.js and IDENTITY.md "Security and biometric privacy").
// A person record only ever stores an opaque `voiceProfileId` reference.
//
// This repository stores three related collections — persons, evidence, and
// relationships — because they share one lifecycle (a person merge/split/
// delete must keep all three consistent) and this app has no pre-existing
// server database to justify a second storage technology (see IDENTITY.md
// "Storage providers selected").

import { validatePerson, validateEvidence, validateRelationship } from './schema.js';

let personCounter = 0;
export function generatePersonId(now = Date.now()) {
  personCounter += 1;
  return `person_${now}_${personCounter}`;
}
let evidenceCounter = 0;
export function generateEvidenceId(now = Date.now()) {
  evidenceCounter += 1;
  return `evidence_${now}_${evidenceCounter}`;
}
let relationshipCounter = 0;
export function generateRelationshipId(now = Date.now()) {
  relationshipCounter += 1;
  return `relationship_${now}_${relationshipCounter}`;
}

function matchesPersonFilters(person, filters = {}) {
  if (!filters.includeInactive && person.status === 'deleted') return false;
  if (filters.status && person.status !== filters.status) return false;
  if (filters.identityStatus && person.identityStatus !== filters.identityStatus) return false;
  if (filters.sensitivity && person.sensitivity !== filters.sensitivity) return false;
  return true;
}

function matchesRelationshipFilters(relationship, filters = {}) {
  if (!filters.includeInactive && relationship.status !== 'active') return false;
  if (filters.status && relationship.status !== filters.status) return false;
  if (filters.entityId && relationship.fromEntityId !== filters.entityId && relationship.toEntityId !== filters.entityId) return false;
  if (filters.type && relationship.type !== filters.type) return false;
  return true;
}

/**
 * @param {{
 *   load: () => object[], save: (records: object[]) => void,
 *   loadEvidence: () => object[], saveEvidence: (records: object[]) => void,
 *   loadRelationships: () => object[], saveRelationships: (records: object[]) => void,
 *   now?: () => number,
 * }} io
 */
function createRepositoryCore({ load, save, loadEvidence, saveEvidence, loadRelationships, saveRelationships, now = Date.now }) {
  function readAll() { try { return load() ?? []; } catch { return []; } }
  function writeAll(records) { try { save(records); } catch { /* best-effort in dev storage */ } }
  function readEvidenceAll() { try { return loadEvidence() ?? []; } catch { return []; } }
  function writeEvidenceAll(records) { try { saveEvidence(records); } catch { /* best-effort */ } }
  function readRelationshipsAll() { try { return loadRelationships() ?? []; } catch { return []; } }
  function writeRelationshipsAll(records) { try { saveRelationships(records); } catch { /* best-effort */ } }

  function getPerson(personId) {
    return readAll().find((p) => p.personId === personId) ?? null;
  }

  function listEvidenceForPerson(personId) {
    // Traverse the merge chain (supersedes) so evidence recorded under an
    // absorbed record's original personId is still inspectable through the
    // canonical target — "merge history remains inspectable" / "preserve all
    // evidence".
    const person = getPerson(personId);
    const ids = new Set([personId, ...(person?.supersedes ?? [])]);
    return readEvidenceAll().filter((e) => ids.has(e.personId)).sort((a, b) => a.createdAt - b.createdAt);
  }

  function listRelationships(filters = {}) {
    return readRelationshipsAll().filter((r) => matchesRelationshipFilters(r, filters));
  }

  const api = {
    createPerson(raw) {
      const personId = raw.personId ?? generatePersonId(now());
      const validation = validatePerson({ ...raw, personId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
      if (!validation.ok) return { ok: false, person: null, errors: validation.errors };
      const records = readAll();
      records.push(validation.person);
      writeAll(records);
      return { ok: true, person: { ...validation.person }, errors: [] };
    },

    getPerson,

    updatePerson(personId, patch) {
      const records = readAll();
      const index = records.findIndex((p) => p.personId === personId);
      if (index === -1) return { ok: false, person: null, errors: [`no person with id ${personId}`] };
      const merged = { ...records[index], ...patch, personId, updatedAt: now() };
      const validation = validatePerson(merged);
      if (!validation.ok) return { ok: false, person: null, errors: validation.errors };
      records[index] = validation.person;
      writeAll(records);
      return { ok: true, person: { ...validation.person }, errors: [] };
    },

    /** Case-insensitive exact match on displayName OR any active alias. Bounded, deterministic. */
    findByName(name, { includeInactive = false } = {}) {
      const needle = String(name ?? '').trim().toLowerCase();
      if (!needle) return [];
      return readAll().filter((p) => {
        if (!includeInactive && p.status !== 'active') return false;
        if (p.displayName.toLowerCase() === needle) return true;
        return p.aliases.some((a) => a.normalizedAlias === needle);
      });
    },

    findByAlias(alias) {
      return api.findByName(alias);
    },

    /** Bounded substring/fuzzy candidate search across displayName + aliases, for disambiguation UIs and tools. */
    findCandidates({ query = '', includeInactive = false, limit = 10 } = {}) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return [];
      const results = readAll().filter((p) => {
        if (!includeInactive && p.status !== 'active') return false;
        if (p.displayName.toLowerCase().includes(needle)) return true;
        return p.aliases.some((a) => a.normalizedAlias.includes(needle));
      });
      return results.slice(0, limit);
    },

    listPeople(filters = {}) {
      return readAll().filter((p) => matchesPersonFilters(p, filters));
    },

    addEvidence(raw) {
      const evidenceId = raw.evidenceId ?? generateEvidenceId(now());
      const validation = validateEvidence({ ...raw, evidenceId, createdAt: raw.createdAt ?? now() });
      if (!validation.ok) return { ok: false, evidence: null, errors: validation.errors };
      const records = readEvidenceAll();
      records.push(validation.evidence);
      writeEvidenceAll(records);
      if (validation.evidence.personId) {
        const person = getPerson(validation.evidence.personId);
        if (person && !person.sourceEvidenceIds.includes(evidenceId)) {
          api.updatePerson(validation.evidence.personId, { sourceEvidenceIds: [...person.sourceEvidenceIds, evidenceId], lastObservedAt: validation.evidence.createdAt });
        }
      }
      return { ok: true, evidence: { ...validation.evidence }, errors: [] };
    },

    getEvidence(evidenceId) {
      return readEvidenceAll().find((e) => e.evidenceId === evidenceId) ?? null;
    },

    listEvidenceForPerson,

    linkVoiceProfile(personId, voiceProfileId) {
      const person = getPerson(personId);
      if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
      if (person.voiceProfileIds.includes(voiceProfileId)) return { ok: true, person };
      return api.updatePerson(personId, { voiceProfileIds: [...person.voiceProfileIds, voiceProfileId] });
    },

    unlinkVoiceProfile(personId, voiceProfileId) {
      const person = getPerson(personId);
      if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
      return api.updatePerson(personId, { voiceProfileIds: person.voiceProfileIds.filter((id) => id !== voiceProfileId) });
    },

    linkMemory(personId, memoryId) {
      const person = getPerson(personId);
      if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
      if (person.linkedMemoryIds.includes(memoryId)) return { ok: true, person };
      return api.updatePerson(personId, { linkedMemoryIds: [...person.linkedMemoryIds, memoryId] });
    },

    unlinkMemory(personId, memoryId) {
      const person = getPerson(personId);
      if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
      return api.updatePerson(personId, { linkedMemoryIds: person.linkedMemoryIds.filter((id) => id !== memoryId) });
    },

    /**
     * Merge `sourcePersonIds` into `targetPersonId`. Preserves aliases,
     * evidence (via listEvidenceForPerson's merge-chain traversal), voice
     * profiles, memory links, and relationships (repointed onto the target,
     * never duplicated). Source records are marked 'merged', never deleted.
     */
    mergePeople(sourcePersonIds, targetPersonId, { reasonCode = 'user_merge' } = {}) {
      const target = getPerson(targetPersonId);
      if (!target) return { ok: false, errors: [`no target person ${targetPersonId}`] };
      const sources = sourcePersonIds.filter((id) => id !== targetPersonId).map((id) => getPerson(id)).filter(Boolean);
      if (!sources.length) return { ok: false, errors: ['no valid source people to merge'] };

      const aliasMap = new Map(target.aliases.map((a) => [a.normalizedAlias, a]));
      for (const source of sources) {
        for (const alias of source.aliases) if (!aliasMap.has(alias.normalizedAlias)) aliasMap.set(alias.normalizedAlias, alias);
      }
      const mergedVoiceProfileIds = [...new Set([...target.voiceProfileIds, ...sources.flatMap((s) => s.voiceProfileIds)])];
      const mergedMemoryIds = [...new Set([...target.linkedMemoryIds, ...sources.flatMap((s) => s.linkedMemoryIds)])];
      const mergedSupersedes = [...new Set([...target.supersedes, ...sources.map((s) => s.personId), ...sources.flatMap((s) => s.supersedes)])];
      const mergedEvidenceIds = [...new Set([...target.sourceEvidenceIds, ...sources.flatMap((s) => s.sourceEvidenceIds)])];
      const mergedConfidence = Math.max(target.confidence, ...sources.map((s) => s.confidence));

      const updated = api.updatePerson(targetPersonId, {
        aliases: [...aliasMap.values()],
        voiceProfileIds: mergedVoiceProfileIds,
        linkedMemoryIds: mergedMemoryIds,
        supersedes: mergedSupersedes,
        sourceEvidenceIds: mergedEvidenceIds,
        confidence: mergedConfidence,
      });
      if (!updated.ok) return updated;

      // Relink relationship edges onto the target, skipping any that would
      // duplicate an edge the target already has (same type + counterparty).
      const relationships = readRelationshipsAll();
      const targetActiveKeys = new Set(
        relationships
          .filter((r) => r.status === 'active' && (r.fromEntityId === targetPersonId || r.toEntityId === targetPersonId))
          .map((r) => `${r.type}:${r.fromEntityId === targetPersonId ? r.toEntityId : r.fromEntityId}`),
      );
      const conflicts = [];
      for (let i = 0; i < relationships.length; i += 1) {
        const r = relationships[i];
        if (r.status !== 'active') continue;
        const sourceIds = new Set(sources.map((s) => s.personId));
        const involvesSource = sourceIds.has(r.fromEntityId) || sourceIds.has(r.toEntityId);
        if (!involvesSource) continue;
        const repointedFrom = sourceIds.has(r.fromEntityId) ? targetPersonId : r.fromEntityId;
        const repointedTo = sourceIds.has(r.toEntityId) ? targetPersonId : r.toEntityId;
        if (repointedFrom === repointedTo) continue; // would become a self-edge from the merge — drop
        const otherId = repointedFrom === targetPersonId ? repointedTo : repointedFrom;
        const key = `${r.type}:${otherId}`;
        if (targetActiveKeys.has(key)) {
          conflicts.push(r.relationshipId);
          continue; // target already has an equivalent edge — leave source's as historical, do not duplicate
        }
        targetActiveKeys.add(key);
        relationships[i] = { ...r, fromEntityId: repointedFrom, toEntityId: repointedTo, updatedAt: now() };
      }
      writeRelationshipsAll(relationships);

      for (const source of sources) {
        api.updatePerson(source.personId, { status: 'merged', identityStatus: 'merged', mergedInto: targetPersonId });
      }

      return { ok: true, target: getPerson(targetPersonId), mergedIds: sources.map((s) => s.personId), conflicts };
    },

    /**
     * Split selected aliases/voiceProfileIds/relationshipIds/memoryIds off of
     * `personId` into a new (or existing) target person. Anything NOT named
     * in `splitPlan` stays with the source — no guessing.
     */
    splitPerson(personId, splitPlan = {}) {
      const source = getPerson(personId);
      if (!source) return { ok: false, errors: [`no person with id ${personId}`] };

      let target;
      if (splitPlan.targetPersonId) {
        target = getPerson(splitPlan.targetPersonId);
        if (!target) return { ok: false, errors: [`no target person ${splitPlan.targetPersonId}`] };
      } else {
        const created = api.createPerson({
          displayName: splitPlan.newDisplayName ?? source.displayName,
          identityStatus: 'candidate',
          sensitivity: source.sensitivity,
          provisionalReason: `split from ${personId}`,
        });
        if (!created.ok) return created;
        target = created.person;
      }

      const aliasTexts = new Set((splitPlan.aliasTexts ?? []).map((a) => String(a).trim().toLowerCase()));
      const movingAliases = source.aliases.filter((a) => aliasTexts.has(a.normalizedAlias));
      const remainingAliases = source.aliases.filter((a) => !aliasTexts.has(a.normalizedAlias));

      const voiceMoveIds = new Set(splitPlan.voiceProfileIds ?? []);
      const movingVoiceIds = source.voiceProfileIds.filter((id) => voiceMoveIds.has(id));
      const remainingVoiceIds = source.voiceProfileIds.filter((id) => !voiceMoveIds.has(id));

      const memoryMoveIds = new Set(splitPlan.memoryIds ?? []);
      const movingMemoryIds = source.linkedMemoryIds.filter((id) => memoryMoveIds.has(id));
      const remainingMemoryIds = source.linkedMemoryIds.filter((id) => !memoryMoveIds.has(id));

      api.updatePerson(target.personId, {
        aliases: [...target.aliases, ...movingAliases],
        voiceProfileIds: [...new Set([...target.voiceProfileIds, ...movingVoiceIds])],
        linkedMemoryIds: [...new Set([...target.linkedMemoryIds, ...movingMemoryIds])],
        confidence: Math.max(0, target.confidence * 0.9),
      });
      api.updatePerson(personId, {
        aliases: remainingAliases,
        voiceProfileIds: remainingVoiceIds,
        linkedMemoryIds: remainingMemoryIds,
        confidence: Math.max(0, source.confidence * 0.9),
      });

      // Move only the explicitly-named evidence records' personId pointer.
      const evidenceMoveIds = new Set(splitPlan.evidenceIds ?? []);
      if (evidenceMoveIds.size) {
        const evidenceRecords = readEvidenceAll();
        for (let i = 0; i < evidenceRecords.length; i += 1) {
          if (evidenceMoveIds.has(evidenceRecords[i].evidenceId)) evidenceRecords[i] = { ...evidenceRecords[i], personId: target.personId };
        }
        writeEvidenceAll(evidenceRecords);
      }

      // Move only the explicitly-named relationship edges' entity pointer.
      const relationshipMoveIds = new Set(splitPlan.relationshipIds ?? []);
      if (relationshipMoveIds.size) {
        const relationships = readRelationshipsAll();
        for (let i = 0; i < relationships.length; i += 1) {
          const r = relationships[i];
          if (!relationshipMoveIds.has(r.relationshipId)) continue;
          relationships[i] = {
            ...r,
            fromEntityId: r.fromEntityId === personId ? target.personId : r.fromEntityId,
            toEntityId: r.toEntityId === personId ? target.personId : r.toEntityId,
            updatedAt: now(),
          };
        }
        writeRelationshipsAll(relationships);
      }

      return { ok: true, source: getPerson(personId), target: getPerson(target.personId) };
    },

    /** Soft delete — the record stays (status:'deleted') so evidence/relationships referencing it remain inspectable; never cascades to other people or memories. */
    deletePerson(personId, { unlinkOnly = false } = {}) {
      const person = getPerson(personId);
      if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
      if (unlinkOnly) return { ok: true, person: getPerson(personId) };
      return api.updatePerson(personId, { status: 'deleted', identityStatus: 'deleted', voiceProfileIds: [] });
    },

    exportPerson(personId) {
      const person = getPerson(personId);
      if (!person) return null;
      return { person, evidence: listEvidenceForPerson(personId), relationships: listRelationships({ entityId: personId, includeInactive: true }) };
    },

    exportAll() {
      return { people: readAll().map((p) => ({ ...p })), evidence: readEvidenceAll().map((e) => ({ ...e })), relationships: readRelationshipsAll().map((r) => ({ ...r })) };
    },

    // ── relationships ──────────────────────────────────────────────────────

    createRelationship(raw) {
      const relationshipId = raw.relationshipId ?? generateRelationshipId(now());
      const validation = validateRelationship({ ...raw, relationshipId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
      if (!validation.ok) return { ok: false, relationship: null, errors: validation.errors };
      const records = readRelationshipsAll();
      records.push(validation.relationship);
      writeRelationshipsAll(records);
      return { ok: true, relationship: { ...validation.relationship }, errors: [] };
    },

    getRelationship(relationshipId) {
      return readRelationshipsAll().find((r) => r.relationshipId === relationshipId) ?? null;
    },

    updateRelationship(relationshipId, patch) {
      const records = readRelationshipsAll();
      const index = records.findIndex((r) => r.relationshipId === relationshipId);
      if (index === -1) return { ok: false, relationship: null, errors: [`no relationship with id ${relationshipId}`] };
      const merged = { ...records[index], ...patch, relationshipId, updatedAt: now() };
      const validation = validateRelationship(merged);
      if (!validation.ok) return { ok: false, relationship: null, errors: validation.errors };
      records[index] = validation.relationship;
      writeRelationshipsAll(records);
      return { ok: true, relationship: { ...validation.relationship }, errors: [] };
    },

    /** Correction/supersession for a relationship edge — same pattern as memory's supersede(): old marked superseded, never deleted. */
    supersedeRelationship(oldId, newId) {
      const records = readRelationshipsAll();
      const oldIndex = records.findIndex((r) => r.relationshipId === oldId);
      const newIndex = records.findIndex((r) => r.relationshipId === newId);
      if (oldIndex === -1 || newIndex === -1) return { ok: false, errors: ['both oldId and newId must exist'] };
      records[oldIndex] = { ...records[oldIndex], status: 'superseded', updatedAt: now() };
      if (!records[newIndex].supersedes.includes(oldId)) {
        records[newIndex] = { ...records[newIndex], supersedes: [...records[newIndex].supersedes, oldId], updatedAt: now() };
      }
      writeRelationshipsAll(records);
      return { ok: true, old: { ...records[oldIndex] }, current: { ...records[newIndex] } };
    },

    listRelationships,

    deleteRelationship(relationshipId) {
      const records = readRelationshipsAll();
      const index = records.findIndex((r) => r.relationshipId === relationshipId);
      if (index === -1) return false;
      records.splice(index, 1);
      writeRelationshipsAll(records);
      return true;
    },

    /** Dev-only: wipe everything. Each provider scopes this to ITS OWN storage — never a shared/production DB. */
    clearAll() {
      writeAll([]);
      writeEvidenceAll([]);
      writeRelationshipsAll([]);
    },
  };

  return api;
}

export function createInMemoryIdentityRepository() {
  let people = [];
  let evidence = [];
  let relationships = [];
  return createRepositoryCore({
    load: () => people,
    save: (next) => { people = next; },
    loadEvidence: () => evidence,
    saveEvidence: (next) => { evidence = next; },
    loadRelationships: () => relationships,
    saveRelationships: (next) => { relationships = next; },
  });
}

const DEFAULT_STORAGE_KEY = 'roma.people';

/**
 * Development-only durable storage. NEVER used for raw audio, voice
 * embeddings, or biometric templates — a person record only ever holds an
 * opaque `voiceProfileId` string referencing a server-side (or, today,
 * deterministic in-memory test) profile. See identity/voiceProvider.js.
 */
export function createLocalStorageIdentityRepository({ storageKey = DEFAULT_STORAGE_KEY } = {}) {
  const evidenceKey = `${storageKey}.evidence`;
  const relationshipsKey = `${storageKey}.relationships`;
  const hasStorage = typeof localStorage !== 'undefined';
  return createRepositoryCore({
    load: () => (hasStorage ? JSON.parse(localStorage.getItem(storageKey) ?? '[]') : []),
    save: (records) => { if (hasStorage) localStorage.setItem(storageKey, JSON.stringify(records)); },
    loadEvidence: () => (hasStorage ? JSON.parse(localStorage.getItem(evidenceKey) ?? '[]') : []),
    saveEvidence: (records) => { if (hasStorage) localStorage.setItem(evidenceKey, JSON.stringify(records)); },
    loadRelationships: () => (hasStorage ? JSON.parse(localStorage.getItem(relationshipsKey) ?? '[]') : []),
    saveRelationships: (records) => { if (hasStorage) localStorage.setItem(relationshipsKey, JSON.stringify(records)); },
  });
}
