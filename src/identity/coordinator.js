// Top-level Identity API — combines the Person Repository, Entity Resolver,
// and voice-identity provider into the operations the rest of the app needs:
// resolve the current speaker for context assembly, run the explicit
// identify/name/confirm/reject/correct/merge/split/enroll/relationship
// operations, and read data for the dev People panel. Mirrors
// memory/coordinator.js's shape deliberately — same event-bus pattern, same
// "every mutating or model-assisted call emits an event" rule, so the
// People panel and diagnostics show exactly what happened with no hidden
// reasoning, only structured outcomes and reason codes.
//
// Resolution/relationship/relinking context reaches the agent ONLY through
// the Context Compiler (see agent/prompt.js's CURRENT SPEAKER / RELEVANT
// RELATIONSHIPS sections) — nothing here can speak or bypass the Speech Gate.

import { generateRelationshipId } from './repository.js';
import { RESOLUTION_THRESHOLDS } from './resolver.js';

const MAX_RELATIONSHIPS_FOR_CONTEXT = 5;
const MAX_RELINK_MEMORIES = 10;

function displayFor(repository, entityId) {
  if (entityId === 'person_user') return 'the user';
  const person = repository.getPerson(entityId);
  return person?.displayName ?? entityId;
}

/**
 * @param {{ repository: object, resolver: object, voiceProvider?: object, now?: Function, memoryRepository?: object }} deps
 */
