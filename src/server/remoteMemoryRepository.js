// Server-backed Memory Repository for the BROWSER side. Satisfies the exact
// same synchronous interface src/memory/repository.js's client repositories
// expose (create/get/update/supersede/findRelated/searchStructured/
// searchSemantic/markAccessed/delete/deleteBySource/exportAll/clearAll) —
// src/memory/writer.js and retriever.js call these SYNCHRONOUSLY (no
// `await`) today, and that could not change without redesigning the Memory
// Writer (explicitly out of scope for this phase).
//
// HOW THIS MAKES THE SERVER AUTHORITATIVE WITHOUT AN ASYNC REPOSITORY
// INTERFACE: this object wraps a plain in-memory local repository (the exact
// same `createInMemoryRepository()` used by tests — full validation, zero
// reimplemented logic) as a synchronous CACHE, hydrated from the server on
// construction and kept in sync by mirroring every local mutation to the
// server in the background (fire-and-forget, logged on failure). The local
// copy is disposable and reconstructible at any time via `hydrate()` — it is
// a cache, not the source of truth. A page reload (or a second browser
// hitting the same server) re-hydrates from SQLite, not from anything the
// browser itself persisted. See SERVER-DATA.md "Repository providers" for
// the full rationale.
//
// Stabilization-phase update: server writes now go through the reliable
// mutation queue (src/server/mutationQueue.js) when one is provided —
// stable operation IDs, tenant-scoped server-side idempotency, bounded
// retry with backoff, visible pending/failed/conflicted states, and
// delete-supersedes-pending-write ordering. Fire-and-forget remains only
// as the legacy fallback when no queue is configured.

import { createInMemoryRepository } from '../memory/repository.js';

/**
 * Production fail-closed state: the server data API is unavailable and (per
 * "must not silently write sensitive records to localStorage") this app
 * must NOT quietly degrade to an in-memory-only or localStorage store.
 * Every mutation reports failure with a clear reason; every read returns
 * empty. The UI (Server Data panel) surfaces `unavailable: true` prominently.
 */
export function createUnavailableMemoryRepository() {
  const deny = { ok: false, memory: null, errors: ['Server data is unavailable — memory is disabled until the server is reachable.'] };
  return {
    unavailable: true,
    ready: () => Promise.resolve(),
    create: () => deny,
    get: () => null,
    update: () => deny,
    supersede: () => ({ ok: false, errors: deny.errors }),
    findRelated: () => [],
    searchStructured: () => [],
    searchSemantic: async () => [],
    seedEmbeddings: () => 0,
    embeddingCacheSize: () => 0,
    markAccessed: () => {},
    delete: () => false,
    deleteBySource: () => 0,
    exportAll: () => [],
    clearAll: () => {},
    rehydrate: () => Promise.resolve(),
  };
}

export function createServerBackedMemoryRepository({ dataClient, mutationQueue = null, onSyncError = () => {} } = {}) {
  const local = createInMemoryRepository();
  let readyPromise = null;

  function hydrate() {
    readyPromise = dataClient.get('/api/data/memory/export')
      .then((res) => { for (const memory of res.memories ?? []) local.create(memory); })
      .catch((error) => { onSyncError('hydrate', error); });
    return readyPromise;
  }
  hydrate();

  // With a mutationQueue configured (the stabilization-phase default — see
  // src/server/mutationQueue.js), every server write becomes a tracked,
  // idempotent, retryable operation whose pending/acknowledged state is
  // observable. Without one (legacy callers/tests), the original
  // fire-and-forget behavior is preserved unchanged.
  function sendMutation({ kind, method, path, body = null, entityId = null, sensitivity = 'normal' }) {
    if (mutationQueue) {
      try {
        mutationQueue.submit({ kind, method, path, body, entityType: 'memory', entityId, sensitivity });
      } catch (error) {
        onSyncError(kind, error);
      }
      return;
    }
    const request = method === 'del' ? dataClient.del(path) : dataClient[method](path, body);
    request.catch((e) => onSyncError(kind, e));
  }

  return {
    ready: () => readyPromise,
    create(raw) {
      const result = local.create(raw);
      if (result.ok) sendMutation({ kind: 'create', method: 'post', path: '/api/data/memory', body: result.memory, entityId: result.memory.memoryId, sensitivity: result.memory.sensitivity });
      return result;
    },
    get: (id) => local.get(id),
    update(id, patch) {
      const result = local.update(id, patch);
      if (result.ok) sendMutation({ kind: 'update', method: 'patch', path: `/api/data/memory/${id}`, body: patch, entityId: id, sensitivity: result.memory.sensitivity });
      return result;
    },
    supersede(oldId, newId) {
      const result = local.supersede(oldId, newId);
      if (result.ok) sendMutation({ kind: 'correct', method: 'post', path: `/api/data/memory/${oldId}/supersede`, body: { newId }, entityId: oldId });
      return result;
    },
    findRelated: (filters) => local.findRelated(filters),
    searchStructured: (filters) => local.searchStructured(filters),
    searchSemantic: (args) => local.searchSemantic(args), // already async — client-side embedder scoring is unaffected
    seedEmbeddings: (entries, options) => local.seedEmbeddings(entries, options),
    embeddingCacheSize: () => local.embeddingCacheSize(),
    markAccessed(ids) {
      local.markAccessed(ids);
      if (ids?.length) sendMutation({ kind: 'access', method: 'post', path: '/api/data/memory/access', body: { ids } });
    },
    delete(id) {
      const ok = local.delete(id);
      if (ok) sendMutation({ kind: 'delete', method: 'del', path: `/api/data/memory/${id}`, entityId: id });
      return ok;
    },
    deleteBySource(interactionId) {
      const count = local.deleteBySource(interactionId);
      if (count) sendMutation({ kind: 'delete', method: 'post', path: '/api/data/memory/delete-by-source', body: { interactionId }, entityId: interactionId });
      return count;
    },
    exportAll: () => local.exportAll(),
    /** Dev-only: clears the LOCAL mirror only — never touches server data (see the People/Memory panel's "Clear all (dev)" button, which is explicitly local-cache-only when server-backed). */
    clearAll: () => local.clearAll(),
    rehydrate: hydrate,
  };
}
