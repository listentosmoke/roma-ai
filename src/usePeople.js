// React glue around the Identity coordinator (src/identity/coordinator.js).
// Same shape as useMemory.js deliberately: builds ONE coordinator and hands
// it to useAgent as the `identity` dependency. Also owns the state the dev
// People panel renders: counts by identity status, recent resolution/
// evidence events, and the confirm/reject/merge/split/delete controls.
//
// `memoryRepository` (from useMemory.js) is optional but should be passed so
// merge/relink operations can update memory records' entity links through the
// SAME store — see identity/coordinator.js's mergePeople/
// relinkMemoriesForInteraction.
//
// REPOSITORY SELECTION: same server-backed-first, explicit-fallback pattern
// as useMemory.js — see that file's doc comment and SERVER-DATA.md
// "Repository providers".

import { useEffect, useMemo, useRef, useState } from 'react';
import { createIdentityCoordinator } from './identity/coordinator.js';
import { createEntityResolver } from './identity/resolver.js';
import { createLocalStorageIdentityRepository } from './identity/repository.js';
import { createVoiceProvider } from './identity/voiceProvider.js';
import { identityConfig } from './identity/config.js';
import { createDataClient } from './server/dataClient.js';
import { createServerBackedIdentityRepository, createUnavailableIdentityRepository } from './server/remoteIdentityRepository.js';
import { createMutationQueue } from './server/mutationQueue.js';
import { serverDataConfig, createDelegatingRepository } from './server/config.js';

const MAX_EVENTS = 60;

export function usePeople({ memoryRepository = null, memoryCoordinator = null } = {}) {
  const [events, setEvents] = useState([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, byIdentityStatus: {} });
  const [dataProviderStatus, setDataProviderStatus] = useState({ mode: 'server', checked: false });
  const [queueStatus, setQueueStatus] = useState(null);

  const dataClient = useMemo(() => createDataClient(), []);
  // Same reliable-mutation pattern as useMemory.js. Voice-profile-reference
  // mutations are tagged category 'voice_profile' so consent revocation /
  // profile deletion can cancel pending ones (see useVoiceIdentity.js).
  const mutationQueue = useMemo(() => createMutationQueue({
    dataClient,
    storage: typeof localStorage === 'undefined' ? null : localStorage,
    storageKey: 'roma.sync.identity',
    label: 'identity',
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const activeRepositoryRef = useRef(null);
  activeRepositoryRef.current ??= createServerBackedIdentityRepository({ dataClient, mutationQueue, onSyncError: (op, error) => console.warn(`[identity] server sync failed (${op}):`, error.message) });
  const repository = useMemo(() => createDelegatingRepository(activeRepositoryRef), []);

  const coordinator = useMemo(() => {
    const voiceProvider = createVoiceProvider({ mode: identityConfig.voiceProviderMode });
    const resolver = createEntityResolver({ repository, voiceProvider, sessionTimeoutMs: identityConfig.sessionTimeoutMs });
    return createIdentityCoordinator({ repository, resolver, voiceProvider, memoryRepository });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    dataClient.get(serverDataConfig.healthEndpoint)
      .then(() => { if (!cancelled) setDataProviderStatus({ mode: 'server', checked: true }); })
      .catch(() => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          activeRepositoryRef.current = createLocalStorageIdentityRepository({ storageKey: identityConfig.storageKey });
          setDataProviderStatus({ mode: 'localStorage-dev-fallback', checked: true });
        } else {
          activeRepositoryRef.current = createUnavailableIdentityRepository();
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

  // "Forgetting a memory removes its person link" — subscribes to the memory
  // coordinator's own event bus rather than either module importing the
  // other's internals (identity/coordinator.js's attachMemoryLifecycle).
  useEffect(() => {
    if (!memoryCoordinator) return undefined;
    return coordinator.attachMemoryLifecycle(memoryCoordinator);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinator, memoryCoordinator]);

  useEffect(() => {
    setQueueStatus(mutationQueue.status());
    return mutationQueue.subscribe(() => setQueueStatus(mutationQueue.status()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutationQueue]);

  return {
    coordinator, // pass as `identity` to useAgent, and register identity tools with it
    mutationQueue,
    queueStatus,
    events,
    counts,
    dataProviderStatus,
    voiceProviderStatus: coordinator.voiceProviderStatus(),
    list: (filters) => coordinator.list(filters),
    listRelationships: (filters) => coordinator.listRelationships(filters),
    showIdentityEvidence: (personId) => coordinator.showIdentityEvidence(personId),
    // What Roma knows about someone — the same read the agent gets.
    briefFor: (personId) => coordinator.briefFor(personId),
    showPersonProfile: (personId) => coordinator.showPersonProfile(personId),
    confirmMatch: (args) => { const r = coordinator.confirmMatch(args); refreshCounts(); return r; },
    rejectMatch: (args) => { const r = coordinator.rejectMatch(args); refreshCounts(); return r; },
    acceptServerVoiceResolution: (args) => coordinator.acceptServerVoiceResolution(args),
    updatePerson: (args) => { const r = coordinator.updatePerson(args); refreshCounts(); return r; },
    mergePeople: (args) => { const r = coordinator.mergePeople(args); refreshCounts(); return r; },
    splitPerson: (args) => { const r = coordinator.splitPerson(args); refreshCounts(); return r; },
    previewDeletePerson: (personId) => coordinator.previewDeletePerson(personId),
    forgetPerson: async (args) => { const r = await coordinator.forgetPerson(args); refreshCounts(); return r; },
    enrollVoice: async (args) => { const r = await coordinator.enrollVoice(args); refreshCounts(); return r; },
    removeVoiceProfile: async (args) => { const r = await coordinator.removeVoiceProfile(args); refreshCounts(); return r; },
    // Face enrollment happens SERVER-side (the browser never holds a template);
    // these mirror the resulting profile reference and its evidence locally.
    recordFaceEnrollment: (args) => { const r = coordinator.recordFaceEnrollment(args); refreshCounts(); return r; },
    removeFaceProfile: (args) => { const r = coordinator.removeFaceProfile(args); refreshCounts(); return r; },
    get: (personId) => coordinator.get(personId),
    clearAll: () => { coordinator.clearAll(); refreshCounts(); },
  };
}
