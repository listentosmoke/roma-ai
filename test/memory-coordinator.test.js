import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createMockProvider } from '../src/agent/provider.js';

function commitmentResponse(overrides = {}) {
  return {
    candidates: [{
      action: 'store', type: 'commitment', subject_id: 'person_user', predicate: 'send_quote',
      object: [{ name: 'project', value: 'Building 5 HVAC' }, { name: 'recipientName', value: 'Matt' }],
      summary: 'The user agreed to send Matt the Building 5 HVAC quote.', confidence: 0.94, importance: 0.82,
      evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'explicit_user_commitment', tags: ['hvac', 'matt'],
      ...overrides,
    }],
  };
}

function makeCoordinator({ decide } = {}) {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(decide ?? (async () => commitmentResponse()));
  return { repository, coordinator: createMemoryCoordinator({ repository, provider }) };
}

test('explicit "remember this" creates a memory', async () => {
  const { repository, coordinator } = makeCoordinator();
  const result = await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote', { interactionId: 'i1', turnId: 1 });
  assert.equal(result.stored, true);
  assert.equal(repository.exportAll().length, 1);
  assert.equal(repository.exportAll()[0].source.extractionMethod, 'explicit_request');
});

test('recall retrieves what was remembered', async () => {
  const { coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  const result = await coordinator.recall('what did I need to send Matt');
  assert.equal(result.memories.length, 1);
  assert.match(result.memories[0].memory.summary, /Matt/);
});

test('an event is emitted for every store/merge/supersede/discard decision', async () => {
  const { coordinator } = makeCoordinator();
  const events = [];
  coordinator.subscribe((e) => events.push(e));
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  assert.ok(events.some((e) => e.type === 'memory-store'));
});

test('forget deletes a unique match', async () => {
  const { repository, coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  const memoryId = repository.exportAll()[0].memoryId;
  const result = await coordinator.forget('the Matt HVAC quote thing');
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.memoryId, memoryId);
  assert.equal(repository.get(memoryId), null);
});

test('ambiguous forget requests return bounded candidates and delete nothing', async () => {
  const { repository, coordinator } = makeCoordinator();
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'send_quote_a', object: {}, summary: 'The user agreed to send Matt a roofing quote.', confidence: 0.8, importance: 0.6, tags: ['matt', 'quote'], source: { evidenceType: 'user_stated' } });
  repository.create({ type: 'commitment', subjectId: 'person_user', predicate: 'send_quote_b', object: {}, summary: 'The user agreed to send Matt an HVAC quote.', confidence: 0.8, importance: 0.6, tags: ['matt', 'quote'], source: { evidenceType: 'user_stated' } });
  const result = await coordinator.forget('the Matt quote');
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.equal(repository.exportAll().length, 2); // nothing deleted
});

test('forget with no match reports not_found', async () => {
  const { coordinator } = makeCoordinator();
  const result = await coordinator.forget('something that was never remembered');
  assert.equal(result.outcome, 'not_found');
});

