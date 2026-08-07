import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMemory, validateCandidate, validateCandidateResponse, evidenceRank, EVIDENCE_TYPES, MEMORY_TYPES } from '../src/memory/schema.js';

test('validateMemory accepts a well-formed record and normalizes bounds', () => {
  const result = validateMemory({
    memoryId: 'mem_1', type: 'commitment', subjectId: 'person_user', predicate: 'send_quote',
    object: { project: 'Building 5 HVAC', recipientName: 'Matt' }, summary: 'The user agreed to send Matt the quote.',
    confidence: 1.4, importance: -0.2, tags: ['hvac', 'matt'],
    source: { evidenceType: 'user_stated' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.memory.confidence, 1); // clamped
  assert.equal(result.memory.importance, 0); // clamped
  assert.equal(result.memory.status, 'active');
  assert.equal(result.memory.schemaVersion, 1);
  assert.deepEqual(result.memory.tags, ['hvac', 'matt']);
});

test('validateMemory rejects missing required fields without throwing', () => {
  const result = validateMemory({ type: 'fact' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.memory, null);
});

test('validateMemory rejects an unknown type/status/evidenceType', () => {
  assert.equal(validateMemory({ memoryId: 'm', type: 'nonsense', subjectId: 's', predicate: 'p', summary: 'x', source: { evidenceType: 'user_stated' } }).ok, false);
  assert.equal(validateMemory({ memoryId: 'm', type: 'fact', subjectId: 's', predicate: 'p', summary: 'x', status: 'bogus', source: { evidenceType: 'user_stated' } }).ok, false);
  assert.equal(validateMemory({ memoryId: 'm', type: 'fact', subjectId: 's', predicate: 'p', summary: 'x', source: { evidenceType: 'bogus' } }).ok, false);
});

test('validateCandidate clamps confidence/importance and truncates oversized text', () => {
  const longSummary = 'x'.repeat(500);
  const result = validateCandidate({
    action: 'store', type: 'fact', subject_id: 'person_user', predicate: 'likes', object: [{ name: 'thing', value: 'coffee' }],
    summary: longSummary, confidence: 5, importance: -5, evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.confidence, 1);
  assert.equal(result.candidate.importance, 0);
  assert.ok(result.candidate.summary.length <= 300);
  assert.equal(result.candidate.tags.length, 8);
});

test('validateCandidate requires supersedes_memory_id for action "supersede"', () => {
  const result = validateCandidate({
    action: 'supersede', type: 'fact', subject_id: 's', predicate: 'p', object: [], summary: 'x',
    confidence: 0.5, importance: 0.5, evidence_type: 'user_corrected', supersedes_memory_id: null, reason_code: 'r', tags: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(';'), /supersedes_memory_id/);
});

test('validateCandidateResponse never throws on malformed input and bounds the candidate count', () => {
  assert.deepEqual(validateCandidateResponse(null).candidates, []);
  assert.deepEqual(validateCandidateResponse({ candidates: 'nope' }).candidates, []);
  const many = Array.from({ length: 20 }, () => ({
    action: 'discard', type: 'episode', subject_id: 's', predicate: 'p', object: [], summary: 'x',
    confidence: 0.5, importance: 0.5, evidence_type: 'inferred', supersedes_memory_id: null, reason_code: 'r', tags: [],
  }));
  const result = validateCandidateResponse({ candidates: many });
  assert.ok(result.candidates.length <= 8);
});

test('evidenceRank orders authority from roma_generated (lowest) to user_corrected (highest)', () => {
  assert.equal(evidenceRank('roma_generated'), 0);
  assert.ok(evidenceRank('user_corrected') > evidenceRank('user_confirmed'));
  assert.ok(evidenceRank('user_confirmed') > evidenceRank('user_stated'));
  assert.ok(evidenceRank('user_stated') > evidenceRank('inferred'));
  assert.ok(evidenceRank('inferred') > evidenceRank('roma_generated'));
  assert.equal(evidenceRank('unknown_type'), 0);
  assert.equal(EVIDENCE_TYPES.length, 8);
  assert.ok(MEMORY_TYPES.includes('commitment'));
});
