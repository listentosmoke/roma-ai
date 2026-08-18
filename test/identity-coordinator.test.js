import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';
import { createEntityResolver } from '../src/identity/resolver.js';
import { createIdentityCoordinator } from '../src/identity/coordinator.js';
import { createInMemoryRepository as createMemoryRepository } from '../src/memory/repository.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createMockProvider } from '../src/agent/provider.js';

function setup({ memoryRepository = null } = {}) {
  const repository = createInMemoryIdentityRepository();
  const voiceProvider = createDeterministicVoiceProvider();
  const resolver = createEntityResolver({ repository, voiceProvider });
  const coordinator = createIdentityCoordinator({ repository, resolver, voiceProvider, memoryRepository });
  return { repository, voiceProvider, resolver, coordinator };
}

test('aliases can be added and corrected via updatePerson; a rename keeps the old name as an alias', () => {
  const { coordinator, repository } = setup();
  const created = coordinator.createPerson({ displayName: 'Matt' });
  coordinator.updatePerson({ personId: created.person.personId, addAlias: 'Matty' });
  coordinator.updatePerson({ personId: created.person.personId, displayName: 'Matthew Reed' });
  const person = repository.getPerson(created.person.personId);
  assert.equal(person.displayName, 'Matthew Reed');
  assert.ok(person.aliases.some((a) => a.normalizedAlias === 'matty'));
  assert.ok(person.aliases.some((a) => a.normalizedAlias === 'matt')); // old display name preserved as alias
});

test('removeAlias removes only the alias, never the person', () => {
  const { coordinator, repository } = setup();
  const created = coordinator.createPerson({ displayName: 'Matt' });
  coordinator.updatePerson({ personId: created.person.personId, addAlias: 'Matty' });
  coordinator.removeAlias({ personId: created.person.personId, alias: 'Matty' });
  const person = repository.getPerson(created.person.personId);
  assert.equal(person.status, 'active');
  assert.ok(!person.aliases.some((a) => a.normalizedAlias === 'matty'));
});

test('mergePeople invalidates cached resolutions for the merged-away source', async () => {
  const { coordinator, resolver } = setup();
  const target = coordinator.createPerson({ displayName: 'Matt' }).person;
  const source = coordinator.createPerson({ displayName: 'Matthew' }).person;
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matthew' }); // resolves to `source` (already exists)
  const before = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  assert.equal(before.reasonCode, 'session_continuity');

  coordinator.mergePeople({ sourcePersonIds: [source.personId], targetPersonId: target.personId });
  const after = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  assert.notEqual(after.reasonCode, 'session_continuity'); // stale cached resolution invalidated
});

test('splitPerson invalidates cached resolutions for both source and target', async () => {
  const { coordinator, resolver, repository } = setup();
  const combined = coordinator.createPerson({ displayName: 'Matt' }).person;
  resolver.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const result = coordinator.splitPerson({ personId: combined.personId, splitPlan: { newDisplayName: 'Other Matt' } });
  assert.equal(result.ok, true);
  const after = await resolver.resolve({ sessionId: 's1', speakerLabel: 'Speaker 0' });
  assert.notEqual(after.reasonCode, 'session_continuity');
  assert.equal(repository.getPerson(result.target.personId).displayName, 'Other Matt');
});

test('previewDeletePerson returns a bounded impact summary before forgetPerson actually deletes', async () => {
  const { coordinator } = setup();
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'friend' });
  const preview = coordinator.previewDeletePerson(matt.personId);
  assert.equal(preview.relationshipCount, 1);
  await coordinator.forgetPerson({ personId: matt.personId });
  assert.equal(coordinator.get(matt.personId).status, 'deleted');
});

