// Server-backed Person Repository for the BROWSER side — same "synchronous
// local mirror + background server sync" pattern as remoteMemoryRepository.js
// (see that file's doc comment for the full rationale). Wraps
// `createInMemoryIdentityRepository()` unchanged so src/identity/resolver.js
// and coordinator.js (which call every method synchronously) never change.

import { createInMemoryIdentityRepository } from '../identity/repository.js';

/** Production fail-closed state — see remoteMemoryRepository.js's createUnavailableMemoryRepository() for the full rationale. */
export function createUnavailableIdentityRepository() {
  const deny = { ok: false, errors: ['Server data is unavailable — identity is disabled until the server is reachable.'] };
  return {
    unavailable: true,
    ready: () => Promise.resolve(),
    createPerson: () => deny,
    getPerson: () => null,
    updatePerson: () => deny,
    findByName: () => [],
    findByAlias: () => [],
    findCandidates: () => [],
    listPeople: () => [],
    addEvidence: () => deny,
    getEvidence: () => null,
    listEvidenceForPerson: () => [],
    linkVoiceProfile: () => deny,
    unlinkVoiceProfile: () => deny,
    linkMemory: () => deny,
    unlinkMemory: () => deny,
    mergePeople: () => deny,
    splitPerson: () => deny,
    deletePerson: () => deny,
    exportPerson: () => null,
    exportAll: () => ({ people: [], evidence: [], relationships: [] }),
    clearAll: () => {},
    createRelationship: () => ({ ok: false, relationship: null, errors: deny.errors }),
    getRelationship: () => null,
    updateRelationship: () => ({ ok: false, relationship: null, errors: deny.errors }),
    supersedeRelationship: () => ({ ok: false, errors: deny.errors }),
    listRelationships: () => [],
    deleteRelationship: () => false,
    rehydrate: () => Promise.resolve(),
  };
}

