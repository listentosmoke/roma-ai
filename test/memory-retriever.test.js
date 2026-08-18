import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { retrieve } from '../src/memory/retriever.js';
import { createMockEmbedder } from '../src/memory/embeddings.js';

function seedCommitment(repository, overrides = {}) {
  return repository.create({
    type: 'commitment', subjectId: 'person_user', predicate: 'send_quote', object: { project: 'Building 5 HVAC', recipientName: 'Matt' },
    summary: 'The user agreed to send Matt the Building 5 HVAC quote.', confidence: 0.9, importance: 0.8,
    tags: ['matt', 'hvac', 'quote'], source: { evidenceType: 'user_stated' }, ...overrides,
  }).memory;
}

test('a relevant commitment is retrieved by keyword match (no embedder configured)', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const result = await retrieve({ repository, query: 'what did I need to send Matt' });
  assert.equal(result.matchType, 'keyword');
  assert.equal(result.memories.length, 1);
  assert.match(result.memories[0].retrievalReason, /keyword_match/);
});

test('irrelevant memories are not returned merely because they exist (no relevance signal at all)', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  repository.create({ type: 'preference', subjectId: 'person_user', predicate: 'likes', object: {}, summary: 'Completely unrelated coffee preference.', confidence: 0.9, importance: 0.9, tags: ['coffee'], source: { evidenceType: 'user_stated' } });
  const result = await retrieve({ repository, query: 'quote for Matt Building 5' });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].memory.predicate, 'send_quote');
});

test('a resolved entity/person id surfaces relevant relationship facts even without keyword overlap', async () => {
  const repository = createInMemoryRepository();
  const relationship = repository.create({
    type: 'relationship', subjectId: 'person_matt', predicate: 'colleague_of', object: { other: 'person_user' },
    summary: 'Matt is a colleague the user works with on HVAC projects.', confidence: 0.8, importance: 0.5,
    tags: [], source: { evidenceType: 'user_stated' },
  }).memory;
  const result = await retrieve({ repository, query: '', entityIds: ['person_matt'] });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].memoryId, relationship.memoryId);
  assert.match(result.memories[0].retrievalReason, /entity_match/);
});

test('superseded memories are excluded from normal retrieval', async () => {
  const repository = createInMemoryRepository();
  const old = seedCommitment(repository);
  const fresh = seedCommitment(repository, { summary: 'The user agreed to send Matt the Building 13 HVAC quote.', object: { project: 'Building 13 HVAC', recipientName: 'Matt' } });
  repository.supersede(old.memoryId, fresh.memoryId);
  const result = await retrieve({ repository, query: 'quote for Matt' });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].memoryId, fresh.memoryId);
});

test('historical retrieval (includeHistorical) can still surface a superseded memory', async () => {
  const repository = createInMemoryRepository();
  const old = seedCommitment(repository);
  const fresh = seedCommitment(repository, { summary: 'The user agreed to send Matt the Building 13 HVAC quote.' });
  repository.supersede(old.memoryId, fresh.memoryId);
  const result = await retrieve({ repository, query: 'quote for Matt', includeHistorical: true });
  assert.equal(result.memories.length, 2);
});

test('a commitment can be retrieved by person AND project keywords', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'call_client', object: { client: 'Acme' }, summary: 'The user needs to call Acme about scheduling.', confidence: 0.8, importance: 0.6, tags: ['acme'], source: { evidenceType: 'user_stated' } });
  const byPerson = await retrieve({ repository, query: 'Matt quote' });
  assert.equal(byPerson.memories.length, 1);
  assert.match(byPerson.memories[0].memory.summary, /Matt/);
  const byProject = await retrieve({ repository, query: 'Building 5 HVAC' });
  assert.equal(byProject.memories.length, 1);
});

test('retrieval respects the maximum result count', async () => {
  const repository = createInMemoryRepository();
  for (let i = 0; i < 20; i += 1) {
    repository.create({ type: 'fact', subjectId: 'person_user', predicate: `fact_${i}`, object: {}, summary: `The user mentioned quote number ${i}.`, confidence: 0.7, importance: 0.5, tags: ['quote'], source: { evidenceType: 'user_stated' } });
  }
  const result = await retrieve({ repository, query: 'quote', maximumMemories: 3 });
  assert.equal(result.memories.length, 3);
});

test('retrieval respects the token budget even under the max result count', async () => {
  const repository = createInMemoryRepository();
  for (let i = 0; i < 5; i += 1) {
    repository.create({ type: 'fact', subjectId: 'person_user', predicate: `fact_${i}`, object: {}, summary: `quote ${'x'.repeat(300)} ${i}`, confidence: 0.7, importance: 0.5, tags: ['quote'], source: { evidenceType: 'user_stated' } });
  }
  const result = await retrieve({ repository, query: 'quote', maximumMemories: 10, tokenBudget: 50 });
  assert.ok(result.memories.length < 5);
});

test('a low-confidence inferred memory keeps its low confidence value when retrieved (never presented as confirmed)', async () => {
  const repository = createInMemoryRepository();
  repository.create({ type: 'fact', subjectId: 'person_user', predicate: 'works_at', object: {}, summary: 'The user might work in construction, quote unclear.', confidence: 0.2, importance: 0.3, tags: [], source: { evidenceType: 'inferred' } });
  const result = await retrieve({ repository, query: 'construction quote work' });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].confidence, 0.2);
});

test('with no embedding provider configured, retrieval falls back to keyword search safely (never silently claims semantic)', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const result = await retrieve({ repository, query: 'Matt quote', embedder: null });
  assert.equal(result.matchType, 'keyword');
});

test('with a real embedder configured, semantic search is used and labeled as such', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const result = await retrieve({ repository, query: 'Matt quote', embedder: createMockEmbedder() });
  assert.equal(result.matchType, 'semantic');
});

test('no query and no structured signals returns matchType "none" with an empty result (no memory section injected)', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const result = await retrieve({ repository, query: '' });
  assert.equal(result.memories.length, 0);
  assert.equal(result.matchType, 'none');
});

test('a deleted memory is never retrieved', async () => {
  const repository = createInMemoryRepository();
  const memory = seedCommitment(repository);
  repository.delete(memory.memoryId);
  const result = await retrieve({ repository, query: 'Matt quote' });
  assert.equal(result.memories.length, 0);
});

test('retrieved memories are marked accessed (feeds "already used recently" de-prioritization)', async () => {
  const repository = createInMemoryRepository();
  const memory = seedCommitment(repository);
  await retrieve({ repository, query: 'Matt quote' });
  assert.ok(repository.get(memory.memoryId).lastAccessedAt > 0);
});

test('late retrieval from a stale/superseded turn is discarded via isStillCurrent()', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const result = await retrieve({ repository, query: 'Matt quote', isStillCurrent: () => false });
  assert.equal(result.aborted, true);
  assert.equal(result.memories.length, 0);
});

test('an already-aborted signal discards the retrieval result', async () => {
  const repository = createInMemoryRepository();
  seedCommitment(repository);
  const controller = new AbortController();
  controller.abort();
  const result = await retrieve({ repository, query: 'Matt quote', signal: controller.signal });
  assert.equal(result.aborted, true);
});