test('forgetPerson never deletes linked memories unless deleteLinkedMemories:true is explicitly passed', async () => {
  const memoryRepository = createMemoryRepository();
  const { coordinator, repository } = setup({ memoryRepository });
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  const { memory } = memoryRepository.create({ type: 'fact', subjectId: matt.personId, predicate: 'likes', summary: 'Matt likes coffee.', source: { evidenceType: 'user_stated' } });
  repository.linkMemory(matt.personId, memory.memoryId);

  await coordinator.forgetPerson({ personId: matt.personId, deleteLinkedMemories: false });
  assert.ok(memoryRepository.get(memory.memoryId));

  const matt2 = coordinator.createPerson({ displayName: 'Jon' }).person;
  const { memory: mem2 } = memoryRepository.create({ type: 'fact', subjectId: matt2.personId, predicate: 'likes', summary: 'Jon likes tea.', source: { evidenceType: 'user_stated' } });
  repository.linkMemory(matt2.personId, mem2.memoryId);
  await coordinator.forgetPerson({ personId: matt2.personId, deleteLinkedMemories: true });
  assert.equal(memoryRepository.get(mem2.memoryId), null);
});

test('relinkMemoriesForInteraction only relinks memories from the SAME interaction whose speakerId matches, never a historical sweep', () => {
  const memoryRepository = createMemoryRepository();
  const { coordinator, repository } = setup({ memoryRepository });
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;

  const { memory: sameInteraction } = memoryRepository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'send_quote', summary: 'Send Matt the quote.', source: { evidenceType: 'user_stated', interactionId: 'interaction_1', speakerId: 'Speaker 1' } });
  const { memory: otherInteraction } = memoryRepository.create({ type: 'fact', subjectId: 'person_user', predicate: 'likes', summary: 'The user likes coffee.', source: { evidenceType: 'user_stated', interactionId: 'interaction_9', speakerId: 'Speaker 1' } });

  const result = coordinator.relinkMemoriesForInteraction({ interactionId: 'interaction_1', speakerLabel: 'Speaker 1', personId: matt.personId });
  assert.deepEqual(result.relinked, [sameInteraction.memoryId]);
  assert.equal(memoryRepository.get(sameInteraction.memoryId).speakerEntityId, matt.personId);
  assert.equal(memoryRepository.get(otherInteraction.memoryId).speakerEntityId, null); // untouched — different interaction
  assert.ok(repository.getPerson(matt.personId).linkedMemoryIds.includes(sameInteraction.memoryId));
});

test('an already-linked (ambiguous) memory is never overwritten by relinking', () => {
  const memoryRepository = createMemoryRepository();
  const { coordinator } = setup({ memoryRepository });
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  const jon = coordinator.createPerson({ displayName: 'Jon' }).person;
  const { memory } = memoryRepository.create({ type: 'fact', subjectId: 'person_user', predicate: 'likes', summary: 'x', source: { evidenceType: 'user_stated', interactionId: 'i1', speakerId: 'Speaker 1' } });
  memoryRepository.update(memory.memoryId, { speakerEntityId: jon.personId });

  coordinator.relinkMemoriesForInteraction({ interactionId: 'i1', speakerLabel: 'Speaker 1', personId: matt.personId });
  assert.equal(memoryRepository.get(memory.memoryId).speakerEntityId, jon.personId); // left unresolved/unchanged, no guessing
});

test('mergePeople relinks memory subjectEntityIds/speakerEntityId/mentionedEntityIds from source to target', () => {
  const memoryRepository = createMemoryRepository();
  const { coordinator, repository } = setup({ memoryRepository });
  const target = coordinator.createPerson({ displayName: 'Matt' }).person;
  const source = coordinator.createPerson({ displayName: 'Matthew' }).person;
  const { memory } = memoryRepository.create({ type: 'fact', subjectId: 'person_user', predicate: 'x', summary: 'x', source: { evidenceType: 'user_stated' }, speakerEntityId: source.personId, mentionedEntityIds: [source.personId] });

  coordinator.mergePeople({ sourcePersonIds: [source.personId], targetPersonId: target.personId });
  const updated = memoryRepository.get(memory.memoryId);
  assert.equal(updated.speakerEntityId, target.personId);
  assert.deepEqual(updated.mentionedEntityIds, [target.personId]);
});