export function createServerBackedIdentityRepository({ dataClient, mutationQueue = null, onSyncError = () => {} } = {}) {
  const local = createInMemoryIdentityRepository();
  let readyPromise = null;

  function hydrate() {
    readyPromise = dataClient.get('/api/data/identity/export')
      .then((res) => {
        for (const person of res.people ?? []) local.createPerson(person);
        for (const evidence of res.evidence ?? []) local.addEvidence(evidence);
        for (const relationship of res.relationships ?? []) local.createRelationship(relationship);
      })
      .catch((error) => { onSyncError('hydrate', error); });
    return readyPromise;
  }
  hydrate();

  // Same reliable-mutation pattern as remoteMemoryRepository.js (see that
  // file's doc comment). `category: 'voice_profile'` tags the opaque
  // profile-reference link/unlink mutations so consent revocation and
  // profile deletion can cancel any still-pending ones
  // (mutationQueue.cancelWhere) — a retried operation can never replay a
  // revoked biometric action. Raw biometric material never appears here at
  // all: these paths only ever carry opaque voiceProfileId strings.
  function sendMutation({ kind, method, path, body = null, entityType = 'person', entityId = null, category = 'data', sensitivity = 'normal' }) {
    if (mutationQueue) {
      try {
        mutationQueue.submit({ kind, method, path, body, entityType, entityId, category, sensitivity });
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

    createPerson(raw) {
      const result = local.createPerson(raw);
      if (result.ok) sendMutation({ kind: 'create', method: 'post', path: '/api/data/people', body: result.person, entityId: result.person.personId, sensitivity: result.person.sensitivity });
      return result;
    },
    getPerson: (id) => local.getPerson(id),
    updatePerson(id, patch) {
      const result = local.updatePerson(id, patch);
      if (result.ok) sendMutation({ kind: 'update', method: 'patch', path: `/api/data/people/${id}`, body: patch, entityId: id });
      return result;
    },
    findByName: (name, opts) => local.findByName(name, opts),
    findByAlias: (alias) => local.findByAlias(alias),
    findCandidates: (args) => local.findCandidates(args),
    listPeople: (filters) => local.listPeople(filters),

    addEvidence(raw) {
      const result = local.addEvidence(raw);
      if (result.ok) sendMutation({ kind: 'create', method: 'post', path: '/api/data/evidence', body: result.evidence, entityType: 'identity_evidence', entityId: result.evidence.evidenceId, sensitivity: result.evidence.sensitivity });
      return result;
    },
    getEvidence: (id) => local.getEvidence(id),
    listEvidenceForPerson: (id) => local.listEvidenceForPerson(id),

    linkVoiceProfile(personId, voiceProfileId) {
      const result = local.linkVoiceProfile(personId, voiceProfileId);
      sendMutation({ kind: 'update', method: 'post', path: `/api/data/people/${personId}/voice-profile`, body: { voiceProfileId }, entityType: 'voice_profile_ref', entityId: voiceProfileId, category: 'voice_profile' });
      return result;
    },
    unlinkVoiceProfile(personId, voiceProfileId) {
      const result = local.unlinkVoiceProfile(personId, voiceProfileId);
      sendMutation({ kind: 'delete', method: 'del', path: `/api/data/people/${personId}/voice-profile/${voiceProfileId}`, entityType: 'voice_profile_ref', entityId: voiceProfileId, category: 'voice_profile' });
      return result;
    },

    // linkMemory/unlinkMemory: local-only. The production path that matters
    // (identity/coordinator.js's relinkMemoriesForInteraction) sets
    // speakerEntityId via memoryRepository.update(), which the SERVER's
    // memory repository already turns into a real memory_entity_links row
    // (syncEntityLinks) — so the link reaches the server through that call,
    // not this one. A direct linkMemory() call (rare — no current caller
    // outside that flow) stays local-only until a dedicated route is added.
    linkMemory: (personId, memoryId) => local.linkMemory(personId, memoryId),
    unlinkMemory: (personId, memoryId) => local.unlinkMemory(personId, memoryId),

    mergePeople(sourcePersonIds, targetPersonId, options) {
      const result = local.mergePeople(sourcePersonIds, targetPersonId, options);
      if (result.ok) sendMutation({ kind: 'merge', method: 'post', path: '/api/data/people/merge', body: { sourcePersonIds, targetPersonId }, entityId: targetPersonId });
      return result;
    },
    splitPerson(personId, splitPlan) {
      const result = local.splitPerson(personId, splitPlan);
      if (result.ok) sendMutation({ kind: 'split', method: 'post', path: `/api/data/people/${personId}/split`, body: splitPlan, entityId: personId });
      return result;
    },
    deletePerson(personId) {
      const result = local.deletePerson(personId);
      if (result.ok) sendMutation({ kind: 'delete', method: 'del', path: `/api/data/people/${personId}`, entityId: personId });
      return result;
    },

    exportPerson: (id) => local.exportPerson(id),
    exportAll: () => local.exportAll(),
    clearAll: () => local.clearAll(),

    createRelationship(raw) {
      const result = local.createRelationship(raw);
      if (result.ok) sendMutation({ kind: 'create', method: 'post', path: '/api/data/relationships', body: result.relationship, entityType: 'relationship', entityId: result.relationship.relationshipId, sensitivity: result.relationship.sensitivity });
      return result;
    },
    getRelationship: (id) => local.getRelationship(id),
    updateRelationship(id, patch) {
      const result = local.updateRelationship(id, patch);
      if (result.ok) sendMutation({ kind: 'update', method: 'patch', path: `/api/data/relationships/${id}`, body: patch, entityType: 'relationship', entityId: id });
      return result;
    },
    supersedeRelationship(oldId, newId) {
      const result = local.supersedeRelationship(oldId, newId);
      if (result.ok) sendMutation({ kind: 'correct', method: 'post', path: `/api/data/relationships/${oldId}/supersede`, body: { newId }, entityType: 'relationship', entityId: oldId });
      return result;
    },
    listRelationships: (filters) => local.listRelationships(filters),
    deleteRelationship(id) {
      const ok = local.deleteRelationship(id);
      if (ok) sendMutation({ kind: 'delete', method: 'del', path: `/api/data/relationships/${id}`, entityType: 'relationship', entityId: id });
      return ok;
    },

    rehydrate: hydrate,
  };
}
