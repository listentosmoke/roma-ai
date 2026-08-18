import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { writeInteraction, applyCandidate, proposeCandidates } from '../src/memory/writer.js';
import { createMockProvider } from '../src/agent/provider.js';

function pkg(overrides = {}) {
  return {
    interactionId: 'interaction_1', turnIds: [1], transcriptIds: ['t1'], speakerId: 'Speaker 0',
    transcriptSegments: [], sceneSnapshot: '', userText: 'hi there', agentResponse: null, toolResults: [],
    completed: true, ...overrides,
  };
}

function candidateResponse(candidates) {
  return { candidates };
}

function commitmentCandidate(overrides = {}) {
  return {
    action: 'store', type: 'commitment', subject_id: 'person_user', predicate: 'send_quote',
    object: [{ name: 'project', value: 'Building 5 HVAC' }, { name: 'recipientName', value: 'Matt' }],
    summary: 'The user agreed to send Matt the Building 5 HVAC quote.', confidence: 0.94, importance: 0.82,
    evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'explicit_user_commitment', tags: ['hvac', 'matt'],
    ...overrides,
  };
}

test('filler conversation produces zero candidates and creates no memory', async () => {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(async () => candidateResponse([]));
  const result = await writeInteraction({ interactionPackage: pkg({ userText: 'hey, how\'s it going' }), repository, provider });
  assert.equal(result.applied.length, 0);
  assert.equal(repository.exportAll().length, 0);
});

