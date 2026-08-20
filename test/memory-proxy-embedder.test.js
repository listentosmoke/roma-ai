// The browser-side embedder and the contract it shares with the server model.
//
// These two implementations of `embedMany` briefly disagreed — the provider
// returned `{ vectors, model, ... }` while the proxy returned a bare array —
// and the repository indexed into the object, got undefined, and turned every
// similarity into 0. Nothing threw. The offline tests passed, because they
// used the mock embedder, which had neither shape.
//
// So this file pins the contract itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyEmbedder, createServerEmbedderIfAvailable } from '../src/memory/proxyEmbedder.js';
import { createMockEmbedder, MAX_EMBED_BATCH } from '../src/memory/embeddings.js';
import { createInMemoryRepository } from '../src/memory/repository.js';

const vector = (seed, dimensions = 4) => Array.from({ length: dimensions }, (_, i) => (i === seed % dimensions ? 1 : 0));

function fakePost(calls) {
  return async (path, body) => {
    calls.push({ path, texts: body.texts });
    return { ok: true, vectors: body.texts.map((_, i) => vector(calls.length * 10 + i)), model: 'test-model', dimensions: 4 };
  };
}

function seed(repository, summary) {
  return repository.create({
    type: 'fact', subjectId: 'person_user', predicate: 'p', object: {}, summary,
    confidence: 0.8, importance: 0.5, tags: [], source: { evidenceType: 'user_stated' },
  }).memory;
}

test('embed and embedMany both return BARE vectors, like every other embedder', async () => {
  const calls = [];
  const embedder = createProxyEmbedder({ post: fakePost(calls), model: 'test-model', dimensions: 4 });

  const one = await embedder.embed('hello');
  assert.ok(Array.isArray(one), 'embed returns a vector, not a wrapper');
  assert.equal(one.length, 4);

  const many = await embedder.embedMany(['a', 'b']);
  assert.ok(Array.isArray(many) && Array.isArray(many[0]), 'embedMany returns an array OF vectors');
  assert.equal(many.length, 2);
});

test('the mock embedder satisfies the same contract, so tests cannot drift from production', async () => {
  const mock = createMockEmbedder({ dimensions: 8 });
  const one = await mock.embed('hello');
  assert.ok(Array.isArray(one) && one.length === 8);
  assert.equal(typeof mock.model, 'string');
  assert.equal(typeof mock.dimensions, 'number');
});

test('a pool larger than the server accepts is split, not rejected', async () => {
  const calls = [];
  const embedder = createProxyEmbedder({ post: fakePost(calls), model: 'test-model', dimensions: 4, batchSize: 3 });

  const vectors = await embedder.embedMany(['a', 'b', 'c', 'd', 'e', 'f', 'g']);

  assert.equal(vectors.length, 7);
  assert.deepEqual(calls.map((c) => c.texts.length), [3, 3, 1], 'chunked to the batch size, in order');
});

test('the browser default batch size is a shared constant, not a second guess at the limit', () => {
  assert.equal(typeof MAX_EMBED_BATCH, 'number');
  assert.ok(MAX_EMBED_BATCH > 0);
});

test('a truncated response is an error, never a silently short list of vectors', async () => {
  const embedder = createProxyEmbedder({
    post: async () => ({ vectors: [vector(1)] }), // one vector for two texts
    model: 'test-model',
    dimensions: 4,
  });
  await assert.rejects(() => embedder.embedMany(['a', 'b']), /wrong number of vectors/);
});

test('a proxy embedder cannot be built without the identity of the model behind it', () => {
  // model + dimensions key every cached vector; a nullable one would make the
  // cache look permanently stale and re-embed the world on every turn.
  assert.throws(() => createProxyEmbedder({ post: async () => ({}), model: null, dimensions: 4 }));
  assert.throws(() => createProxyEmbedder({ post: async () => ({}), model: 'm', dimensions: null }));
});

test('no encoder on the server means keyword retrieval, not a broken one', async () => {
  const unavailable = await createServerEmbedderIfAvailable({
    dataClient: { get: async () => ({ available: false }), post: async () => ({}) },
  });
  assert.equal(unavailable, null);

  const unreachable = await createServerEmbedderIfAvailable({
    dataClient: { get: async () => { throw new Error('offline'); }, post: async () => ({}) },
  });
  assert.equal(unreachable, null, 'an unreachable server must not throw into app startup');
});

test('an available encoder is warmed before use, so the first retrieval is not the slow one', async () => {
  const posted = [];
  const embedder = await createServerEmbedderIfAvailable({
    dataClient: {
      get: async () => ({ available: true, model: 'test-model', dimensions: null }),
      post: async (path, body) => {
        posted.push(path);
        return { ok: true, model: 'test-model', dimensions: 384, vectors: (body?.texts ?? []).map(() => vector(0, 384)) };
      },
    },
  });
  assert.ok(embedder);
  assert.equal(embedder.dimensions, 384);
  assert.ok(posted.includes('/api/embeddings/warmup'));
});

test('the repository fills a cold cache in ONE batched call, not one call per memory', async () => {
  const repository = createInMemoryRepository();
  for (const summary of ['alpha one', 'beta two', 'gamma three', 'delta four']) seed(repository, summary);

  let batchCalls = 0;
  let singleCalls = 0;
  const mock = createMockEmbedder({ dimensions: 8 });
  const counting = {
    name: 'counting',
    model: mock.model,
    dimensions: 8,
    async embed(text) { singleCalls += 1; return mock.embed(text); },
    async embedMany(texts) { batchCalls += 1; return Promise.all(texts.map((t) => mock.embed(t))); },
  };

  await repository.searchSemantic({ text: 'alpha', embedder: counting });

  assert.equal(batchCalls, 1, 'four uncached memories, one batch');
  assert.equal(singleCalls, 1, 'plus the query itself');
});

test('a warm cache does not re-embed anything', async () => {
  const repository = createInMemoryRepository();
  seed(repository, 'alpha one');
  const mock = createMockEmbedder({ dimensions: 8 });
  let batchCalls = 0;
  const counting = {
    name: 'counting',
    model: mock.model,
    dimensions: 8,
    embed: (text) => mock.embed(text),
    async embedMany(texts) { batchCalls += 1; return Promise.all(texts.map((t) => mock.embed(t))); },
  };

  await repository.searchSemantic({ text: 'alpha', embedder: counting });
  await repository.searchSemantic({ text: 'alpha again', embedder: counting });

  assert.equal(batchCalls, 1, 'the second search reuses the cached vector');
});

test('swapping the model re-embeds rather than serving vectors that mean something else', async () => {
  const repository = createInMemoryRepository();
  seed(repository, 'alpha one');
  const first = createMockEmbedder({ dimensions: 8 });
  await repository.searchSemantic({ text: 'alpha', embedder: first });

  let reembedded = 0;
  const second = {
    name: 'other',
    model: 'different-model-v2',
    dimensions: 16,
    embed: async () => new Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    async embedMany(texts) {
      reembedded += texts.length;
      return texts.map(() => new Array(16).fill(0).map((_, i) => (i === 1 ? 1 : 0)));
    },
  };
  await repository.searchSemantic({ text: 'alpha', embedder: second });

  assert.equal(reembedded, 1, 'the stored vector came from a different model and cannot be compared');
});
