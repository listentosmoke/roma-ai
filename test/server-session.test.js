import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createSqliteSessionRepository } from '../server/repositories/sessionRepository.mjs';

test('server session updates reject stale versions', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db }).forWorkspace('w1', 'u1');
  const s = repo.start({});
  const first = repo.update(s.sessionId, { activeTurnId: 't1' }, s.version);
  assert.equal(first.ok, true);
  const stale = repo.update(s.sessionId, { activeTurnId: 't2' }, s.version); // still using v1
  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCode, 'stale_version');
  assert.equal(repo.get(s.sessionId).activeTurnId, 't1'); // the stale write never applied
  db.close();
});

test('a late retrieval result cannot overwrite a newer turn (modeled via pendingRetrievalIds + version check)', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db }).forWorkspace('w1', 'u1');
  const s = repo.start({});
  const afterTurn2 = repo.update(s.sessionId, { activeTurnId: 'turn_2', pendingRetrievalIds: ['retrieval_2'] }, s.version);
  // A retrieval kicked off for turn_1 (version 1) resolves late and tries to apply against version 1 — rejected.
  const lateResult = repo.update(s.sessionId, { pendingRetrievalIds: ['retrieval_1_stale_result'] }, 1);
  assert.equal(lateResult.ok, false);
  assert.deepEqual(repo.get(s.sessionId).pendingRetrievalIds, ['retrieval_2']);
  db.close();
});

test('a late memory-write ID cannot attach to the wrong (superseded) interaction state', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db }).forWorkspace('w1', 'u1');
  const s = repo.start({});
  const v2 = repo.update(s.sessionId, { activeInteractionId: 'interaction_2', pendingMemoryWriteIds: ['write_for_interaction_2'] }, s.version);
  assert.equal(v2.ok, true);
  const lateWrite = repo.update(s.sessionId, { pendingMemoryWriteIds: ['write_for_interaction_1_stale'] }, s.version); // stale version again
  assert.equal(lateWrite.ok, false);
  db.close();
});

test('a late identity resolution cannot overwrite a newer manual correction', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db }).forWorkspace('w1', 'u1');
  const s = repo.start({});
  const corrected = repo.update(s.sessionId, { currentResolvedSpeakers: { 'Speaker 1': 'person_jon_corrected' } }, s.version);
  assert.equal(corrected.ok, true);
  const lateIdentityResult = repo.update(s.sessionId, { currentResolvedSpeakers: { 'Speaker 1': 'person_matt_stale' } }, s.version); // still v1, now stale
  assert.equal(lateIdentityResult.ok, false);
  assert.deepEqual(repo.get(s.sessionId).currentResolvedSpeakers, { 'Speaker 1': 'person_jon_corrected' });
  db.close();
});

test('sessions expire and are excluded from normal reads', () => {
  const db = openDatabase({ memory: true });
  let clock = 1_000_000;
  const repo = createSqliteSessionRepository({ db, now: () => clock }).forWorkspace('w1', 'u1');
  const s = repo.start({ ttlMs: 100 });
  clock += 500;
  assert.equal(repo.get(s.sessionId), null);
  const expiredCount = repo.expireStale(clock);
  assert.equal(expiredCount, 1);
  db.close();
});

test('session state is tenant-scoped — another workspace cannot read or update it', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db });
  const s = repo.forWorkspace('w1', 'u1').start({});
  const other = repo.forWorkspace('w2', 'u2');
  assert.equal(other.get(s.sessionId), null);
  const result = other.update(s.sessionId, { activeTurnId: 'x' }, s.version);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'not_found');
  db.close();
});

test('ending a session removes it from normal reads', () => {
  const db = openDatabase({ memory: true });
  const repo = createSqliteSessionRepository({ db }).forWorkspace('w1', 'u1');
  const s = repo.start({});
  assert.equal(repo.end(s.sessionId), true);
  assert.equal(repo.get(s.sessionId), null);
  db.close();
});
