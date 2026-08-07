// Provider-independent authentication boundary for the data API.
//
// There is no production identity provider in this repository today (no
// login flow, no session cookies, no OAuth). Per this phase's own
// contingency plan, this module ships:
//
//   - A deterministic DEVELOPMENT principal (clearly labeled, never silently
//     presented as production auth).
//   - A pluggable `verifyToken` hook for a REAL production verifier to be
//     wired in later (e.g. a JWT/session-cookie check against a real IdP).
//   - Explicit FAIL-CLOSED behavior: with `AUTH_MODE=production` and no
//     `verifyToken` configured, every data-API request is rejected with
//     401 `auth_not_configured` — the server never falls back to the
//     development principal in production mode.
//
// Every data-API route resolves the principal HERE, once, from the request
// itself (header) — never from the JSON body. Route handlers must not read
// `workspaceId`/`userId` out of a request body for ownership purposes; the
// authenticated `principal` from `resolvePrincipal()` is the only source of
// truth (enforced by server/routes/dataApi.mjs stripping those fields before
// they reach a repository call — see stripClientOwnership()).

const DEV_HEADER_USER = 'x-roma-dev-user';
const DEV_HEADER_WORKSPACE = 'x-roma-dev-workspace';

export function loadAuthEnv({ env = process.env } = {}) {
  const mode = env.AUTH_MODE === 'production' ? 'production' : 'development';
  return {
    mode,
    devUserId: env.DEV_PRINCIPAL_USER_ID || 'dev_user',
    devWorkspaceId: env.DEV_PRINCIPAL_WORKSPACE_ID || 'dev_workspace',
  };
}

/**
 * @param {{ mode: 'development'|'production', devUserId?: string, devWorkspaceId?: string, verifyToken?: (token: string) => Promise<{userId:string, workspaceId:string}|null> }} options
 */
export function createAuthBoundary({ mode, devUserId = 'dev_user', devWorkspaceId = 'dev_workspace', verifyToken = null } = {}) {
  /** @returns {{ ok: true, principal: {userId, workspaceId}, mode }|{ ok:false, status:number, reasonCode:string, mode }} */
  async function resolvePrincipal(req) {
    if (mode === 'development') {
      // Header override lets tests/dev tooling simulate a SECOND tenant
      // without a real auth system — still clearly a development identity,
      // never accepted when mode === 'production'.
      const userId = req.headers?.[DEV_HEADER_USER] || devUserId;
      const workspaceId = req.headers?.[DEV_HEADER_WORKSPACE] || devWorkspaceId;
      return { ok: true, principal: { userId: String(userId), workspaceId: String(workspaceId) }, mode: 'development' };
    }

    // production
    if (!verifyToken) {
      return { ok: false, status: 401, reasonCode: 'auth_not_configured', mode: 'production' };
    }
    const authHeader = req.headers?.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) return { ok: false, status: 401, reasonCode: 'missing_token', mode: 'production' };
    let principal;
    try {
      principal = await verifyToken(match[1]);
    } catch {
      return { ok: false, status: 401, reasonCode: 'invalid_token', mode: 'production' };
    }
    if (!principal?.userId || !principal?.workspaceId) return { ok: false, status: 401, reasonCode: 'invalid_token', mode: 'production' };
    return { ok: true, principal: { userId: String(principal.userId), workspaceId: String(principal.workspaceId) }, mode: 'production' };
  }

  return { mode, resolvePrincipal };
}

/** Strip any client-supplied ownership fields before they ever reach a repository call — the authenticated principal is the only source of workspaceId/userId. */
export function stripClientOwnership(body) {
  if (!body || typeof body !== 'object') return body;
  const { workspaceId: _w, userId: _u, workspace_id: _w2, user_id: _u2, ...rest } = body;
  return rest;
}

/** Deterministic test utility — never used by production code paths. */
export function createTestAuthBoundary({ userId = 'test_user', workspaceId = 'test_workspace' } = {}) {
  return createAuthBoundary({ mode: 'development', devUserId: userId, devWorkspaceId: workspaceId });
}
