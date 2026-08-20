// Persisted memory vectors (migration 0008).
//
// The point of storing them server-side is that a browser should never have to
// re-embed a memory somebody already embedded. So these tests are mostly about
// the two ways that promise can break quietly: a vector that decodes to
// something slightly different from what was stored, and a vector from a
// DIFFERENT model being handed back as though it were comparable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteMemoryRepository } from '../server/repositories/memoryRepository.mjs';
import { createMemoryEmbeddingStore, encodeVector, decodeVector } from '../server/repositories/memoryEmbeddingStore.mjs';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { warmEmbeddingCache } from '../src/memory/proxyEmbedder.js';

const MODEL = 'test/encoder-v1';

function setup() {
  const db = openDatabase({ memory: true });
  const memories = createSqliteMemoryRepository({ db }).forWorkspace('w1', 'u1');
  const store = createMemoryEmbeddingStore({ db }).forWorkspace('w1');
  const seed = (summary) => memories.create({
    type: 'fact', subjectId: 'person_user', predicate: 'p', object: {}, summary,
    confidence: 0.9, importance: 0.5, tags: [], source: { evidenceType: 'user_stated' },
  }).memory;
  return { db, memories, store, seed };
}

const vector = (n, dimensions = 8) => Array.from({ length: dimensions }, (_, i) => Math.sin((i + 1) * n) / 2);

test('a vector survives storage exactly, to float32 precision', () => {
  const original = vector(3, 384);
  const restored = decodeVector(encodeVector(original), 384);
  assert.equal(restored.length, 384);
  const worst = Math.max(...restored.map((v, i) => Math.abs(v - original[i])));
  assert.ok(worst < 1e-6, `worst element delta ${worst}`);
});

test('a vector of the wrong width decodes to nothing rather than to garbage', () => {
  assert.equal(decodeVector(encodeVector(vector(1, 8)), 384), null);
  assert.equal(decodeVector('not base64 at all!!', 8), null);
});

test('vectors round-trip through the database and are scoped to their model', () => {
  const { db, store, seed } = setup();
  const memory = seed('The Q3 report is due on Friday.');
  store.write([{ memoryId: memory.memoryId, vector: vector(2) }], { model: MODEL });

  const read = store.read([memory.memoryId], { model: MODEL });
  assert.equal(read[memory.memoryId].dimensions, 8);
  assert.equal(read[memory.memoryId].model, MODEL);

  const otherModel = store.read([memory.memoryId], { model: 'someone-elses-encoder' });
  assert.deepEqual(otherModel, {}, 'a different encoder shares no space with this one');
  db.close();
});

test('missing() is the backfill queue: active memories with no vector for this model', () => {
  const { db, store, seed } = setup();
  const first = seed('one');
  seed('two');
  assert.equal(store.missing({ model: MODEL }).length, 2);

  store.write([{ memoryId: first.memoryId, vector: vector(1) }], { model: MODEL });
  const pending = store.missing({ model: MODEL });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].summary, 'two', 'the queue carries the text to embed');

  // Vectors from another model do not count as done.
  assert.equal(store.missing({ model: 'other-model' }).length, 2);
  db.close();
});

test('counts report progress honestly', () => {
  const { db, store, seed } = setup();
  const first = seed('one');
  seed('two');
  store.write([{ memoryId: first.memoryId, vector: vector(1) }], { model: MODEL });
  assert.deepEqual(store.counts({ model: MODEL }), { total: 2, embedded: 1, model: MODEL });
  db.close();
});

test('retiring a model drops its vectors instead of leaving numbers nobody can compare', () => {
  const { db, store, seed } = setup();
  const memory = seed('one');
  store.write([{ memoryId: memory.memoryId, vector: vector(1) }], { model: 'old-model' });
  assert.equal(store.counts({ model: 'old-model' }).embedded, 1);

  store.write([{ memoryId: memory.memoryId, vector: vector(2, 16) }], { model: MODEL });
  const purged = store.purgeOtherModels({ model: MODEL });

  assert.equal(store.counts({ model: 'old-model' }).embedded, 0);
  assert.equal(store.counts({ model: MODEL }).embedded, 1, 'the current model keeps its own');
  assert.ok(purged >= 0);
  db.close();
});

