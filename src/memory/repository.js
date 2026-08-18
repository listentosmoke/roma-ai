// Provider-independent memory repository. Two implementations share one core
// (createRepositoryCore) that only differs in how records are persisted:
//
//   - createInMemoryRepository()     — deterministic Map-backed store, for
//                                       tests and Node simulation.
//   - createLocalStorageRepository() — the "one reliable local durable
//                                       provider for development" this phase
//                                       ships. This app has no server-side
//                                       database today (no accounts, single
//                                       browser client — see MEMORY.md
//                                       "Storage provider selected and why"),
//                                       so it reuses the SAME localStorage
//                                       persistence pattern already used by
//                                       proactive/preferences.js and
//                                       voice/voicePreferences.js rather than
//                                       introducing a first-ever server DB.
//
// Both implement the identical interface, so a future production database only
// needs to satisfy this same shape — nothing else in src/memory/ depends on
// which one is wired in.

import { validateMemory } from './schema.js';
import { cosineSimilarity, embeddingMatchesEmbedder } from './embeddings.js';

let counter = 0;
export function generateMemoryId(now = Date.now()) {
  counter += 1;
  return `mem_${now}_${counter}`;
}

function matchesStructured(memory, filters = {}) {
  if (filters.type && memory.type !== filters.type) return false;
  if (filters.subjectId && memory.subjectId !== filters.subjectId) return false;
  if (filters.predicate && memory.predicate !== filters.predicate) return false;
  if (filters.status && memory.status !== filters.status) return false;
  if (!filters.status && filters.includeInactive !== true && memory.status !== 'active') return false;
  if (filters.tags?.length && !filters.tags.some((t) => memory.tags.includes(t))) return false;
  if (filters.sensitivity && memory.sensitivity !== filters.sensitivity) return false;
  return true;
}

/**
 * @param {{
 *   load: () => object[],           // read all raw records (sync)
 *   save: (records: object[]) => void,
 *   loadEmbeddings: () => object,   // memoryId -> { vector, model, dimensions }
 *   saveEmbeddings: (map: object) => void,
 *   now?: () => number,
 * }} io
 */
