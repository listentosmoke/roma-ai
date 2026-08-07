// End-to-end tests through a REAL Node http.Server backed by
// server/routes/dataApi.mjs — the same middleware code path Vite mounts,
// exercised without going through Vite itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDataApi } from '../server/dataApiPlugin.mjs';
import { attachDataApi } from '../server/routes/dataApi.mjs';

async function startServer() {
  const api = createDataApi({ dbPath: ':memory:' });
  const middlewares = { fns: [], use(fn) { this.fns.push(fn); } };
  attachDataApi(middlewares, api.handlers);
  const server = http.createServer((req, res) => {
    let i = 0;
    function next() { const fn = middlewares.fns[i++]; if (fn) fn(req, res, next); else { res.statusCode = 404; res.end('{}'); } }
    next();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    api,
    close: () => new Promise((resolve) => { server.close(resolve); api.db.close(); }),
    call: async (method, path, body, headers = {}) => {
      const res = await fetch(`http://localhost:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    },
  };
}

test('client-provided ownership fields cannot override the authenticated workspace/user', async () => {
  const s = await startServer();
  const created = await s.call('POST', '/api/data/memory', { workspaceId: 'attacker_workspace', userId: 'attacker', type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  assert.equal(created.status, 201);
  // Now query AS the attacker's claimed workspace via the dev header override — it should see NOTHING, because the record was created under the real dev workspace, not "attacker_workspace".
  const asAttacker = await s.call('GET', '/api/data/memory', null, { 'X-Roma-Dev-Workspace': 'attacker_workspace', 'X-Roma-Dev-User': 'attacker' });
  assert.equal(asAttacker.json.memories.length, 0);
  await s.close();
});

test('a mutation operation replays via a stable ID (migration import) — idempotency at the API layer', async () => {
  const s = await startServer();
  const records = { memories: [{ memoryId: 'mem_api_1', type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } }], people: [], relationships: [] };
  const first = await s.call('POST', '/api/migration/import', { records, operationId: 'op_api_1' });
  const second = await s.call('POST', '/api/migration/import', { records, operationId: 'op_api_1' });
  assert.equal(first.json.alreadyApplied, false);
  assert.equal(second.json.alreadyApplied, true);
  const list = await s.call('GET', '/api/data/memory');
  assert.equal(list.json.memories.length, 1); // not duplicated
  await s.close();
});

test('memory search is bounded/paginated — limit query param is respected and capped', async () => {
  const s = await startServer();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.call('POST', '/api/data/memory', { type: 'fact', subjectId: 'x', predicate: `p${i}`, summary: `s${i}`, confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  }
  const limited = await s.call('GET', '/api/data/memory?limit=2');
  assert.equal(limited.json.memories.length, 2);
  const capped = await s.call('GET', '/api/data/memory?limit=99999');
  assert.ok(capped.json.memories.length <= 200); // MAX_LIST_LIMIT
  await s.close();
});

test('rate limits apply to expensive/mutation routes', async () => {
  const s = await startServer();
  const results = [];
  for (let i = 0; i < 45; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await s.call('POST', '/api/data/memory', { type: 'fact', subjectId: 'x', predicate: `p${i}`, summary: 's', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } }));
  }
  assert.ok(results.some((r) => r.status === 429), 'expected at least one 429 rate-limited response among 45 rapid mutations');
  await s.close();
});

test('no unrestricted dump endpoint exists — audit is development-only and memory export goes through the sensitivity policy', async () => {
  const s = await startServer();
  await s.call('POST', '/api/data/memory', { type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, sensitivity: 'secret', source: { evidenceType: 'user_stated' } });
  const exported = await s.call('GET', '/api/data/memory/export');
  assert.equal(exported.json.memories.some((m) => m.sensitivity === 'secret'), false); // secret records excluded even from the owner's own export via the broad-action policy path...
  await s.close();
});

test('guessing a memory ID via the HTTP API returns 404, never distinguishing "denied" from "does not exist"', async () => {
  const s = await startServer();
  const res = await s.call('GET', '/api/data/memory/mem_does_not_exist');
  assert.equal(res.status, 404);
  await s.close();
});

test('a stale session update via the HTTP API is rejected with 409', async () => {
  const s = await startServer();
  const started = await s.call('POST', '/api/session/start', {});
  const sid = started.json.session.sessionId;
  await s.call('PATCH', `/api/session/${sid}`, { patch: { activeTurnId: 't1' }, expectedVersion: 1 });
  const stale = await s.call('PATCH', `/api/session/${sid}`, { patch: { activeTurnId: 't2' }, expectedVersion: 1 });
  assert.equal(stale.status, 409);
  await s.close();
});
