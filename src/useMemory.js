// React glue around the Memory coordinator (src/memory/coordinator.js).
// Builds ONE coordinator and hands it to useAgent as the `memory` dependency,
// exactly like speechGate/speech are threaded through from other hooks. Also
// owns the state the dev Memory panel renders: counts by type, recent
// write/retrieval events, and delete/clear-all controls.
//
// REPOSITORY SELECTION (see SERVER-DATA.md "Repository providers"): starts
// optimistically with the server-backed repository (src/server/
// remoteMemoryRepository.js — a synchronous local mirror hydrated from and
// synced to the authenticated data API). A startup `/api/data/health` check
// then either confirms it, or falls back:
//   - development, server unreachable -> explicit, clearly-labeled
//     localStorage fallback (never silent).
//   - production, server unreachable  -> fails CLOSED (createUnavailable...)
//     rather than silently writing durable/sensitive data to localStorage.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createMemoryCoordinator } from './memory/coordinator.js';
import { createServerEmbedderIfAvailable, warmEmbeddingCache } from './memory/proxyEmbedder.js';
import { createLocalStorageRepository } from './memory/repository.js';
import { createProxyProvider, createProvider } from './agent/provider.js';
import { memoryConfig } from './memory/config.js';
import { createDataClient } from './server/dataClient.js';
import { createServerBackedMemoryRepository, createUnavailableMemoryRepository } from './server/remoteMemoryRepository.js';
import { createMutationQueue } from './server/mutationQueue.js';
import { serverDataConfig, createDelegatingRepository } from './server/config.js';

const MAX_EVENTS = 60;

export function useMemory() {
  const [health, setHealth] = useState(null);
  const [events, setEvents] = useState([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, byType: {} });
  const [dataProviderStatus, setDataProviderStatus] = useState({ mode: 'server', checked: false });
  const [queueStatus, setQueueStatus] = useState(null);
  const activeProviderRef = useRef(createProxyProvider(memoryConfig.proxy)); // optimistic: reuse the agent proxy

  const dataClient = useMemo(() => createDataClient(), []);
  // Reliable mutation queue (src/server/mutationQueue.js): every server write
  // is a tracked, idempotent, retryable operation — pending until the server
  // acknowledges it, visible in the Server Data panel when it isn't.
  const mutationQueue = useMemo(() => createMutationQueue({
    dataClient,
    storage: typeof localStorage === 'undefined' ? null : localStorage,
    storageKey: 'roma.sync.memory',
    label: 'memory',
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  // Built once, outside the coordinator, so usePeople.js can be handed the
  // SAME repository instance for identity <-> memory relinking (identity/
  // coordinator.js's mergePeople/relinkMemoriesForInteraction) without either
  // hook depending on the other's internals.
  const activeRepositoryRef = useRef(null);
  activeRepositoryRef.current ??= createServerBackedMemoryRepository({ dataClient, mutationQueue, onSyncError: (op, error) => console.warn(`[memory] server sync failed (${op}):`, error.message) });
  const repository = useMemo(() => createDelegatingRepository(activeRepositoryRef), []);

  // The real encoder lives on the server, so whether one exists is only known
  // after a round trip — while the coordinator is built synchronously. It is
  // therefore handed a GETTER: retrieval uses token overlap until the answer
  // arrives, then semantic scoring, with no rebuild and no lost state.
  const embedderRef = useRef(null);
  const [embedderStatus, setEmbedderStatus] = useState({ configured: false, name: null, model: null, dimensions: null });

  const coordinator = useMemo(() => {
    // Delegating provider so a health check can swap proxy -> mock without
    // rebuilding the coordinator (same pattern as useAgent.js/useProactive.js).
    const provider = { infer: (request) => activeProviderRef.current.infer(request) };
    return createMemoryCoordinator({ repository, provider, embedder: () => embedderRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    createServerEmbedderIfAvailable({ dataClient })
      .then(async (embedder) => {
        if (cancelled || !embedder) return;
        embedderRef.current = embedder;
        setEmbedderStatus(coordinator.embedderStatus());
        // Hydration has to have finished, or there are no memories to attach
        // vectors to yet.
        await Promise.resolve(repository.ready?.());
        if (cancelled) return;
        const warmed = await warmEmbeddingCache({ dataClient, repository, embedder });
        if (!cancelled) setEmbedderStatus({ ...coordinator.embedderStatus(), ...warmed, cached: repository.embeddingCacheSize?.() ?? 0 });
      })
      .catch(() => { /* keyword retrieval is the honest fallback, not an error */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (health && !health?.agent?.available) {
      activeProviderRef.current = createProvider({ provider: 'mock', decide: async () => ({ candidates: [] }) });
    }
  }, [health]);

  // Startup check: is the authenticated data API reachable? Never silently
  // decided — the outcome is always reflected in dataProviderStatus for the
  // Server Data panel.
  useEffect(() => {
    let cancelled = false;
    dataClient.get(serverDataConfig.healthEndpoint)
      .then((body) => {
        if (cancelled) return;
        setDataProviderStatus({ mode: 'server', checked: true, authMode: body.authMode, principal: body.principal });
      })
      .catch(() => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          activeRepositoryRef.current = createLocalStorageRepository({ storageKey: memoryConfig.storageKey });
          setDataProviderStatus({ mode: 'localStorage-dev-fallback', checked: true });
        } else {
          activeRepositoryRef.current = createUnavailableMemoryRepository();
          setDataProviderStatus({ mode: 'unavailable', checked: true });
        }
        refreshCounts();
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshCounts() { setCounts(coordinator.counts()); }

  useEffect(() => {
    refreshCounts(); // may already hold data from a previous session (server or localStorage fallback)
    // Hydration from the server finishes AFTER this effect runs, and nothing
    // else re-reads the counts — so without this the panel sat at zero until
    // some unrelated event happened to refresh it, and a person who exists on
    // the server was invisible (and could not be enrolled or corrected).
    Promise.resolve(repository.ready?.()).then(refreshCounts).catch(() => {});
    return coordinator.subscribe((event) => {
      setEvents((existing) => [...existing, event].slice(-MAX_EVENTS));
      refreshCounts();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinator]);

  useEffect(() => {
    setQueueStatus(mutationQueue.status());
    return mutationQueue.subscribe(() => setQueueStatus(mutationQueue.status()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutationQueue]);

  return {
    coordinator, // pass as `memory` to useAgent, and register memory tools with it
    repository, // exposed so usePeople.js can relink identity <-> memory records through the SAME store (see identity/coordinator.js's mergePeople/relinkMemoriesForInteraction)
    mutationQueue,
    queueStatus,
    dataProviderStatus,
    setHealth, // App forwards useAgent's /api/health result (same hook-order break as useProactive/useVoiceDelivery)
    events,
    counts,
    embedderStatus, // state, not a call: it changes once the server answers
    list: (filters) => coordinator.list(filters),
    explain: (id) => coordinator.explain(id),
    deleteMemory: (id) => { const ok = coordinator.deleteMemory(id); refreshCounts(); return ok; },
    clearAll: () => { coordinator.clearAll(); refreshCounts(); },
  };
}
