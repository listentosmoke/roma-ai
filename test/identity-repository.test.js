import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryIdentityRepository, createLocalStorageIdentityRepository } from '../src/identity/repository.js';

function makePerson(repo, displayName = 'Matt', overrides = {}) {
  return repo.createPerson({ displayName, identityStatus: 'confirmed', ...overrides }).person;
}

test('a new person can be created with a stable ID', () => {
  const repo = createInMemoryIdentityRepository();
  const { ok, person } = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
  assert.equal(ok, true);
  assert.match(person.personId, /^person_/);
  assert.equal(repo.getPerson(person.personId).displayName, 'Matt');
});

test('findByName / findByAlias are case-insensitive exact matches; findCandidates is bounded substring search', () => {
  const repo = createInMemoryIdentityRepository();
  makePerson(repo, 'Matt', { aliases: [{ alias: 'Matthew', type: 'name' }] });
  assert.equal(repo.findByName('matt').length, 1);
  assert.equal(repo.findByName('MATTHEW').length, 1);
  assert.equal(repo.findByAlias('matthew').length, 1);
  assert.equal(repo.findByName('nobody').length, 0);
  assert.equal(repo.findCandidates({ query: 'att' }).length, 1);
});

test('two people can share the same display name and remain separate records', () => {
  const repo = createInMemoryIdentityRepository();
  const a = makePerson(repo, 'Matt');
  const b = makePerson(repo, 'Matt');
  assert.notEqual(a.personId, b.personId);
  assert.equal(repo.findByName('Matt').length, 2);
});

test('addEvidence validates, stores, and links sourceEvidenceIds onto the person', () => {
  const repo = createInMemoryIdentityRepository();
  const person = makePerson(repo);
  const { ok, evidence } = repo.addEvidence({ evidenceType: 'explicit_user_attribution', personId: person.personId, decision: 'resolved' });
  assert.equal(ok, true);
  assert.equal(repo.getEvidence(evidence.evidenceId).evidenceType, 'explicit_user_attribution');
  assert.ok(repo.getPerson(person.personId).sourceEvidenceIds.includes(evidence.evidenceId));
  assert.equal(repo.listEvidenceForPerson(person.personId).length, 1);
});

test('linkVoiceProfile / unlinkVoiceProfile and linkMemory / unlinkMemory round-trip', () => {
  const repo = createInMemoryIdentityRepository();
  const person = makePerson(repo);
  repo.linkVoiceProfile(person.personId, 'voice_profile_1');
  assert.deepEqual(repo.getPerson(person.personId).voiceProfileIds, ['voice_profile_1']);
  repo.unlinkVoiceProfile(person.personId, 'voice_profile_1');
  assert.deepEqual(repo.getPerson(person.personId).voiceProfileIds, []);
  repo.linkMemory(person.personId, 'mem_1');
  assert.deepEqual(repo.getPerson(person.personId).linkedMemoryIds, ['mem_1']);
  repo.unlinkMemory(person.personId, 'mem_1');
  assert.deepEqual(repo.getPerson(person.personId).linkedMemoryIds, []);
});

test('mergePeople preserves aliases, evidence, voice profiles, and memory links under the target', () => {
  const repo = createInMemoryIdentityRepository();
  const target = makePerson(repo, 'Matt');
  const source = makePerson(repo, 'Matthew', { aliases: [{ alias: 'Matty', type: 'nickname' }] });
  repo.linkVoiceProfile(source.personId, 'voice_profile_9');
  repo.linkMemory(source.personId, 'mem_5');
  const ev = repo.addEvidence({ evidenceType: 'explicit_user_attribution', personId: source.personId, decision: 'resolved' });

  const result = repo.mergePeople([source.personId], target.personId);
  assert.equal(result.ok, true);
  const merged = repo.getPerson(target.personId);
  assert.ok(merged.aliases.some((a) => a.normalizedAlias === 'matty'));
  assert.ok(merged.voiceProfileIds.includes('voice_profile_9'));
  assert.ok(merged.linkedMemoryIds.includes('mem_5'));
  assert.ok(merged.supersedes.includes(source.personId));

  const sourceAfter = repo.getPerson(source.personId);
  assert.equal(sourceAfter.status, 'merged');
  assert.equal(sourceAfter.identityStatus, 'merged');
  assert.equal(sourceAfter.mergedInto, target.personId);

  // Merge history remains inspectable: evidence recorded under the source is
  // still visible when querying evidence FOR the target (merge-chain traversal).
  const targetEvidence = repo.listEvidenceForPerson(target.personId);
  assert.ok(targetEvidence.some((e) => e.evidenceId === ev.evidence.evidenceId));
});