test('addRelationship: repeated evidence for the same edge raises confidence instead of duplicating it; weak one-off evidence is not auto-inflated', () => {
  const { coordinator, repository } = setup();
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  const first = coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'works_with', confidence: 0.6 });
  const second = coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'works_with', confidence: 0.6 });
  assert.equal(second.relationship.relationshipId, first.relationship.relationshipId); // strengthened, not duplicated
  assert.ok(second.relationship.confidence > first.relationship.confidence);
  assert.equal(repository.listRelationships({ entityId: matt.personId }).length, 1);

  const jon = coordinator.createPerson({ displayName: 'Jon' }).person;
  const weak = coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: jon.personId, type: 'knows', confidence: 0.3 });
  assert.equal(weak.relationship.confidence, 0.3); // not inflated by a single weak observation
});

test('correctRelationship supersedes the old edge; superseded edges are excluded from normal retrieval but visible historically', () => {
  const { coordinator, repository } = setup();
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  const added = coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'contractor' });
  const corrected = coordinator.correctRelationship({ relationshipId: added.relationship.relationshipId, patch: { type: 'friend' } });
  assert.equal(corrected.ok, true);
  assert.equal(repository.getRelationship(added.relationship.relationshipId).status, 'superseded');
  const active = repository.listRelationships({ entityId: matt.personId });
  assert.equal(active.length, 1);
  assert.equal(active[0].type, 'friend');
  assert.equal(repository.listRelationships({ entityId: matt.personId, includeInactive: true }).length, 2);
});

test('relationshipsFor respects a bounded limit (token/count budget for context injection)', () => {
  const { coordinator } = setup();
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  for (let i = 0; i < 8; i += 1) coordinator.addRelationship({ fromEntityId: 'person_user', toEntityId: matt.personId, type: 'custom', label: `role_${i}` });
  const relationships = coordinator.relationshipsFor(matt.personId, { limit: 5 });
  assert.ok(relationships.length <= 5);
});

test('attachMemoryLifecycle: forgetting a memory removes its person link, without either module importing the other directly', async () => {
  const memoryRepository = createMemoryRepository();
  const memoryCoordinator = createMemoryCoordinator({ repository: memoryRepository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const { coordinator, repository } = setup({ memoryRepository });
  const matt = coordinator.createPerson({ displayName: 'Matt' }).person;
  const { memory } = memoryRepository.create({ type: 'fact', subjectId: 'person_user', predicate: 'x', summary: 'x', source: { evidenceType: 'user_stated' } });
  repository.linkMemory(matt.personId, memory.memoryId);

  const unsubscribe = coordinator.attachMemoryLifecycle(memoryCoordinator);
  memoryCoordinator.deleteMemory(memory.memoryId);
  assert.ok(!repository.getPerson(matt.personId).linkedMemoryIds.includes(memory.memoryId));
  unsubscribe();
});

test('showIdentityEvidence / showPersonProfile never include raw prompts or hidden reasoning', () => {
  const { coordinator } = setup();
  const matt = coordinator.attribute({ sessionId: 's1', speakerLabel: 'Speaker 0', name: 'Matt' });
  const evidence = coordinator.showIdentityEvidence(matt.personId);
  assert.equal(evidence.found, true);
  assert.ok(!JSON.stringify(evidence).toLowerCase().includes('system prompt'));
  const profile = coordinator.showPersonProfile(matt.personId);
  assert.equal(profile.found, true);
  assert.equal(profile.person.personId, matt.personId);
});

test('counts() summarizes people by identityStatus for the dev panel', () => {
  const { coordinator } = setup();
  coordinator.createPerson({ displayName: 'Matt' });
  coordinator.createPerson({ displayName: 'Jon', identityStatus: 'provisional' });
  const counts = coordinator.counts();
  assert.equal(counts.total, 2);
  assert.equal(counts.byIdentityStatus.confirmed, 1);
  assert.equal(counts.byIdentityStatus.provisional, 1);
});
