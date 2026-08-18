import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthBoundary, createTestAuthBoundary, loadAuthEnv, stripClientOwnership } from '../server/auth.mjs';

function fakeReq(headers = {}) { return { headers }; }

test('development auth resolves the deterministic development principal', async () => {
  const auth = createAuthBoundary({ mode: 'development', devUserId: 'dev_user', devWorkspaceId: 'dev_workspace' });
  const resolved = await auth.resolvePrincipal(fakeReq());
  assert.equal(resolved.ok, true);
  assert.equal(resolved.mode, 'development');
  assert.deepEqual(resolved.principal, { userId: 'dev_user', workspaceId: 'dev_workspace' });
});

test('development auth is clearly labeled (mode field, never silently "production")', () => {
  const auth = createAuthBoundary({ mode: 'development' });
  assert.equal(auth.mode, 'development');
});

test('unauthenticated production requests fail closed when no verifyToken is configured', async () => {
  const auth = createAuthBoundary({ mode: 'production' }); // no verifyToken
  const resolved = await auth.resolvePrincipal(fakeReq());
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reasonCode, 'auth_not_configured');
  assert.equal(resolved.status, 401);
});

test('production requests without a bearer token fail closed', async () => {
  const auth = createAuthBoundary({ mode: 'production', verifyToken: async () => ({ userId: 'u', workspaceId: 'w' }) });
  const resolved = await auth.resolvePrincipal(fakeReq());
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reasonCode, 'missing_token');
});

test('production requests with an invalid token fail closed', async () => {
  const auth = createAuthBoundary({ mode: 'production', verifyToken: async () => null });
  const resolved = await auth.resolvePrincipal(fakeReq({ authorization: 'Bearer bad' }));
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reasonCode, 'invalid_token');
});

test('production requests with a valid token resolve the verified principal', async () => {
  const auth = createAuthBoundary({ mode: 'production', verifyToken: async (token) => (token === 'good' ? { userId: 'u1', workspaceId: 'w1' } : null) });
  const resolved = await auth.resolvePrincipal(fakeReq({ authorization: 'Bearer good' }));
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.principal, { userId: 'u1', workspaceId: 'w1' });
});

test('browser-supplied ownership fields (workspaceId/userId) are stripped before reaching a repository call', () => {
  const stripped = stripClientOwnership({ workspaceId: 'attacker_workspace', userId: 'attacker', summary: 'legit content' });
  assert.equal(stripped.workspaceId, undefined);
  assert.equal(stripped.userId, undefined);
  assert.equal(stripped.summary, 'legit content');
  assert.deepEqual(stripClientOwnership({ workspace_id: 'x', user_id: 'y', a: 1 }), { a: 1 });
});

test('createTestAuthBoundary is a deterministic test utility, distinct from production', () => {
  const auth = createTestAuthBoundary({ userId: 'test_u', workspaceId: 'test_w' });
  assert.equal(auth.mode, 'development');
});

test('loadAuthEnv defaults to development and reads AUTH_MODE=production explicitly', () => {
  assert.equal(loadAuthEnv({ env: {} }).mode, 'development');
  assert.equal(loadAuthEnv({ env: { AUTH_MODE: 'production' } }).mode, 'production');
});