test('mergePeople avoids duplicating an equivalent relationship edge (leaves the source edge as historical)', () => {
  const repo = createInMemoryIdentityRepository();
  const target = makePerson(repo, 'Matt');
  const source = makePerson(repo, 'Matthew');
  repo.createRelationship({ fromEntityId: 'person_user', toEntityId: target.personId, type: 'works_with' });
  const sourceRel = repo.createRelationship({ fromEntityId: 'person_user', toEntityId: source.personId, type: 'works_with' });

  const result = repo.mergePeople([source.personId], target.personId);
  assert.equal(result.ok, true);
  assert.ok(result.conflicts.includes(sourceRel.relationship.relationshipId));
  const activeEdges = repo.listRelationships({ entityId: target.personId }).filter((r) => r.type === 'works_with');
  assert.equal(activeEdges.length, 1); // not duplicated
});

test('splitPerson moves only the explicitly-named alias/voice/memory items; everything else stays on the source', () => {
  const repo = createInMemoryIdentityRepository();
  const combined = makePerson(repo, 'Matt', { aliases: [{ alias: 'Matty', type: 'nickname' }, { alias: 'Big Matt', type: 'nickname' }] });
  repo.linkVoiceProfile(combined.personId, 'voice_profile_a');
  repo.linkVoiceProfile(combined.personId, 'voice_profile_b');
  repo.linkMemory(combined.personId, 'mem_keep');
  repo.linkMemory(combined.personId, 'mem_move');

  const result = repo.splitPerson(combined.personId, { newDisplayName: 'Other Matt', aliasTexts: ['big matt'], voiceProfileIds: ['voice_profile_b'], memoryIds: ['mem_move'] });
  assert.equal(result.ok, true);
  const source = repo.getPerson(combined.personId);
  const target = repo.getPerson(result.target.personId);

  assert.ok(source.aliases.some((a) => a.normalizedAlias === 'matty'));
  assert.ok(!source.aliases.some((a) => a.normalizedAlias === 'big matt'));
  assert.ok(target.aliases.some((a) => a.normalizedAlias === 'big matt'));

  assert.deepEqual(source.voiceProfileIds, ['voice_profile_a']);
  assert.deepEqual(target.voiceProfileIds, ['voice_profile_b']);

  assert.deepEqual(source.linkedMemoryIds, ['mem_keep']);
  assert.deepEqual(target.linkedMemoryIds, ['mem_move']);
});

test('deletePerson soft-deletes (status:deleted) and never cascades to other people or relationships', () => {
  const repo = createInMemoryIdentityRepository();
  const a = makePerson(repo, 'Matt');
  const b = makePerson(repo, 'Jon');
  repo.createRelationship({ fromEntityId: 'person_user', toEntityId: a.personId, type: 'friend' });
  repo.deletePerson(a.personId);
  assert.equal(repo.getPerson(a.personId).status, 'deleted');
  assert.equal(repo.getPerson(b.personId).status, 'active'); // unaffected
  assert.equal(repo.listRelationships({ entityId: a.personId }).length, 1); // relationship not cascaded away
});

test('relationship supersede marks the old edge superseded and links the new one; supersede excluded from default retrieval', () => {
  const repo = createInMemoryIdentityRepository();
  const a = makePerson(repo, 'Matt');
  const oldRel = repo.createRelationship({ fromEntityId: 'person_user', toEntityId: a.personId, type: 'contractor' }).relationship;
  const newRel = repo.createRelationship({ fromEntityId: 'person_user', toEntityId: a.personId, type: 'friend', supersedes: [oldRel.relationshipId] }).relationship;
  repo.supersedeRelationship(oldRel.relationshipId, newRel.relationshipId);

  assert.equal(repo.getRelationship(oldRel.relationshipId).status, 'superseded');
  const active = repo.listRelationships({ entityId: a.personId });
  assert.equal(active.length, 1);
  assert.equal(active[0].relationshipId, newRel.relationshipId);
  const historical = repo.listRelationships({ entityId: a.personId, includeInactive: true });
  assert.equal(historical.length, 2);
});

test('createLocalStorageIdentityRepository persists person metadata via a localStorage-shaped backend, and never writes raw sample/matchKey data', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    const repo = createLocalStorageIdentityRepository({ storageKey: 'test.people' });
    const { person } = repo.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
    repo.linkVoiceProfile(person.personId, 'voice_profile_123');
    const repo2 = createLocalStorageIdentityRepository({ storageKey: 'test.people' });
    assert.equal(repo2.exportAll().people.length, 1);

    // Every byte written to localStorage is inspected: only opaque IDs/metadata, never audio/matchKey/embedding-shaped data.
    for (const value of store.values()) {
      assert.ok(!/matchKey|audioRef|embedding|voiceprint/i.test(value));
    }
    repo.clearAll();
    assert.equal(repo2.exportAll().people.length, 0);
  } finally {
    delete globalThis.localStorage;
  }
});