export function createIdentityCoordinator({ repository, resolver, voiceProvider = null, now = Date.now, memoryRepository = null } = {}) {
  const listeners = new Set();
  function emit(event) {
    const full = { at: now(), ...event };
    for (const listener of listeners) listener(full);
    return full;
  }

  function relationshipsFor(personId, { limit = MAX_RELATIONSHIPS_FOR_CONTEXT } = {}) {
    if (!personId) return [];
    return repository
      .listRelationships({ entityId: personId })
      .slice(0, limit)
      .map((r) => {
        const otherId = r.fromEntityId === personId ? r.toEntityId : r.fromEntityId;
        return {
          relationshipId: r.relationshipId,
          type: r.type,
          label: r.label,
          otherEntityId: otherId,
          otherDisplayName: displayFor(repository, otherId),
          confidence: r.confidence,
          status: r.status,
        };
      });
  }

  /** Resolve the current turn's speaker for the Context Compiler. Denormalizes person + a bounded relationship slice so agent/prompt.js can format them without touching the repository itself. */
  async function resolveSpeakerForTurn(query, options = {}) {
    const result = await resolver.resolve(query, options);
    const person = result.personId ? repository.getPerson(result.personId) : null;
    emit({ type: 'identity-resolved', speakerLabel: query.speakerLabel, status: result.status, personId: result.personId, reasonCode: result.reasonCode, requiresConfirmation: result.requiresConfirmation, sessionId: query.sessionId ?? null, interactionId: query.interactionId ?? null });
    return {
      ...result,
      person: person ? { personId: person.personId, displayName: person.displayName, identityStatus: person.identityStatus, confidence: person.confidence } : null,
      relationships: person ? relationshipsFor(person.personId) : [],
    };
  }

  function wrapExplicit(kind, fn) {
    return (args) => {
      const result = fn(args);
      emit({ type: `identity-${kind}`, speakerLabel: args.speakerLabel ?? null, status: result.status, personId: result.personId, reasonCode: result.reasonCode, evidenceIds: result.evidenceIds ?? [], sessionId: args.sessionId ?? null });
      return result;
    };
  }

  const attribute = wrapExplicit('attribution', resolver.attribute);
  const selfIdentify = wrapExplicit('self-identification', resolver.selfIdentify);
  const confirmMatch = wrapExplicit('confirmation', resolver.confirmMatch);
  const rejectMatch = wrapExplicit('rejection', resolver.rejectMatch);
  const correctIdentity = wrapExplicit('correction', resolver.correctIdentity);

  function acceptServerVoiceResolution(args) {
    const result = resolver.acceptServerResolution(args);
    emit({ type: 'identity-voice-server-resolution', speakerLabel: args.speakerLabel ?? null, status: result.status ?? 'rejected', personId: result.personId ?? null, reasonCode: result.reasonCode, evidenceIds: result.evidenceIds ?? [], sessionId: args.sessionId ?? null });
    return result;
  }

  function createPerson({ displayName, roles = [], identityStatus = 'confirmed', sensitivity = 'normal' }) {
    const result = repository.createPerson({ displayName, roles, identityStatus, sensitivity });
    emit({ type: 'identity-person-created', personId: result.person?.personId ?? null, displayName, ok: result.ok, errors: result.errors });
    return result;
  }

  /** Rename / add alias / update roles. A rename keeps the old name as an alias rather than discarding it. */
  function updatePerson({ personId, displayName, addAlias, roles }) {
    const person = repository.getPerson(personId);
    if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
    const patch = {};
    if (displayName && displayName !== person.displayName) {
      patch.displayName = displayName;
      const alreadyAliased = person.aliases.some((a) => a.normalizedAlias === person.displayName.trim().toLowerCase());
      patch.aliases = alreadyAliased ? person.aliases : [...person.aliases, { alias: person.displayName, type: 'name', confidence: 0.8 }];
    }
    if (addAlias) {
      const base = patch.aliases ?? person.aliases;
      const normalized = String(addAlias).trim().toLowerCase();
      patch.aliases = base.some((a) => a.normalizedAlias === normalized) ? base : [...base, { alias: addAlias, type: 'nickname', confidence: 0.8 }];
    }
    if (roles) patch.roles = roles;
    const result = repository.updatePerson(personId, patch);
    emit({ type: 'identity-person-updated', personId, ok: result.ok, errors: result.errors });
    return result;
  }

  function removeAlias({ personId, alias }) {
    const person = repository.getPerson(personId);
    if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
    const normalized = String(alias).trim().toLowerCase();
    const result = repository.updatePerson(personId, { aliases: person.aliases.filter((a) => a.normalizedAlias !== normalized) });
    emit({ type: 'identity-alias-removed', personId, alias, ok: result.ok });
    return result;
  }

  function mergePeople({ sourcePersonIds, targetPersonId, reasonCode = 'user_merge' }) {
    const result = repository.mergePeople(sourcePersonIds, targetPersonId, { reasonCode });
    if (result.ok) {
      for (const sourceId of result.mergedIds) resolver.invalidateForPerson(sourceId);
      if (memoryRepository) {
        // Relink linkedMemoryIds' speakerEntityId/mentionedEntityIds pointers from source -> target so a later retrieval never surfaces a stale personId.
        for (const sourceId of result.mergedIds) {
          for (const memory of memoryRepository.searchStructured({ includeInactive: true })) {
            let changed = false;
            const patch = {};
            if (memory.speakerEntityId === sourceId) { patch.speakerEntityId = targetPersonId; changed = true; }
            if (Array.isArray(memory.subjectEntityIds) && memory.subjectEntityIds.includes(sourceId)) { patch.subjectEntityIds = [...new Set(memory.subjectEntityIds.map((id) => (id === sourceId ? targetPersonId : id)))]; changed = true; }
            if (Array.isArray(memory.mentionedEntityIds) && memory.mentionedEntityIds.includes(sourceId)) { patch.mentionedEntityIds = [...new Set(memory.mentionedEntityIds.map((id) => (id === sourceId ? targetPersonId : id)))]; changed = true; }
            if (changed) memoryRepository.update(memory.memoryId, patch);
          }
        }
      }
    }
    emit({ type: 'identity-merged', targetPersonId, sourcePersonIds, ok: result.ok, errors: result.errors, conflicts: result.conflicts ?? [] });
    return result;
  }

  function splitPerson({ personId, splitPlan }) {
    const result = repository.splitPerson(personId, splitPlan);
    if (result.ok) {
      resolver.invalidateForPerson(personId);
      if (result.target) resolver.invalidateForPerson(result.target.personId);
    }
    emit({ type: 'identity-split', personId, targetPersonId: result.target?.personId ?? null, ok: result.ok, errors: result.errors });
    return result;
  }

  /** Bounded impact preview shown before a consequential delete. */
  function previewDeletePerson(personId) {
    const person = repository.getPerson(personId);
    if (!person) return null;
    return {
      personId,
      displayName: person.displayName,
      voiceProfileCount: person.voiceProfileIds.length,
      relationshipCount: repository.listRelationships({ entityId: personId }).length,
      linkedMemoryCount: person.linkedMemoryIds.length,
      evidenceCount: repository.listEvidenceForPerson(personId).length,
    };
  }

  async function forgetPerson({ personId, deleteLinkedMemories = false }) {
    const person = repository.getPerson(personId);
    if (!person) return { ok: false, errors: [`no person with id ${personId}`] };
    for (const voiceProfileId of person.voiceProfileIds) {
      if (voiceProvider) await voiceProvider.deleteProfile(voiceProfileId);
    }
    const result = repository.deletePerson(personId);
    resolver.invalidateForPerson(personId);
    let deletedMemoryCount = 0;
    if (deleteLinkedMemories && memoryRepository) {
      for (const memoryId of person.linkedMemoryIds) if (memoryRepository.delete(memoryId)) deletedMemoryCount += 1;
    }
    emit({ type: 'identity-person-deleted', personId, ok: result.ok, deletedLinkedMemories: deleteLinkedMemories, deletedMemoryCount });
    return { ...result, deletedMemoryCount };
  }

  /** Explicit voice enrollment. `sample` is a bounded reference + metadata (never raw audio) — see identity/voiceProvider.js. */
  async function enrollVoice({ personId, sample, consent, signal }) {
    if (!voiceProvider) return { ok: false, reasonCode: 'no_voice_provider' };
    const status = voiceProvider.getProviderStatus();
    const result = await voiceProvider.enroll({ personId, audioRef: sample, consent, signal });
    if (result.ok) {
      repository.linkVoiceProfile(personId, result.voiceProfileId);
      repository.addEvidence({ evidenceType: 'voice_enrollment', personId, decision: 'enrolled', provider: result.provider, providerModel: result.providerModel, quality: result.quality, reasonCode: 'explicit_enrollment', sensitivity: 'biometric' });
    }
    emit({ type: 'identity-voice-enrolled', personId, ok: result.ok, voiceProfileId: result.voiceProfileId ?? null, reasonCode: result.reasonCode ?? null, providerMode: status.mode });
    return { ...result, providerMode: status.mode };
  }

  async function removeVoiceProfile({ personId, voiceProfileId }) {
    const providerResult = voiceProvider ? await voiceProvider.deleteProfile(voiceProfileId) : { ok: true, deleted: false };
    const result = repository.unlinkVoiceProfile(personId, voiceProfileId);
    emit({ type: 'identity-voice-profile-removed', personId, voiceProfileId, ok: result.ok && providerResult.ok });
    return { ok: result.ok && providerResult.ok, errors: result.errors ?? [] };
  }

  /** An identical active edge (same type + counterparty, either direction) already exists — repeated evidence strengthens it instead of creating a duplicate. Weak/one-off evidence is NOT auto-inflated: only an actual repeat raises confidence. */
  function findExistingRelationship(fromEntityId, toEntityId, type) {
    return repository
      .listRelationships({ entityId: fromEntityId })
      .find((r) => r.type === type && (r.toEntityId === toEntityId || r.fromEntityId === toEntityId)) ?? null;
  }

  function addRelationship({ fromEntityId, toEntityId, type, label = null, confidence = 0.7, sourceEvidenceIds = [] }) {
    const existing = findExistingRelationship(fromEntityId, toEntityId, type);
    if (existing) {
      const strengthened = Math.min(1, Math.max(existing.confidence, confidence) + 0.05);
      const result = repository.updateRelationship(existing.relationshipId, {
        confidence: strengthened,
        label: label ?? existing.label,
        sourceEvidenceIds: [...new Set([...existing.sourceEvidenceIds, ...sourceEvidenceIds])],
      });
      emit({ type: 'identity-relationship-strengthened', relationshipId: existing.relationshipId, fromEntityId, toEntityId, relType: type, confidence: strengthened, ok: result.ok });
      return result;
    }
    const result = repository.createRelationship({ fromEntityId, toEntityId, type, label, confidence, sourceEvidenceIds });
    if (result.ok) {
      for (const entityId of [fromEntityId, toEntityId]) {
        const person = repository.getPerson(entityId);
        if (person && !person.relationshipIds.includes(result.relationship.relationshipId)) {
          repository.updatePerson(entityId, { relationshipIds: [...person.relationshipIds, result.relationship.relationshipId] });
        }
      }
    }
    emit({ type: 'identity-relationship-added', relationshipId: result.relationship?.relationshipId ?? null, fromEntityId, toEntityId, type, ok: result.ok, errors: result.errors });
    return result;
  }

  /** Correction supersedes the old edge (never silently overwritten/deleted) — same pattern as memory correction. */
  function correctRelationship({ relationshipId, patch }) {
    const old = repository.getRelationship(relationshipId);
    if (!old) return { ok: false, errors: [`no relationship ${relationshipId}`] };
    const created = repository.createRelationship({
      relationshipId: generateRelationshipId(now()),
      fromEntityId: patch.fromEntityId ?? old.fromEntityId,
      toEntityId: patch.toEntityId ?? old.toEntityId,
      type: patch.type ?? old.type,
      label: patch.label ?? old.label,
      confidence: patch.confidence ?? old.confidence,
      sourceEvidenceIds: patch.sourceEvidenceIds ?? old.sourceEvidenceIds,
      supersedes: [relationshipId],
    });
    if (!created.ok) return created;
    repository.supersedeRelationship(relationshipId, created.relationship.relationshipId);
    emit({ type: 'identity-relationship-corrected', oldId: relationshipId, newId: created.relationship.relationshipId, ok: true });
    return { ok: true, relationship: created.relationship };
  }

  function removeRelationship({ relationshipId }) {
    const result = repository.updateRelationship(relationshipId, { status: 'deleted' });
    emit({ type: 'identity-relationship-removed', relationshipId, ok: result.ok });
    return result;
  }

  /** "Show why you resolved that" — provenance for a person, no raw prompts. */
  function showIdentityEvidence(personId) {
    const person = repository.getPerson(personId);
    if (!person) return { found: false };
    return {
      found: true,
      personId,
      displayName: person.displayName,
      identityStatus: person.identityStatus,
      evidence: repository.listEvidenceForPerson(personId).map((e) => ({ evidenceId: e.evidenceId, evidenceType: e.evidenceType, decision: e.decision, confidence: e.confidence, score: e.score, reasonCode: e.reasonCode, createdAt: e.createdAt })),
    };
  }

  function showPersonProfile(personId) {
    const exported = repository.exportPerson(personId);
    if (!exported) return { found: false };
    return { found: true, ...exported, relationships: relationshipsFor(personId, { limit: 50 }) };
  }

  /**
   * Explicit, bounded relinking: for a specific completed interaction, attach
   * `personId` as the speakerEntityId on any memory written from THAT SAME
   * interaction whose speakerId matches `speakerLabel` and has no
   * speakerEntityId yet. Never sweeps unrelated history, never overwrites an
   * existing (possibly different) link — ambiguous cases stay unresolved.
   */
  function relinkMemoriesForInteraction({ interactionId, speakerLabel, personId }) {
    if (!memoryRepository || !interactionId || !personId) return { relinked: [] };
    const candidates = memoryRepository
      .searchStructured({ includeInactive: true })
      .filter((m) => m.source?.interactionId === interactionId && m.source?.speakerId === speakerLabel && !m.speakerEntityId)
      .slice(0, MAX_RELINK_MEMORIES);
    const relinked = [];
    for (const memory of candidates) {
      const updated = memoryRepository.update(memory.memoryId, { speakerEntityId: personId });
      if (updated.ok) { relinked.push(memory.memoryId); repository.linkMemory(personId, memory.memoryId); }
    }
    if (relinked.length) emit({ type: 'identity-memories-relinked', personId, interactionId, memoryIds: relinked });
    return { relinked };
  }

  /**
   * Unlink a deleted memory from any person that referenced it. Kept
   * decoupled from src/memory/ (which never imports identity/): the caller
   * subscribes this to a live memory coordinator's own event bus rather than
   * identity reaching into memory's internals — see attachMemoryLifecycle.
   */
  function handleMemoryDeleted(memoryId) {
    for (const person of repository.listPeople({ includeInactive: true })) {
      if (person.linkedMemoryIds.includes(memoryId)) repository.unlinkMemory(person.personId, memoryId);
    }
  }

  /**
   * Wire "forgetting a memory removes its person link" without either module
   * importing the other's internals. Returns an unsubscribe function.
   * Handles BOTH a single explicit delete (`memory-deleted`) and a bulk
   * `deleteBySource` (`memory-deleted-by-source`, carrying `memoryIds`) —
   * this is the fix for the known gap where a bulk deletion left dangling
   * person<->memory links (see src/memory/coordinator.js's deleteBySource).
   */
  function attachMemoryLifecycle(memoryCoordinator) {
    if (!memoryCoordinator?.subscribe) return () => {};
    return memoryCoordinator.subscribe((event) => {
      if (event.type === 'memory-deleted' && event.memoryId) handleMemoryDeleted(event.memoryId);
      if (event.type === 'memory-deleted-by-source' && Array.isArray(event.memoryIds)) {
        for (const memoryId of event.memoryIds) handleMemoryDeleted(memoryId);
      }
    });
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    resolveSpeakerForTurn,
    identifyCurrentSpeaker: resolveSpeakerForTurn,
    attribute,
    selfIdentify,
    confirmMatch,
    rejectMatch,
    correctIdentity,
    acceptServerVoiceResolution,
    createPerson,
    updatePerson,
    removeAlias,
    mergePeople,
    splitPerson,
    previewDeletePerson,
    forgetPerson,
    enrollVoice,
    removeVoiceProfile,
    addRelationship,
    correctRelationship,
    removeRelationship,
    showIdentityEvidence,
    showPersonProfile,
    relationshipsFor,
    relinkMemoriesForInteraction,
    handleMemoryDeleted,
    attachMemoryLifecycle,
    list: (filters) => repository.listPeople(filters),
    get: (personId) => repository.getPerson(personId),
    listRelationships: (filters) => repository.listRelationships(filters),
    counts() {
      const people = repository.listPeople({ includeInactive: true });
      const byIdentityStatus = {};
      for (const p of people) byIdentityStatus[p.identityStatus] = (byIdentityStatus[p.identityStatus] ?? 0) + 1;
      return { total: people.length, active: people.filter((p) => p.status === 'active').length, byIdentityStatus };
    },
    voiceProviderStatus: () => (voiceProvider ? voiceProvider.getProviderStatus() : { available: false, mode: 'unavailable', provider: null, reason: 'No voice provider configured.' }),
    endSession: (sessionId) => resolver.invalidateSession(sessionId),
    exportAll: () => repository.exportAll(),
    clearAll: () => repository.clearAll(),
    thresholds: RESOLUTION_THRESHOLDS,
  };
}