test('deleting a memory takes its vector with it', () => {
  const { db, memories, store, seed } = setup();
  const memory = seed('one');
  store.write([{ memoryId: memory.memoryId, vector: vector(1) }], { model: MODEL });
  memories.delete(memory.memoryId);
  assert.deepEqual(store.read([memory.memoryId], { model: MODEL }), {}, 'no orphaned biometric-adjacent data');
  db.close();
});

// ── the browser side of the same promise ──────────────────────────────────

test('a seeded cache means a search embeds only the query', async () => {
  const repository = createInMemoryRepository();
  const stored = {};
  for (const summary of ['one', 'two', 'three']) {
    const memory = repository.create({
      type: 'fact', subjectId: 'person_user', predicate: 'p', object: {}, summary,
      confidence: 0.9, importance: 0.5, tags: [], source: { evidenceType: 'user_stated' },
    }).memory;
    stored[memory.memoryId] = { vector: vector(summary.length), model: MODEL, dimensions: 8 };
  }

  let embedded = 0;
  const embedder = {
    name: 'counting', model: MODEL, dimensions: 8,
    async embed(text) { embedded += 1; return vector(text.length); },
    async embedMany(texts) { embedded += texts.length; return texts.map((t) => vector(t.length)); },
  };

  assert.equal(repository.seedEmbeddings(stored, { embedder }), 3);
  await repository.searchSemantic({ text: 'a question', embedder });
  assert.equal(embedded, 1, 'the query, and nothing else');
});

test('vectors from another model are ignored, not stored as if comparable', () => {
  const repository = createInMemoryRepository();
  const embedder = { name: 'e', model: MODEL, dimensions: 8, embed: async () => vector(1), embedMany: async (t) => t.map(() => vector(1)) };
  const seeded = repository.seedEmbeddings({
    a: { vector: vector(1), model: 'someone-elses-encoder', dimensions: 8 },
    b: { vector: vector(1, 16), model: MODEL, dimensions: 16 },
    c: { vector: vector(1), model: MODEL, dimensions: 8 },
  }, { embedder });
  assert.equal(seeded, 1, 'only the one that matches this encoder AND its width');
  assert.equal(repository.embeddingCacheSize(), 1);
});

test('warming reads what the server has, then asks it to embed the rest', async () => {
  const repository = createInMemoryRepository();
  const memory = repository.create({
    type: 'fact', subjectId: 'person_user', predicate: 'p', object: {}, summary: 'one',
    confidence: 0.9, importance: 0.5, tags: [], source: { evidenceType: 'user_stated' },
  }).memory;
  const embedder = { name: 'e', model: MODEL, dimensions: 8, embed: async () => vector(1), embedMany: async (t) => t.map(() => vector(1)) };

  let backfills = 0;
  const dataClient = {
    get: async () => ({ embeddings: backfills ? { [memory.memoryId]: { vector: vector(1), model: MODEL, dimensions: 8 } } : {} }),
    post: async () => { backfills += 1; return { embedded: backfills === 1 ? 1 : 0, remaining: 0 }; },
  };

  const result = await warmEmbeddingCache({ dataClient, repository, embedder });
  assert.equal(result.embedded, 1);
  assert.equal(result.seeded, 1, 'the freshly embedded vector is read back and cached');
  assert.equal(backfills, 1, 'it stops as soon as nothing remains');
});

test('a server that cannot embed leaves a cold cache, never a thrown startup', async () => {
  const repository = createInMemoryRepository();
  const embedder = { name: 'e', model: MODEL, dimensions: 8, embed: async () => vector(1), embedMany: async (t) => t.map(() => vector(1)) };
  const result = await warmEmbeddingCache({
    dataClient: { get: async () => { throw new Error('offline'); }, post: async () => { throw new Error('offline'); } },
    repository,
    embedder,
  });
  assert.deepEqual(result, { seeded: 0, embedded: 0 });
});