test('a user-stated commitment is stored with correct transcript/turn provenance', async () => {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(async () => candidateResponse([commitmentCandidate()]));
  const result = await writeInteraction({
    interactionPackage: pkg({ userText: 'I need to send Matt the Building 5 HVAC quote', turnIds: [7, 8], transcriptIds: ['transcript_40'] }),
    repository, provider,
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action, 'store');
  const stored = repository.exportAll()[0];
  assert.equal(stored.type, 'commitment');
  assert.equal(stored.source.evidenceType, 'user_stated');
  assert.deepEqual(stored.source.turnIds, [7, 8]);
  assert.deepEqual(stored.source.transcriptIds, ['transcript_40']);
  assert.equal(stored.source.interactionId, 'interaction_1');
});

test('Roma\'s own generated content is never stored as user evidence, even if the model proposes it', async () => {
  const repository = createInMemoryRepository();
  const romaClaimCandidate = commitmentCandidate({ evidence_type: 'roma_generated', reason_code: 'agent_offered_to_help' });
  const outcome = applyCandidate(
    { action: 'store', type: 'commitment', subjectId: 'person_user', predicate: 'send_quote', object: {}, summary: 'x', confidence: 0.9, importance: 0.8, evidenceType: 'roma_generated', supersedesMemoryId: null, reasonCode: 'x', tags: [] },
    { repository, interactionPackage: pkg() },
  );
  assert.equal(outcome.action, 'discard');
  assert.equal(outcome.reasonCode, 'roma_generated_not_user_evidence');
  assert.equal(repository.exportAll().length, 0);
  void romaClaimCandidate;
});

test('a preference is stored with correct provenance', async () => {
  const repository = createInMemoryRepository();
  const candidate = {
    action: 'store', type: 'preference', subject_id: 'person_user', predicate: 'prefers_dark_roast',
    object: [], summary: 'The user prefers dark roast coffee.', confidence: 0.85, importance: 0.4,
    evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'explicit_preference', tags: ['coffee'],
  };
  const provider = createMockProvider(async () => candidateResponse([candidate]));
  const result = await writeInteraction({ interactionPackage: pkg({ userText: 'I really prefer dark roast coffee' }), repository, provider });
  assert.equal(result.applied[0].action, 'store');
  assert.equal(repository.exportAll()[0].type, 'preference');
});

test('duplicate facts merge into the existing record instead of multiplying', async () => {
  const repository = createInMemoryRepository();
  const provider1 = createMockProvider(async () => candidateResponse([commitmentCandidate()]));
  await writeInteraction({ interactionPackage: pkg(), repository, provider: provider1 });
  assert.equal(repository.exportAll().length, 1);

  const provider2 = createMockProvider(async () => candidateResponse([commitmentCandidate({ confidence: 0.5, reason_code: 'repeated_mention' })]));
  const result2 = await writeInteraction({ interactionPackage: pkg({ interactionId: 'interaction_2', turnIds: [9] }), repository, provider: provider2 });
  assert.equal(repository.exportAll().length, 1); // still one record
  assert.equal(result2.applied[0].action, 'merge');
});

test('repeated independent evidence raises confidence on the existing memory', async () => {
  const repository = createInMemoryRepository();
  const provider1 = createMockProvider(async () => candidateResponse([commitmentCandidate({ confidence: 0.6 })]));
  await writeInteraction({ interactionPackage: pkg(), repository, provider: provider1 });
  const before = repository.exportAll()[0].confidence;

  const provider2 = createMockProvider(async () => candidateResponse([commitmentCandidate({ confidence: 0.6, reason_code: 'repeated_mention' })]));
  await writeInteraction({ interactionPackage: pkg({ interactionId: 'interaction_2' }), repository, provider: provider2 });
  const after = repository.exportAll()[0].confidence;
  assert.ok(after > before, `expected confidence to rise (${before} -> ${after})`);
});

test('a correction supersedes the prior memory and keeps it inspectable', async () => {
  const repository = createInMemoryRepository();
  const provider1 = createMockProvider(async () => candidateResponse([{
    action: 'store', type: 'fact', subject_id: 'person_matt', predicate: 'prefers_meeting_day', object: [{ name: 'day', value: 'Friday' }],
    summary: 'Matt prefers meetings on Friday.', confidence: 0.9, importance: 0.5, evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'stated', tags: ['matt'],
  }]));
  await writeInteraction({ interactionPackage: pkg({ userText: 'Matt prefers meetings on Friday' }), repository, provider: provider1 });
  const original = repository.exportAll()[0];

  const provider2 = createMockProvider(async () => candidateResponse([{
    action: 'supersede', type: 'fact', subject_id: 'person_matt', predicate: 'prefers_meeting_day', object: [{ name: 'day', value: 'not-Friday' }],
    summary: 'Matt cannot meet Fridays anymore.', confidence: 0.92, importance: 0.5, evidence_type: 'user_corrected', supersedes_memory_id: original.memoryId, reason_code: 'user_correction', tags: ['matt'],
  }]));
  const result2 = await writeInteraction({ interactionPackage: pkg({ interactionId: 'interaction_2', userText: 'actually Matt cannot meet Fridays anymore' }), repository, provider: provider2 });

  assert.equal(result2.applied[0].action, 'supersede');
  const old = repository.get(original.memoryId);
  assert.equal(old.status, 'superseded');
  assert.ok(repository.exportAll().length === 2); // history retained, not deleted
});

test('contradictory unconfirmed (inferred) evidence does not overwrite a confirmed fact', async () => {
  const repository = createInMemoryRepository();
  const { memory: confirmed } = repository.create({
    type: 'fact', subjectId: 'person_matt', predicate: 'prefers_meeting_day', object: { day: 'Friday' },
    summary: 'Matt prefers meetings on Friday.', confidence: 0.95, importance: 0.5,
    source: { evidenceType: 'user_confirmed' },
  });
  const weakCandidate = {
    action: 'supersede', type: 'fact', subjectId: 'person_matt', predicate: 'prefers_meeting_day', object: { day: 'Monday' },
    summary: 'Matt might prefer Mondays.', confidence: 0.3, importance: 0.3, evidenceType: 'inferred',
    supersedesMemoryId: confirmed.memoryId, reasonCode: 'overheard_maybe', tags: [],
  };
  const outcome = applyCandidate(weakCandidate, { repository, interactionPackage: pkg() });
  assert.equal(outcome.action, 'discard');
  assert.equal(outcome.reasonCode, 'insufficient_evidence_to_supersede');
  assert.equal(repository.get(confirmed.memoryId).status, 'active');
});

test('explicit user correction (user_corrected) outranks a prior inferred memory', () => {
  const repository = createInMemoryRepository();
  const { memory: inferred } = repository.create({
    type: 'fact', subjectId: 'person_matt', predicate: 'likes_coffee', object: {},
    summary: 'Matt might like coffee.', confidence: 0.3, importance: 0.2,
    source: { evidenceType: 'inferred' },
  });
  const correction = {
    action: 'supersede', type: 'fact', subjectId: 'person_matt', predicate: 'likes_coffee', object: {},
    summary: 'Matt does not drink coffee.', confidence: 0.95, importance: 0.4, evidenceType: 'user_corrected',
    supersedesMemoryId: inferred.memoryId, reasonCode: 'explicit_correction', tags: [],
  };
  const outcome = applyCandidate(correction, { repository, interactionPackage: pkg() });
  assert.equal(outcome.action, 'supersede');
  assert.equal(repository.get(inferred.memoryId).status, 'superseded');
});

test('low-confidence inference is stored but stays labeled with low confidence, never upgraded silently', async () => {
  const repository = createInMemoryRepository();
  const candidate = {
    action: 'store', type: 'fact', subject_id: 'person_user', predicate: 'works_at', object: [],
    summary: 'The user might work in construction.', confidence: 0.25, importance: 0.3,
    evidence_type: 'inferred', supersedes_memory_id: null, reason_code: 'single_observation', tags: [],
  };
  const provider = createMockProvider(async () => candidateResponse([candidate]));
  await writeInteraction({ interactionPackage: pkg(), repository, provider });
  assert.equal(repository.exportAll()[0].confidence, 0.25);
  assert.equal(repository.exportAll()[0].source.evidenceType, 'inferred');
});

test('a cancelled/incomplete interaction (completed: false) is skipped entirely — no memory is created', async () => {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(async () => candidateResponse([commitmentCandidate()]));
  const result = await writeInteraction({ interactionPackage: pkg({ completed: false }), repository, provider });
  assert.equal(result.skipped, true);
  assert.equal(repository.exportAll().length, 0);
});

test('an AbortSignal is forwarded to the provider (extraction is cancellable)', async () => {
  let sawSignal = false;
  const provider = { infer: async ({ signal }) => { sawSignal = Boolean(signal); return { decisionRaw: candidateResponse([]) }; } };
  const repository = createInMemoryRepository();
  const controller = new AbortController();
  await writeInteraction({ interactionPackage: pkg(), repository, provider, signal: controller.signal });
  assert.equal(sawSignal, true);
});

test('proposeCandidates surfaces validation errors without throwing on malformed model output', async () => {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(async () => ({ candidates: [{ action: 'nonsense' }] }));
  const result = await proposeCandidates({ interactionPackage: pkg(), repository, provider });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.errors.length > 0);
});

test('diarized speaker labels are kept as transient source.speakerId, never auto-promoted into subjectId', async () => {
  const repository = createInMemoryRepository();
  const provider = createMockProvider(async () => candidateResponse([{
    action: 'store', type: 'fact', subject_id: 'person_matt', predicate: 'likes_coffee', object: [],
    summary: 'Matt likes coffee.', confidence: 0.8, importance: 0.3, evidence_type: 'other_speaker_stated',
    supersedes_memory_id: null, reason_code: 'stated_by_other_speaker', tags: [],
  }]));
  await writeInteraction({ interactionPackage: pkg({ speakerId: 'Speaker 1' }), repository, provider });
  const stored = repository.exportAll()[0];
  assert.equal(stored.source.speakerId, 'Speaker 1'); // raw transient diarization label
  assert.equal(stored.subjectId, 'person_matt'); // resolved subject the model proposed — independent field
  assert.notEqual(stored.subjectId, stored.source.speakerId);
});
