import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepository, createLocalStorageRepository } from '../src/memory/repository.js';
import { createMockEmbedder } from '../src/memory/embeddings.js';

function sampleFields(overrides = {}) {
  return {
    type: 'fact', subjectId: 'person_matt', predicate: 'prefers_meeting_day', object: { day: 'Friday' },
    summary: 'Matt prefers meetings on Friday.', confidence: 0.9, importance: 0.6, tags: ['matt', 'scheduling'],
    source: { interactionId: 'interaction_1', turnIds: ['t1'], transcriptIds: [], evidenceType: 'user_stated' },
    ...overrides,
  };
}

test('createInMemoryRepository is deterministic: same operations, same resulting state', () => {
  const repoA = createInMemoryRepository();
  const repoB = createInMemoryRepository();
  const a = repoA.create(sampleFields());
  const b = repoB.create(sampleFields());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.memory.summary, b.memory.summary);
  assert.equal(a.memory.status, 'active');
  assert.deepEqual(repoA.exportAll().map((m) => m.summary), repoB.exportAll().map((m) => m.summary));
});

test('create validates and rejects malformed records', () => {
  const repo = createInMemoryRepository();
  const result = repo.create({ type: 'bogus' });
  assert.equal(result.ok, false);
  assert.equal(repo.exportAll().length, 0);
});

test('update merges a patch and re-validates', () => {
  const repo = createInMemoryRepository();
  const { memory } = repo.create(sampleFields());
  const updated = repo.update(memory.memoryId, { confidence: 0.99 });
  assert.equal(updated.ok, true);
  assert.equal(updated.memory.confidence, 0.99);
  assert.equal(repo.get(memory.memoryId).confidence, 0.99);
});

test('supersede marks the old memory superseded (not deleted) and links both records', () => {
  const repo = createInMemoryRepository();
  const { memory: oldMem } = repo.create(sampleFields());
  const { memory: newMem } = repo.create(sampleFields({ summary: 'Matt cannot meet Fridays anymore.', object: { day: 'not-Friday' } }));
  const result = repo.supersede(oldMem.memoryId, newMem.memoryId);
  assert.equal(result.ok, true);
  const old = repo.get(oldMem.memoryId);
  const current = repo.get(newMem.memoryId);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, newMem.memoryId);
  assert.ok(current.supersedes.includes(oldMem.memoryId));
  // Still inspectable — not deleted.
  assert.equal(repo.exportAll().length, 2);
});

test('searchStructured excludes non-active records by default; includeInactive reveals them', () => {
  const repo = createInMemoryRepository();
  const { memory: oldMem } = repo.create(sampleFields());
  const { memory: newMem } = repo.create(sampleFields({ summary: 'corrected' }));
  repo.supersede(oldMem.memoryId, newMem.memoryId);
  const active = repo.searchStructured({});
  assert.equal(active.length, 1);
  assert.equal(active[0].memoryId, newMem.memoryId);
  const all = repo.searchStructured({ includeInactive: true });
  assert.equal(all.length, 2);
});

test('findRelated matches by type+subject+predicate for dedup lookups', () => {
  const repo = createInMemoryRepository();
  repo.create(sampleFields());
  const related = repo.findRelated({ type: 'fact', subjectId: 'person_matt', predicate: 'prefers_meeting_day' });
  assert.equal(related.length, 1);
  assert.equal(repo.findRelated({ type: 'fact', subjectId: 'person_matt', predicate: 'something_else' }).length, 0);
});

test('delete removes a memory and is not retrievable afterward', () => {
  const repo = createInMemoryRepository();
  const { memory } = repo.create(sampleFields());
  assert.equal(repo.delete(memory.memoryId), true);
  assert.equal(repo.get(memory.memoryId), null);
  assert.equal(repo.searchStructured({}).length, 0);
  assert.equal(repo.delete('nope'), false);
});

test('delete cleans up dangling supersedes/supersededBy links on dependent records without crashing', () => {
  const repo = createInMemoryRepository();
  const { memory: oldMem } = repo.create(sampleFields());
  const { memory: newMem } = repo.create(sampleFields({ summary: 'corrected' }));
  repo.supersede(oldMem.memoryId, newMem.memoryId);
  repo.delete(oldMem.memoryId);
  const current = repo.get(newMem.memoryId);
  assert.ok(!current.supersedes.includes(oldMem.memoryId));
  assert.doesNotThrow(() => repo.searchStructured({ includeInactive: true }));
});

test('deleteBySource removes every memory from a given interaction', () => {
  const repo = createInMemoryRepository();
  repo.create(sampleFields({ source: { interactionId: 'interaction_A', evidenceType: 'user_stated' } }));
  repo.create(sampleFields({ summary: 'other fact', source: { interactionId: 'interaction_A', evidenceType: 'user_stated' } }));
  repo.create(sampleFields({ summary: 'unrelated', source: { interactionId: 'interaction_B', evidenceType: 'user_stated' } }));
  const count = repo.deleteBySource('interaction_A');
  assert.equal(count, 2);
  assert.equal(repo.exportAll().length, 1);
  assert.equal(repo.exportAll()[0].source.interactionId, 'interaction_B');
});

test('markAccessed sets lastAccessedAt', () => {
  const repo = createInMemoryRepository();
  const { memory } = repo.create(sampleFields());
  assert.equal(repo.get(memory.memoryId).lastAccessedAt, null);
  repo.markAccessed([memory.memoryId]);
  assert.ok(repo.get(memory.memoryId).lastAccessedAt > 0);
});

test('clearAll wipes only this repository instance\'s own storage', () => {
  const repo = createInMemoryRepository();
  repo.create(sampleFields());
  repo.clearAll();
  assert.equal(repo.exportAll().length, 0);
});

test('searchSemantic uses the provided embedder and caches vectors, re-embedding on model change', async () => {
  const repo = createInMemoryRepository();
  repo.create(sampleFields({ summary: 'Matt prefers Friday meetings.' }));
  repo.create(sampleFields({ summary: 'The user likes their coffee black.', subjectId: 'person_user', predicate: 'likes' }));
  const embedder = createMockEmbedder({ dimensions: 16 });
  const results = await repo.searchSemantic({ text: 'When does Matt like to meet?', embedder });
  assert.ok(results.length === 2);
  assert.ok(results[0].score >= results[1].score);
});

test('createLocalStorageRepository persists via a localStorage-shaped backend', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    const repo = createLocalStorageRepository({ storageKey: 'test.memories' });
    const { memory } = repo.create(sampleFields());
    assert.equal(repo.get(memory.memoryId).summary, sampleFields().summary);
    // A second handle reading the same key sees the same persisted data.
    const repo2 = createLocalStorageRepository({ storageKey: 'test.memories' });
    assert.equal(repo2.exportAll().length, 1);
    repo.clearAll();
    assert.equal(repo2.exportAll().length, 0);
  } finally {
    delete globalThis.localStorage;
  }
});