function createRepositoryCore({ load, save, loadEmbeddings, saveEmbeddings, now = Date.now }) {
  function readAll() {
    try { return load() ?? []; } catch { return []; }
  }
  function writeAll(records) {
    try { save(records); } catch { /* storage may be unavailable — memory still works in-process */ }
  }
  function readEmbeddings() {
    try { return loadEmbeddings() ?? {}; } catch { return {}; }
  }
  function writeEmbeddings(map) {
    try { saveEmbeddings(map); } catch { /* best-effort cache */ }
  }

  return {
    create(raw) {
      const memoryId = raw.memoryId ?? generateMemoryId(now());
      const validation = validateMemory({ ...raw, memoryId, createdAt: raw.createdAt ?? now(), updatedAt: now() });
      if (!validation.ok) return { ok: false, memory: null, errors: validation.errors };
      const records = readAll();
      records.push(validation.memory);
      writeAll(records);
      return { ok: true, memory: { ...validation.memory }, errors: [] };
    },

    get(memoryId) {
      return readAll().find((m) => m.memoryId === memoryId) ?? null;
    },

    update(memoryId, patch) {
      const records = readAll();
      const index = records.findIndex((m) => m.memoryId === memoryId);
      if (index === -1) return { ok: false, memory: null, errors: [`no memory with id ${memoryId}`] };
      const merged = { ...records[index], ...patch, memoryId, updatedAt: now() };
      const validation = validateMemory(merged);
      if (!validation.ok) return { ok: false, memory: null, errors: validation.errors };
      records[index] = validation.memory;
      writeAll(records);
      return { ok: true, memory: { ...validation.memory }, errors: [] };
    },

    /**
     * Correction/supersession: mark `oldId` superseded (never deleted — its
     * history stays inspectable) and link `newId` to it. Does not change
     * `newId`'s own status.
     */
    supersede(oldId, newId) {
      const records = readAll();
      const oldIndex = records.findIndex((m) => m.memoryId === oldId);
      const newIndex = records.findIndex((m) => m.memoryId === newId);
      if (oldIndex === -1 || newIndex === -1) return { ok: false, errors: ['both oldId and newId must exist'] };
      records[oldIndex] = { ...records[oldIndex], status: 'superseded', supersededBy: newId, updatedAt: now() };
      if (!records[newIndex].supersedes.includes(oldId)) {
        records[newIndex] = { ...records[newIndex], supersedes: [...records[newIndex].supersedes, oldId], updatedAt: now() };
      }
      writeAll(records);
      return { ok: true, old: { ...records[oldIndex] }, current: { ...records[newIndex] } };
    },

    /** Deterministic duplicate/related lookup used by the Memory Writer for dedup. */
    findRelated({ type, subjectId, predicate, tags = [], includeInactive = false } = {}) {
      return readAll().filter((m) => {
        if (!includeInactive && m.status !== 'active') return false;
        if (type && m.type !== type) return false;
        if (subjectId && m.subjectId !== subjectId) return false;
        if (predicate && m.predicate !== predicate) return false;
        if (tags.length && !tags.some((t) => m.tags.includes(t))) return false;
        return true;
      });
    },

    searchStructured(filters = {}) {
      return readAll().filter((m) => matchesStructured(m, filters));
    },

    /**
     * Semantic search via cosine similarity. Only meaningful when `embedder`
     * is provided — production has none configured today (see embeddings.js),
     * so this path is exercised by tests/simulation via the mock embedder.
     * Embeddings are computed lazily and cached; a model/dimension mismatch
     * (embedder swapped) triggers re-embedding rather than serving a stale vector.
     */
    async searchSemantic({ text, embedder, limit = 20, candidates } = {}) {
      if (!embedder || !text) return [];
      const pool = candidates ?? readAll().filter((m) => m.status === 'active');
      const cache = readEmbeddings();
      const queryVector = await embedder.embed(text);
      const results = [];
      let cacheChanged = false;
      for (const memory of pool) {
        let entry = cache[memory.memoryId];
        if (!embeddingMatchesEmbedder(entry, embedder)) {
          const vector = await embedder.embed(memory.summary);
          entry = { vector, model: embedder.model, dimensions: embedder.dimensions, computedAt: now() };
          cache[memory.memoryId] = entry;
          cacheChanged = true;
        }
        results.push({ memory, score: cosineSimilarity(queryVector, entry.vector) });
      }
      if (cacheChanged) writeEmbeddings(cache);
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    markAccessed(memoryIds = []) {
      if (!memoryIds.length) return;
      const at = now();
      const records = readAll();
      for (const id of memoryIds) {
        const index = records.findIndex((m) => m.memoryId === id);
        if (index !== -1) records[index] = { ...records[index], lastAccessedAt: at };
      }
      writeAll(records);
    },

    delete(memoryId) {
      const records = readAll();
      const index = records.findIndex((m) => m.memoryId === memoryId);
      if (index === -1) return false;
      records.splice(index, 1);
      // Dependent records: drop dangling links rather than leaving references
      // to a memory that no longer exists (searchable but never crashes).
      for (let i = 0; i < records.length; i += 1) {
        let changed = false;
        let next = records[i];
        if (next.supersededBy === memoryId) { next = { ...next, supersededBy: null }; changed = true; }
        if (next.supersedes.includes(memoryId)) { next = { ...next, supersedes: next.supersedes.filter((id) => id !== memoryId) }; changed = true; }
        if (next.contradicts.includes(memoryId)) { next = { ...next, contradicts: next.contradicts.filter((id) => id !== memoryId) }; changed = true; }
        if (changed) records[i] = next;
      }
      writeAll(records);
      const cache = readEmbeddings();
      if (cache[memoryId]) { delete cache[memoryId]; writeEmbeddings(cache); }
      return true;
    },

    /** Delete every memory whose source.interactionId matches (e.g. an explicit "forget everything from that conversation"). */
    deleteBySource(interactionId) {
      const records = readAll();
      const toDelete = records.filter((m) => m.source.interactionId === interactionId).map((m) => m.memoryId);
      let count = 0;
      for (const id of toDelete) if (this.delete(id)) count += 1;
      return count;
    },

    exportAll() {
      return readAll().map((m) => ({ ...m }));
    },

    /** Dev-only: wipe everything. Each provider scopes this to ITS OWN storage
     * (a distinct localStorage key / in-process Map) — never a shared/production DB. */
    clearAll() {
      writeAll([]);
      writeEmbeddings({});
    },
  };
}

export function createInMemoryRepository() {
  let records = [];
  let embeddings = {};
  return createRepositoryCore({
    load: () => records,
    save: (next) => { records = next; },
    loadEmbeddings: () => embeddings,
    saveEmbeddings: (next) => { embeddings = next; },
  });
}

const DEFAULT_STORAGE_KEY = 'roma.memories';

export function createLocalStorageRepository({ storageKey = DEFAULT_STORAGE_KEY } = {}) {
  const embeddingsKey = `${storageKey}.embeddings`;
  const hasStorage = typeof localStorage !== 'undefined';
  return createRepositoryCore({
    load: () => (hasStorage ? JSON.parse(localStorage.getItem(storageKey) ?? '[]') : []),
    save: (records) => { if (hasStorage) localStorage.setItem(storageKey, JSON.stringify(records)); },
    loadEmbeddings: () => (hasStorage ? JSON.parse(localStorage.getItem(embeddingsKey) ?? '{}') : {}),
    saveEmbeddings: (map) => { if (hasStorage) localStorage.setItem(embeddingsKey, JSON.stringify(map)); },
  });
}