test('correct supersedes the resolved memory and forces user_corrected evidence', async () => {
  const { repository, coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  const originalId = repository.exportAll()[0].memoryId;

  const correctingCoordinator = createMemoryCoordinator({
    repository,
    provider: createMockProvider(async () => commitmentResponse({ summary: 'The user agreed to send Matt the Building 13 HVAC quote.', reason_code: 'user_correction' })),
  });
  const result = await correctingCoordinator.correct('the Matt HVAC quote', 'Actually it is Building 13, not Building 5');
  assert.equal(result.outcome, 'corrected');
  assert.equal(repository.get(originalId).status, 'superseded');
  const current = repository.searchStructured({}).find((m) => m.memoryId !== originalId);
  assert.equal(current.source.evidenceType, 'user_corrected');
});

test('correct() applies exactly once — it does not also store the model\'s own raw (unforced) proposal', async () => {
  const { repository, coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  assert.equal(repository.exportAll().length, 1);

  const correctingCoordinator = createMemoryCoordinator({
    repository,
    provider: createMockProvider(async () => commitmentResponse({ summary: 'The user agreed to send Matt the Building 13 HVAC quote.', reason_code: 'user_correction' })),
  });
  await correctingCoordinator.correct('the Matt HVAC quote', 'Actually it is Building 13, not Building 5');

  // Exactly 2 total records: the original (now superseded) + ONE corrected
  // active record — not 3 (which would mean the model's own raw candidate got
  // stored once via writeInteraction AND once via the forced re-apply).
  assert.equal(repository.exportAll().length, 2);
  assert.equal(repository.searchStructured({}).length, 1);
});

test('explain shows evidence/provenance and the supersession chain without raw prompts', async () => {
  const { repository, coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  const originalId = repository.exportAll()[0].memoryId;
  const correctingCoordinator = createMemoryCoordinator({ repository, provider: createMockProvider(async () => commitmentResponse({ summary: 'Building 13 now.' })) });
  await correctingCoordinator.correct('Matt HVAC quote', 'Building 13 now, not 5');
  const current = repository.searchStructured({}).find((m) => m.memoryId !== originalId);

  const explanation = coordinator.explain(current.memoryId);
  assert.equal(explanation.found, true);
  assert.equal(explanation.evidenceType, 'user_corrected');
  assert.equal(explanation.supersedes[0].memoryId, originalId);
  assert.ok(!JSON.stringify(explanation).includes('system'));
});

test('explain on an unknown id reports not found, never throws', () => {
  const { coordinator } = makeCoordinator();
  assert.equal(coordinator.explain('mem_nonexistent').found, false);
});

test('deleteMemory / deleteBySource / clearAll work through the coordinator and emit events', async () => {
  const { repository, coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote', { interactionId: 'iX' });
  const id = repository.exportAll()[0].memoryId;
  const events = [];
  coordinator.subscribe((e) => events.push(e));

  assert.equal(coordinator.deleteMemory(id), true);
  assert.ok(events.some((e) => e.type === 'memory-deleted'));

  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote', { interactionId: 'iX' });
  assert.equal(coordinator.deleteBySource('iX'), 1);

  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  coordinator.clearAll();
  assert.equal(repository.exportAll().length, 0);
});

test('counts() summarizes memories by type for the dev panel', async () => {
  const { coordinator } = makeCoordinator();
  await coordinator.remember('remember that I need to send Matt the Building 5 HVAC quote');
  const counts = coordinator.counts();
  assert.equal(counts.total, 1);
  assert.equal(counts.byType.commitment, 1);
});

test('embedderStatus reports honestly when no embedding provider is configured', () => {
  const { coordinator } = makeCoordinator();
  const status = coordinator.embedderStatus();
  assert.equal(status.configured, false);
});

// ── what is about to matter, regardless of the conversation ───────────────

test('upcoming surfaces deadlines by date, not by relevance to the current turn', () => {
  const repository = createInMemoryRepository();
  const coordinator = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const at = Date.parse('2026-08-20T09:00:00');
  const due = (offsetMs, summary, type = 'commitment') => repository.create({
    type, subjectId: 'person_user', predicate: 'p', object: {}, summary,
    confidence: 0.9, importance: 0.6, tags: [], source: { evidenceType: 'user_stated' },
    validUntil: at + offsetMs, createdAt: at, updatedAt: at,
  }).memory;

  due(-2 * 86_400_000, 'Call the surveyor.');
  due(18 * 3_600_000, 'Send Matt the HVAC quote.');
  due(30 * 86_400_000, 'Renew the insurance.');
  repository.create({
    type: 'fact', subjectId: 'person_user', predicate: 'p', object: {}, summary: 'A fact with no deadline.',
    confidence: 0.9, importance: 0.9, tags: [], source: { evidenceType: 'user_stated' }, createdAt: at, updatedAt: at,
  });

  const upcoming = coordinator.upcoming({ at });

  assert.deepEqual(upcoming.map((item) => item.summary), ['Call the surveyor.', 'Send Matt the HVAC quote.']);
  assert.equal(upcoming[0].overdue, true, 'overdue comes first — it is the most actionable');
  assert.equal(upcoming[0].when, '2 days overdue');
  assert.equal(upcoming[1].when, 'in 18 hours');
});

test('a deadline far out is not "coming up" yet', () => {
  const repository = createInMemoryRepository();
  const coordinator = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const at = Date.parse('2026-08-20T09:00:00');
  repository.create({
    type: 'commitment', subjectId: 'person_user', predicate: 'p', object: {}, summary: 'Renew the insurance.',
    confidence: 0.9, importance: 0.6, tags: [], source: { evidenceType: 'user_stated' },
    validUntil: at + 30 * 86_400_000, createdAt: at, updatedAt: at,
  });
  assert.deepEqual(coordinator.upcoming({ at }), []);
  assert.equal(coordinator.upcoming({ at, withinMs: 60 * 86_400_000 }).length, 1, 'until you ask further out');
});

test('a forgotten commitment stops coming up', () => {
  const repository = createInMemoryRepository();
  const coordinator = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const at = Date.parse('2026-08-20T09:00:00');
  const memory = repository.create({
    type: 'commitment', subjectId: 'person_user', predicate: 'p', object: {}, summary: 'Call the surveyor.',
    confidence: 0.9, importance: 0.6, tags: [], source: { evidenceType: 'user_stated' },
    validUntil: at + 3_600_000, createdAt: at, updatedAt: at,
  }).memory;

  assert.equal(coordinator.upcoming({ at }).length, 1);
  repository.delete(memory.memoryId);
  assert.deepEqual(coordinator.upcoming({ at }), []);
});
