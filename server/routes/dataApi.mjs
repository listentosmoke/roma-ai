// Authenticated data API — the server boundary for durable memory/identity
// state (see SERVER-DATA.md "Architecture"). Every route:
//   1. resolves the principal via server/auth.mjs (never trusts a
//      client-supplied workspaceId/userId — see stripClientOwnership()),
//   2. runs the sensitivity policy engine (src/policy/sensitivity.js) before
//      any content leaves the server,
//   3. audits consequential outcomes via server/repositories/auditRepository.mjs.
//
// No route exposes raw SQL/query-language, an unrestricted dump, or
// arbitrary browser-supplied filtering beyond the bounded fields listed per
// route below. All responses are capped (MAX_LIST_LIMIT) and paginated where
// it matters.

import { stripClientOwnership } from '../auth.mjs';
import { evaluatePolicy, filterBySensitivity } from '../../src/policy/sensitivity.js';
import { runRetentionCleanup } from '../repositories/retention.mjs';
import { planWorkspaceDeletion, deleteWorkspace } from '../repositories/deletion.mjs';
import { planMigration, applyMigration } from '../migration/localStorageImport.mjs';
import { createOperationLedger } from '../repositories/operationLedger.mjs';
import { currentSchemaVersion } from '../db/index.mjs';
import { loadServerEnv } from '../env.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

// ── tiny shared http helpers (deliberately NOT imported from groqApi.js —
// that module is left untouched; duplicating ~15 lines here is cheaper than
// risking a working, already-tested module) ─────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Request body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
function parseUrl(req) {
  const url = new URL(req.url, 'http://internal');
  return { pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()) };
}
function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

// ── bounded rate limiting (per-principal, per-route-group, sliding window) ──
// Simple in-process counter — sufficient for a single local dev/preview
// server process; a real multi-instance deployment would need a shared
// store, documented in SERVER-DATA.md "Rate limiting".
function createRateLimiter({ windowMs = 10_000, max = 60 } = {}) {
  const hits = new Map();
  return function checkLimit(key) {
    const now = Date.now();
    const bucket = hits.get(key) ?? [];
    const recent = bucket.filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

function relevanceFromContext({ query, subjectId, entityIds = [] }) {
  // A bounded, deterministic relevance signal for the server-side policy
  // pass — NOT the full keyword/semantic scoring the client-side Memory
  // Retriever already does (that stays untouched, see MEMORY.md). This only
  // decides whether a private/sensitive record is even worth sending to the
  // client at all; the client's own retriever + a second client-side policy
  // pass (src/agent/runtime.js's applyPolicyFilter) narrows it further
  // immediately before Context Compiler assembly.
  if (subjectId && entityIds.includes(subjectId)) return 1;
  if (query) return 0.7;
  return 0.3;
}

export function createDataApiHandlers({ db, repositories, auth, voiceIdentity = null, now = Date.now }) {
  const { memoryRepository, identityRepository, auditRepository, consentRepository, sessionRepository } = repositories;
  const limiter = createRateLimiter({ windowMs: 10_000, max: 120 });
  const mutationLimiter = createRateLimiter({ windowMs: 10_000, max: 40 });
  const biometricLimiter = createRateLimiter({ windowMs: 60_000, max: 12 });
  const ledger = createOperationLedger({ db, now });

  /**
   * Idempotent replay for data mutations. A request carrying an
   * X-Roma-Operation-Id header whose (operationId, workspaceId) pair is
   * already in the operation ledger gets the ORIGINAL recorded response back
   * (flagged `replayedOperation: true`) instead of re-executing — duplicate
   * retries from the client mutation queue therefore create exactly one
   * record. The ledger is tenant-scoped (composite primary key, migration
   * 0003), so the same operationId presented by another workspace is a
   * different ledger entry: it can neither read nor overwrite the first
   * tenant's result. Auth failures, rate limits (429), and 5xx are never
   * recorded — those must re-execute on retry. Biometric /api/voice routes
   * are deliberately NOT wrapped: a cached "enrolled" response replayed
   * after consent revocation would fake a biometric success, so those
   * operations always re-execute against live consent state.
   */
  function withIdempotentReplay(handler, action) {
    return async (req, res, params) => {
      const header = req.headers['x-roma-operation-id'];
      const operationId = typeof header === 'string' ? header.slice(0, 128) : '';
      if (!operationId) { await handler(req, res, params); return; }
      const resolved = await auth.resolvePrincipal(req);
      if (!resolved.ok) { await handler(req, res, params); return; } // the handler produces its own 401/failed-closed response
      const workspaceId = resolved.principal.workspaceId;
      const prior = ledger.check(workspaceId, operationId);
      if (prior.done && prior.result && typeof prior.result.status === 'number') {
        sendJson(res, prior.result.status, { ...(prior.result.body ?? {}), replayedOperation: true });
        return;
      }
      const shim = {
        statusCode: 200,
        setHeader: (name, value) => res.setHeader(name, value),
        end(payload) {
          const status = shim.statusCode;
          if (status < 500 && status !== 401 && status !== 403 && status !== 429) {
            let body = null;
            try { body = payload ? JSON.parse(payload) : null; } catch { body = null; }
            ledger.record(workspaceId, operationId, action, { status, body });
          }
          res.statusCode = status;
          res.end(payload);
        },
      };
      await handler(req, shim, params);
    };
  }

  /** True when `resourceId` was hard- or soft-deleted in this workspace — used to refuse resurrection by a delayed/replayed create (deterministic 409 record_deleted). */
  function hasTombstone(workspaceId, resourceType, resourceId) {
    if (!resourceId) return false;
    return Boolean(db.prepare('SELECT 1 FROM tombstones WHERE workspace_id = ? AND resource_type = ? AND resource_id = ? LIMIT 1').get(workspaceId, resourceType, resourceId));
  }

  async function withPrincipal(req, res) {
    const resolved = await auth.resolvePrincipal(req);
    if (!resolved.ok) { sendJson(res, resolved.status ?? 401, { error: 'Unauthorized.', code: resolved.reasonCode, mode: resolved.mode }); return null; }
    if (!limiter(resolved.principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return null; }
    const operationHeader = req.headers['x-roma-operation-id'];
    return { ...resolved.principal, operationId: typeof operationHeader === 'string' ? operationHeader.slice(0, 128) : null };
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
  }

  async function withBiometricPrincipal(req, res) {
    const principal = await withPrincipal(req, res);
    if (!principal) return null;
    if (auth.mode === 'development' && !isLoopback(req)) {
      sendJson(res, 403, { error: 'Development biometric operations are restricted to the local machine.', code: 'biometric_loopback_only' });
      return null;
    }
    if (!biometricLimiter(`${principal.userId}:${principal.workspaceId}`)) {
      sendJson(res, 429, { error: 'Voice-identity rate limit exceeded.', code: 'rate_limited' });
      return null;
    }
    return principal;
  }

  function audit(principal, fields) {
    // operationId: the client mutation queue's stable idempotency key, when
    // one was sent — an explicit fields.operationId (migration, workspace
    // deletion) still wins via the spread.
    auditRepository.forWorkspace(principal.workspaceId).record({ principalId: principal.userId, operationId: principal.operationId ?? null, ...fields });
  }

  function policyGate(res, action, resource, principal, context) {
    const decision = evaluatePolicy({ action, resource, principal, context });
    if (decision.decision === 'deny') {
      audit(principal, { action, resourceType: resource.resourceType, resourceId: resource.resourceId, outcome: 'denied', reasonCode: decision.reasonCode, sensitivity: resource.sensitivity, policyDecisionId: null });
      sendJson(res, resource.resourceId ? 404 : 403, { error: 'Not found.', code: decision.reasonCode }); // 404 (not 403) on a specific resource so guessing an ID never confirms existence
      return null;
    }
    if (decision.decision === 'unavailable') { sendJson(res, 404, { error: 'Not found.', code: decision.reasonCode }); return null; }
    if (decision.decision === 'require_confirmation') { sendJson(res, 409, { error: 'Confirmation required.', code: decision.reasonCode, decision }); return null; }
    if (decision.decision === 'require_recent_authentication') { sendJson(res, 401, { error: 'Recent authentication required.', code: decision.reasonCode }); return null; }
    return decision;
  }

  const handlers = {
    async health(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      sendJson(res, 200, { ok: true, dbAvailable: true, authMode: auth.mode, principal: auth.mode === 'development' ? principal : { userId: '(redacted)', workspaceId: principal.workspaceId } });
    },

    // ── memory ──────────────────────────────────────────────────────────
    async memoryCreate(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      if (!mutationLimiter(principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return; }
      const raw = stripClientOwnership(await readJsonBody(req));
      const gate = policyGate(res, 'memory.create', { resourceType: 'memory', sensitivity: raw.sensitivity ?? 'normal', workspaceId: principal.workspaceId }, principal, {});
      if (!gate) return;
      if (hasTombstone(principal.workspaceId, 'memory', raw.memoryId)) {
        // A delayed or replayed create must never resurrect a deleted record.
        audit(principal, { action: 'memory.create', resourceType: 'memory', resourceId: raw.memoryId, outcome: 'denied', reasonCode: 'record_deleted' });
        sendJson(res, 409, { ok: false, error: 'This record was deleted and cannot be recreated.', code: 'record_deleted' });
        return;
      }
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.create(raw);
      if (result.ok) audit(principal, { action: 'memory.create', resourceType: 'memory', resourceId: result.memory.memoryId, outcome: 'created', sensitivity: result.memory.sensitivity, policyDecisionId: gate.reasonCode });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async memoryGet(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const memory = repo.get(params.id);
      const gate = policyGate(res, 'memory.read', { resourceId: params.id, resourceType: 'memory', sensitivity: memory?.sensitivity ?? 'normal', workspaceId: memory?.workspaceId ?? principal.workspaceId }, principal, {});
      if (!gate) return;
      if (!memory) { sendJson(res, 404, { error: 'Not found.', code: 'not_found' }); return; }
      sendJson(res, 200, { memory });
    },

    async memoryUpdate(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const patch = stripClientOwnership(await readJsonBody(req));
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const existing = repo.get(params.id);
      const gate = policyGate(res, 'memory.update', { resourceId: params.id, resourceType: 'memory', sensitivity: existing?.sensitivity ?? 'normal', workspaceId: principal.workspaceId }, principal, {});
      if (!gate) return;
      if (!existing && hasTombstone(principal.workspaceId, 'memory', params.id)) {
        sendJson(res, 409, { ok: false, error: 'This record was deleted.', code: 'record_deleted' });
        return;
      }
      const result = repo.update(params.id, patch);
      if (result.ok) audit(principal, { action: 'memory.update', resourceType: 'memory', resourceId: params.id, outcome: 'updated', sensitivity: result.memory.sensitivity });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async memorySupersede(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { newId } = await readJsonBody(req);
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.supersede(params.id, newId);
      if (result.ok) audit(principal, { action: 'memory.correct', resourceType: 'memory', resourceId: newId, outcome: 'superseded', sourceIds: [params.id] });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async memorySearch(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const filters = { type: query.type, subjectId: query.subjectId, predicate: query.predicate, status: query.status, includeInactive: query.includeInactive === 'true', tags: query.tags ? query.tags.split(',') : undefined };
      const candidates = repo.searchStructured(filters).slice(0, Math.min(Number(query.limit) || DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      const { allowed, decisions } = filterBySensitivity({
        action: 'memory.search',
        records: candidates.map((m) => ({ resourceId: m.memoryId, sensitivity: m.sensitivity, workspaceId: principal.workspaceId, memory: m })),
        resourceType: 'memory', principal,
        context: { isProactive: query.proactive === 'true', confirmed: query.confirmed === 'true' },
        relevanceOf: (r) => relevanceFromContext({ query: query.q, subjectId: r.memory.subjectId, entityIds: query.entityIds ? query.entityIds.split(',') : [] }),
      });
      audit(principal, { action: 'memory.search', resourceType: 'memory', outcome: 'listed', reasonCode: `${allowed.length}/${candidates.length}_allowed`, sourceIds: allowed.map((r) => r.resourceId) });
      sendJson(res, 200, { memories: allowed.map((r) => r.memory), policyDecisions: decisions.map((d) => ({ resourceId: d.resourceId, decision: d.decision, reasonCode: d.reasonCode })) });
    },

    async memoryAccess(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { ids } = await readJsonBody(req);
      memoryRepository.forWorkspace(principal.workspaceId, principal.userId).markAccessed(Array.isArray(ids) ? ids.slice(0, 50) : []);
      sendJson(res, 200, { ok: true });
    },

    async memoryDelete(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const deleted = repo.delete(params.id);
      audit(principal, { action: 'memory.delete', resourceType: 'memory', resourceId: params.id, outcome: deleted ? 'deleted' : 'not_found' });
      sendJson(res, 200, { ok: deleted });
    },

    async memoryDeleteBySource(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { interactionId } = await readJsonBody(req);
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const count = repo.deleteBySource(interactionId);
      audit(principal, { action: 'memory.delete_by_source', resourceType: 'memory', outcome: 'deleted', reasonCode: `count_${count}`, sourceIds: [interactionId] });
      sendJson(res, 200, { ok: true, count });
    },

    async memoryExport(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = memoryRepository.forWorkspace(principal.workspaceId, principal.userId);
      const all = repo.exportAll();
      const { allowed } = filterBySensitivity({ action: 'memory.export', records: all.map((m) => ({ resourceId: m.memoryId, sensitivity: m.sensitivity, workspaceId: principal.workspaceId, memory: m })), resourceType: 'memory', principal, context: { relevance: 1 }, relevanceOf: () => 1 });
      audit(principal, { action: 'memory.export', resourceType: 'memory', outcome: 'exported', reasonCode: `count_${allowed.length}` });
      sendJson(res, 200, { memories: allowed.map((r) => r.memory) });
    },

    // ── people ──────────────────────────────────────────────────────────
    async peopleCreate(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const raw = stripClientOwnership(await readJsonBody(req));
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.createPerson(raw);
      if (result.ok) audit(principal, { action: 'person.create', resourceType: 'person', resourceId: result.person.personId, outcome: 'created', sensitivity: result.person.sensitivity });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async peopleGet(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const person = repo.getPerson(params.id);
      const gate = policyGate(res, 'person.read', { resourceId: params.id, resourceType: 'person', sensitivity: person?.sensitivity ?? 'normal', workspaceId: person ? principal.workspaceId : principal.workspaceId }, principal, {});
      if (!gate) return;
      if (!person) { sendJson(res, 404, { error: 'Not found.', code: 'not_found' }); return; }
      sendJson(res, 200, { person });
    },

    async peopleUpdate(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const patch = stripClientOwnership(await readJsonBody(req));
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.updatePerson(params.id, patch);
      if (result.ok) audit(principal, { action: 'person.update', resourceType: 'person', resourceId: params.id, outcome: 'updated' });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    /** Full-workspace hydration source for the client's local mirror (src/server/remoteIdentityRepository.js) — people + evidence + relationships in one bounded call. */
    async identityExport(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const all = repo.exportAll();
      const peopleResult = filterBySensitivity({ action: 'person.export', records: all.people.map((person) => ({ resourceId: person.personId, sensitivity: person.sensitivity, workspaceId: principal.workspaceId, person })), resourceType: 'person', principal });
      const evidenceResult = filterBySensitivity({ action: 'person.export', records: all.evidence.map((evidence) => ({ resourceId: evidence.evidenceId, sensitivity: evidence.sensitivity, workspaceId: principal.workspaceId, evidence })), resourceType: 'identity_evidence', principal });
      const relationshipResult = filterBySensitivity({ action: 'relationship.traverse', records: all.relationships.map((relationship) => ({ resourceId: relationship.relationshipId, sensitivity: relationship.sensitivity, workspaceId: principal.workspaceId, relationship })), resourceType: 'relationship', principal });
      sendJson(res, 200, {
        people: peopleResult.allowed.map(({ person }) => ({ ...person, voiceProfileIds: [] })),
        evidence: evidenceResult.allowed.map(({ evidence }) => evidence),
        relationships: relationshipResult.allowed.map(({ relationship }) => relationship),
      });
    },

    async peopleList(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      let people;
      if (query.name) people = repo.findByName(query.name, { includeInactive: query.includeInactive === 'true' });
      else if (query.q) people = repo.findCandidates({ query: query.q, includeInactive: query.includeInactive === 'true', limit: Math.min(Number(query.limit) || DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) });
      else people = repo.listPeople({ status: query.status, identityStatus: query.identityStatus, includeInactive: query.includeInactive === 'true' }).slice(0, MAX_LIST_LIMIT);
      const { allowed } = filterBySensitivity({ action: 'person.search', records: people.map((person) => ({ resourceId: person.personId, sensitivity: person.sensitivity, workspaceId: principal.workspaceId, person })), resourceType: 'person', principal });
      sendJson(res, 200, { people: allowed.map(({ person }) => ({ ...person, voiceProfileIds: [] })) });
    },

    async peopleMerge(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { sourcePersonIds, targetPersonId } = await readJsonBody(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.mergePeople(sourcePersonIds ?? [], targetPersonId);
      if (result.ok) audit(principal, { action: 'person.merge', resourceType: 'person', resourceId: targetPersonId, outcome: 'merged', sourceIds: result.mergedIds });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async peopleSplit(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const splitPlan = await readJsonBody(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.splitPerson(params.id, splitPlan);
      if (result.ok) audit(principal, { action: 'person.split', resourceType: 'person', resourceId: params.id, outcome: 'split', sourceIds: [result.target?.personId].filter(Boolean) });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async peopleDelete(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.deletePerson(params.id);
      audit(principal, { action: 'person.delete', resourceType: 'person', resourceId: params.id, outcome: result.ok ? 'deleted' : 'not_found' });
      sendJson(res, result.ok ? 200 : 404, result);
    },

    // ── real bounded voice identity ─────────────────────────────────────
    async voiceIdentityStatus(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      sendJson(res, 200, { ok: true, ...voiceIdentity?.getProviderStatus(), authMode: auth.mode, developmentOnly: auth.mode === 'development' });
    },

    async voiceIdentityDiagnostics(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      if (auth.mode !== 'development') { sendJson(res, 404, { error: 'Not found.', code: 'not_found' }); return; }
      const { query } = parseUrl(req);
      sendJson(res, 200, { events: voiceIdentity?.getDiagnostics(query.limit) ?? [] });
    },

    async voiceCaptureBegin(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      if (!voiceIdentity) { sendJson(res, 503, { error: 'Voice identity is not configured.', code: 'provider_unavailable' }); return; }
      const body = stripClientOwnership(await readJsonBody(req));
      if (typeof body.sessionId !== 'string' || !body.sessionId || typeof body.purpose !== 'string') {
        sendJson(res, 400, { error: 'sessionId and purpose are required.', code: 'invalid_request' }); return;
      }
      const action = body.purpose === 'enrollment' ? 'identity.voice_enroll' : body.purpose === 'identification' ? 'identity.voice_identify' : 'identity.voice_compare';
      const consentRepo = consentRepository.forWorkspace(principal.workspaceId, principal.userId);
      const consentActive = body.consentId ? consentRepo.get(body.consentId)?.status === 'active' : body.purpose === 'quality_check';
      const gate = policyGate(res, action, { resourceType: 'voice_sample', resourceId: body.operationId, sensitivity: 'biometric', workspaceId: principal.workspaceId }, principal, { consentActive });
      if (!gate) return;
      const result = voiceIdentity.beginCapture(principal, body);
      if (result.ok) audit(principal, { action: `${action}.capture_begin`, resourceType: 'voice_sample', resourceId: result.operationId, outcome: 'started', sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async voiceCaptureGet(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const status = voiceIdentity?.getCapture(principal, params.id);
      sendJson(res, status ? 200 : 404, status ? { ok: true, status } : { ok: false, code: 'capture_not_found' });
    },

    async voiceCaptureFlags(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const result = voiceIdentity?.updateCaptureFlags(principal, params.id, await readJsonBody(req)) ?? { ok: false, reasonCode: 'provider_unavailable' };
      sendJson(res, result.ok ? 200 : 404, result);
    },

    async voiceCaptureCancel(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const result = voiceIdentity?.cancelCapture(principal, params.id) ?? { ok: false, reasonCode: 'provider_unavailable' };
      audit(principal, { action: 'identity.voice_capture_cancel', resourceType: 'voice_sample', resourceId: params.id, outcome: result.ok ? 'cancelled' : 'not_found', sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 200 : 404, result);
    },

    async voiceEnrollmentFinalize(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const result = await voiceIdentity.finalizeEnrollment(principal, params.id);
      audit(principal, { action: 'identity.voice_enroll', resourceType: 'voice_profile', resourceId: result.profile?.voiceProfileId ?? params.id, operationId: params.id, outcome: result.ok ? 'enrolled' : 'rejected', reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 201 : 422, result);
    },

    async voiceMatchFinalize(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const result = await voiceIdentity.finalizeMatch(principal, params.id, { allowPossibleReplay: body.confirmPossibleReplay === true });
      audit(principal, { action: 'identity.voice_identify', resourceType: 'voice_sample', resourceId: params.id, operationId: params.id, outcome: result.ok ? result.decision : 'rejected', reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 200 : 422, result);
    },

    async voiceProfileUpdateReal(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const result = await voiceIdentity.updateProfile(principal, params.id, params.voiceProfileId, { explicitlyConfirmed: body.explicitlyConfirmed === true });
      audit(principal, { action: 'identity.voice_update', resourceType: 'voice_profile', resourceId: params.voiceProfileId, operationId: params.id, outcome: result.ok ? 'updated' : 'rejected', reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 200 : 422, result);
    },

    async voiceProfilesList(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const gate = policyGate(res, 'identity.voice_read_metadata', { resourceType: 'voice_profile', resourceId: params.personId, sensitivity: 'biometric', workspaceId: principal.workspaceId }, principal, {});
      if (!gate) return;
      sendJson(res, 200, { profiles: voiceIdentity.listProfiles(principal, params.personId) });
    },

    async voiceProfileDeleteReal(req, res, params) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const gate = policyGate(res, 'identity.voice_delete', { resourceType: 'voice_profile', resourceId: params.id, sensitivity: 'biometric', workspaceId: principal.workspaceId }, principal, { consentActive: true });
      if (!gate) return;
      const result = voiceIdentity.deleteProfile(principal, params.id);
      audit(principal, { action: 'identity.voice_delete', resourceType: 'voice_profile', resourceId: params.id, outcome: result.ok ? 'deleted' : 'not_found', sensitivity: 'biometric', redacted: true });
      sendJson(res, result.ok ? 200 : 404, result);
    },

    async voiceResolutionConfirm(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const body = stripClientOwnership(await readJsonBody(req));
      const result = voiceIdentity.confirmResolution(principal, body);
      audit(principal, { action: 'identity.voice_resolution_confirm', resourceType: 'person', resourceId: body.personId, outcome: result.status, reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.status === 'resolved' ? 200 : 400, result);
    },

    async voiceResolutionReject(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const body = stripClientOwnership(await readJsonBody(req));
      const result = voiceIdentity.rejectResolution(principal, body);
      audit(principal, { action: 'identity.voice_resolution_reject', resourceType: 'person', resourceId: body.personId, outcome: result.status, reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.status === 'rejected' ? 200 : 400, result);
    },

    async voiceResolutionCorrect(req, res) {
      const principal = await withBiometricPrincipal(req, res); if (!principal) return;
      const body = stripClientOwnership(await readJsonBody(req));
      const result = voiceIdentity.correctResolution(principal, body);
      audit(principal, { action: 'identity.voice_resolution_correct', resourceType: 'person', resourceId: result.personId, outcome: result.status, reasonCode: result.reasonCode, sensitivity: 'biometric', redacted: true });
      sendJson(res, result.status === 'resolved' ? 200 : 400, result);
    },

    async voiceProfileCreate(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      audit(principal, { action: 'identity.voice_enroll_legacy_route', resourceType: 'person', resourceId: params.id, outcome: 'denied', reasonCode: 'bounded_capture_required', sensitivity: 'biometric', redacted: true });
      sendJson(res, 410, { ok: false, error: 'Opaque voice-profile references can no longer be created directly. Use the bounded voice enrollment flow.', code: 'bounded_capture_required' });
    },

    async voiceProfileDelete(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      audit(principal, { action: 'identity.voice_delete_legacy_route', resourceType: 'voice_profile', resourceId: params.voiceProfileId, outcome: 'denied', reasonCode: 'protected_delete_route_required', sensitivity: 'biometric', redacted: true });
      sendJson(res, 410, { ok: false, error: 'Use the protected voice-profile deletion route.', code: 'protected_delete_route_required' });
    },

    // ── evidence ────────────────────────────────────────────────────────
    async evidenceCreate(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const raw = stripClientOwnership(await readJsonBody(req));
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.addEvidence(raw);
      if (result.ok) audit(principal, { action: 'identity.evidence_create', resourceType: 'identity_evidence', resourceId: result.evidence.evidenceId, outcome: 'created', sensitivity: result.evidence.sensitivity });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async evidenceForPerson(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, { evidence: repo.listEvidenceForPerson(params.id) });
    },

    // ── relationships ───────────────────────────────────────────────────
    async relationshipCreate(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const raw = stripClientOwnership(await readJsonBody(req));
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.createRelationship(raw);
      if (result.ok) audit(principal, { action: 'relationship.create', resourceType: 'relationship', resourceId: result.relationship.relationshipId, outcome: 'created' });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async relationshipList(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const relationships = repo.listRelationships({ entityId: query.entityId, type: query.type, includeInactive: query.includeInactive === 'true' }).slice(0, MAX_LIST_LIMIT);
      const { allowed } = filterBySensitivity({ action: 'relationship.traverse', records: relationships.map((relationship) => ({ resourceId: relationship.relationshipId, sensitivity: relationship.sensitivity, workspaceId: principal.workspaceId, relationship })), resourceType: 'relationship', principal });
      sendJson(res, 200, { relationships: allowed.map(({ relationship }) => relationship) });
    },

    async relationshipUpdate(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const patch = await readJsonBody(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.updateRelationship(params.id, patch);
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async relationshipSupersede(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { newId } = await readJsonBody(req);
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.supersedeRelationship(params.id, newId);
      if (result.ok) audit(principal, { action: 'relationship.correct', resourceType: 'relationship', resourceId: newId, outcome: 'superseded', sourceIds: [params.id] });
      sendJson(res, result.ok ? 200 : 400, result);
    },

    async relationshipDelete(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
      const deleted = repo.deleteRelationship(params.id);
      audit(principal, { action: 'relationship.delete', resourceType: 'relationship', resourceId: params.id, outcome: deleted ? 'deleted' : 'not_found' });
      sendJson(res, 200, { ok: deleted });
    },

    // ── session ─────────────────────────────────────────────────────────
    async sessionStart(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const repo = sessionRepository.forWorkspace(principal.workspaceId, principal.userId);
      const session = repo.start({ ttlMs: body.ttlMs });
      sendJson(res, 201, { session });
    },

    async sessionGet(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = sessionRepository.forWorkspace(principal.workspaceId, principal.userId);
      const session = repo.get(params.id);
      if (!session) { sendJson(res, 404, { error: 'Not found or expired.', code: 'not_found' }); return; }
      sendJson(res, 200, { session });
    },

    async sessionUpdate(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { patch, expectedVersion } = await readJsonBody(req);
      const repo = sessionRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.update(params.id, stripClientOwnership(patch ?? {}), expectedVersion);
      sendJson(res, result.ok ? 200 : (result.reasonCode === 'not_found' ? 404 : 409), result);
    },

    async sessionEnd(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = sessionRepository.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, { ok: repo.end(params.id) });
    },

    // ── consent ─────────────────────────────────────────────────────────
    async consentGrant(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const repo = consentRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.grant(body);
      if (result.ok) audit(principal, { action: 'consent.grant', resourceType: 'consent', resourceId: result.consent.consentId, outcome: 'granted', sourceIds: [body.personId] });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async consentRevoke(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const repo = consentRepository.forWorkspace(principal.workspaceId, principal.userId);
      const result = repo.revoke(params.id);
      if (result.ok) {
        // Revoking consent must disable FUTURE biometric processing — freeze
        // (never silently keep usable) every voice profile granted under
        // this consent record, without erasing the reference (see
        // identityRepository.revokeVoiceProfile's doc comment).
        const idRepo = identityRepository.forWorkspace(principal.workspaceId, principal.userId);
        const linked = db.prepare('SELECT voice_profile_id FROM voice_profile_refs WHERE workspace_id = ? AND consent_id = ? AND revoked_at IS NULL').all(principal.workspaceId, params.id);
        for (const row of linked) idRepo.revokeVoiceProfile(row.voice_profile_id);
        voiceIdentity?.revokeConsent(principal, params.id);
        audit(principal, { action: 'consent.revoke', resourceType: 'consent', resourceId: params.id, outcome: 'revoked', sourceIds: linked.map((r) => r.voice_profile_id), sensitivity: 'biometric', redacted: true });
      }
      sendJson(res, result.ok ? 200 : 404, result);
    },

    async consentList(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const repo = consentRepository.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, { consents: query.personId ? repo.listForPerson(query.personId) : [] });
    },

    // ── migration ───────────────────────────────────────────────────────
    async migrationDryRun(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { records } = await readJsonBody(req);
      const repo = { memory: memoryRepository.forWorkspace(principal.workspaceId, principal.userId), identity: identityRepository.forWorkspace(principal.workspaceId, principal.userId) };
      const plan = planMigration({ records: records ?? {}, repositories: repo });
      sendJson(res, 200, { plan });
    },

    async migrationImport(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { records, operationId } = await readJsonBody(req);
      const repo = { memory: memoryRepository.forWorkspace(principal.workspaceId, principal.userId), identity: identityRepository.forWorkspace(principal.workspaceId, principal.userId) };
      const result = applyMigration({ db, workspaceId: principal.workspaceId, records: records ?? {}, repositories: repo, operationId, now });
      audit(principal, { action: 'migration.import', resourceType: 'migration', outcome: result.alreadyApplied ? 'replayed' : 'imported', operationId, reasonCode: `memories_${result.report.memoriesImported}_people_${result.report.peopleImported}` });
      sendJson(res, 200, result);
    },

    // ── preflight ───────────────────────────────────────────────────────
    /**
     * Single bounded development preflight: server-side subsystem states
     * only — booleans/enums/versions, never a secret value. The browser
     * merges this with its own local checks (microphone/camera permission,
     * audio readiness, repository provider, mutation-queue status) via
     * src/server/preflight.js. States: ready | degraded | unavailable |
     * blocked | misconfigured.
     */
    async preflight(req, res) {
      const resolved = await auth.resolvePrincipal(req);
      const env = loadServerEnv();
      const nodeMajor = Number(process.versions.node.split('.')[0]);
      let schemaVersion = null; let dbReadable = false; let dbWritable = false;
      try { schemaVersion = currentSchemaVersion(db); dbReadable = true; } catch { /* unreadable */ }
      try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); dbWritable = true; } catch { /* read-only or locked */ }
      const voiceStatus = (() => { try { return voiceIdentity?.getProviderStatus() ?? null; } catch { return null; } })();
      sendJson(res, 200, {
        generatedAt: now(),
        node: { version: process.versions.node, state: nodeMajor >= 24 ? 'ready' : 'misconfigured', requires: '>=24 (built-in node:sqlite)' },
        database: { state: dbReadable ? (dbWritable ? 'ready' : 'degraded') : 'unavailable', schemaVersion, writable: dbWritable },
        auth: {
          mode: auth.mode,
          state: auth.mode === 'development' ? 'degraded' : (resolved.ok ? 'ready' : 'blocked'),
          reason: auth.mode === 'development' ? 'development principal — NOT production authentication' : (resolved.ok ? null : 'auth_not_configured (fails closed)'),
          principalResolved: resolved.ok,
        },
        groq: { state: env.groqApiKey ? 'ready' : 'unavailable', model: env.agentModel, visionModel: env.visionModel },
        deepgram: { state: env.deepgramApiKey ? 'ready' : 'unavailable' },
        tts: { state: env.tts.apiKey ? 'ready' : 'unavailable', provider: env.tts.provider, model: env.tts.model },
        biometricEncryption: {
          state: voiceStatus?.encryption?.configured ? 'ready' : 'misconfigured',
          keyVersion: voiceStatus?.encryption?.configured ? voiceStatus.encryption.keyVersion : null,
          reason: voiceStatus?.encryption?.configured ? null : 'BIOMETRIC_ENCRYPTION_KEY not set — voice identity fails closed',
        },
        voiceIdentity: {
          state: voiceStatus?.ready ? 'ready' : 'unavailable',
          provider: voiceStatus?.provider ?? null,
          model: voiceStatus?.model ?? null,
          modelVersion: voiceStatus?.modelVersion ?? null,
        },
        envWarnings: env.warnings, // variable-NAME rename advice only — never values
      });
    },

    // ── retention / admin ───────────────────────────────────────────────
    async retentionCleanup(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const result = runRetentionCleanup({ db, sessionRepository, identityRepository, workspaceId: principal.workspaceId, userId: principal.userId, now });
      audit(principal, { action: 'retention.cleanup', resourceType: 'workspace', outcome: 'cleaned', reasonCode: `sessions_${result.expiredSessions}_people_${result.expiredProvisionalPeople.length}` });
      sendJson(res, 200, { result });
    },

    async auditList(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      if (auth.mode !== 'development') { sendJson(res, 403, { error: 'Audit read is development-only in this phase.', code: 'production_audit_read_not_implemented' }); return; }
      const { query } = parseUrl(req);
      const repo = auditRepository.forWorkspace(principal.workspaceId);
      sendJson(res, 200, { events: repo.list({ limit: Math.min(Number(query.limit) || DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT), action: query.action, resourceType: query.resourceType }), byOutcome: repo.countByOutcome() });
    },

    async workspaceDeletePlan(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      sendJson(res, 200, { plan: planWorkspaceDeletion({ db, workspaceId: principal.workspaceId }) });
    },

    async workspaceDelete(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { confirm, operationId } = await readJsonBody(req);
      const gate = policyGate(res, 'admin.workspace_delete', { resourceType: 'workspace', resourceId: principal.workspaceId, sensitivity: 'secret', workspaceId: principal.workspaceId }, principal, { recentAuthAt: principal.authenticatedAt ?? null, now: now() });
      if (!gate) return;
      try {
        const result = deleteWorkspace({ db, workspaceId: principal.workspaceId, operationId, principalId: principal.userId, auditRepository, confirm: Boolean(confirm), now });
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        sendJson(res, 500, { error: error.message, code: 'deletion_failed' });
      }
    },
  };

  // Data-mutation routes that honor the X-Roma-Operation-Id idempotency
  // header (see withIdempotentReplay above for why /api/voice biometric
  // routes are deliberately excluded).
  const IDEMPOTENT_HANDLERS = {
    memoryCreate: 'memory.create', memoryUpdate: 'memory.update', memorySupersede: 'memory.correct',
    memoryDelete: 'memory.delete', memoryDeleteBySource: 'memory.delete_by_source', memoryAccess: 'memory.access',
    peopleCreate: 'person.create', peopleUpdate: 'person.update', peopleMerge: 'person.merge',
    peopleSplit: 'person.split', peopleDelete: 'person.delete',
    evidenceCreate: 'identity.evidence_create',
    relationshipCreate: 'relationship.create', relationshipUpdate: 'relationship.update',
    relationshipSupersede: 'relationship.correct', relationshipDelete: 'relationship.delete',
    consentGrant: 'consent.grant', consentRevoke: 'consent.revoke',
  };
  for (const [name, action] of Object.entries(IDEMPOTENT_HANDLERS)) handlers[name] = withIdempotentReplay(handlers[name], action);
  return handlers;
}

const ROUTES = [
  ['GET', '/api/data/health', 'health'],
  ['POST', '/api/data/memory', 'memoryCreate'],
  ['GET', '/api/data/memory', 'memorySearch'],
  ['POST', '/api/data/memory/access', 'memoryAccess'],
  ['POST', '/api/data/memory/delete-by-source', 'memoryDeleteBySource'],
  ['GET', '/api/data/memory/export', 'memoryExport'],
  ['GET', '/api/data/memory/:id', 'memoryGet'],
  ['PATCH', '/api/data/memory/:id', 'memoryUpdate'],
  ['POST', '/api/data/memory/:id/supersede', 'memorySupersede'],
  ['DELETE', '/api/data/memory/:id', 'memoryDelete'],

  ['POST', '/api/data/people', 'peopleCreate'],
  ['GET', '/api/data/identity/export', 'identityExport'],
  ['GET', '/api/data/people', 'peopleList'],
  ['POST', '/api/data/people/merge', 'peopleMerge'],
  ['GET', '/api/data/people/:id', 'peopleGet'],
  ['PATCH', '/api/data/people/:id', 'peopleUpdate'],
  ['POST', '/api/data/people/:id/split', 'peopleSplit'],
  ['DELETE', '/api/data/people/:id', 'peopleDelete'],
  ['GET', '/api/data/people/:id/evidence', 'evidenceForPerson'],
  ['POST', '/api/data/people/:id/voice-profile', 'voiceProfileCreate'],
  ['DELETE', '/api/data/people/:id/voice-profile/:voiceProfileId', 'voiceProfileDelete'],

  ['GET', '/api/voice/status', 'voiceIdentityStatus'],
  ['GET', '/api/voice/diagnostics', 'voiceIdentityDiagnostics'],
  ['POST', '/api/voice/captures', 'voiceCaptureBegin'],
  ['GET', '/api/voice/captures/:id', 'voiceCaptureGet'],
  ['POST', '/api/voice/captures/:id/flags', 'voiceCaptureFlags'],
  ['DELETE', '/api/voice/captures/:id', 'voiceCaptureCancel'],
  ['POST', '/api/voice/captures/:id/finalize-enrollment', 'voiceEnrollmentFinalize'],
  ['POST', '/api/voice/captures/:id/finalize-match', 'voiceMatchFinalize'],
  ['POST', '/api/voice/captures/:id/update-profile/:voiceProfileId', 'voiceProfileUpdateReal'],
  ['GET', '/api/voice/people/:personId/profiles', 'voiceProfilesList'],
  ['DELETE', '/api/voice/profiles/:id', 'voiceProfileDeleteReal'],
  ['POST', '/api/voice/resolutions/confirm', 'voiceResolutionConfirm'],
  ['POST', '/api/voice/resolutions/reject', 'voiceResolutionReject'],
  ['POST', '/api/voice/resolutions/correct', 'voiceResolutionCorrect'],

  ['POST', '/api/data/evidence', 'evidenceCreate'],

  ['POST', '/api/data/relationships', 'relationshipCreate'],
  ['GET', '/api/data/relationships', 'relationshipList'],
  ['PATCH', '/api/data/relationships/:id', 'relationshipUpdate'],
  ['POST', '/api/data/relationships/:id/supersede', 'relationshipSupersede'],
  ['DELETE', '/api/data/relationships/:id', 'relationshipDelete'],

  ['POST', '/api/session/start', 'sessionStart'],
  ['GET', '/api/session/:id', 'sessionGet'],
  ['PATCH', '/api/session/:id', 'sessionUpdate'],
  ['DELETE', '/api/session/:id', 'sessionEnd'],

  ['POST', '/api/consent', 'consentGrant'],
  ['GET', '/api/consent', 'consentList'],
  ['POST', '/api/consent/:id/revoke', 'consentRevoke'],

  ['POST', '/api/migration/dry-run', 'migrationDryRun'],
  ['POST', '/api/migration/import', 'migrationImport'],

  ['POST', '/api/retention/cleanup', 'retentionCleanup'],
  ['GET', '/api/audit', 'auditList'],
  ['GET', '/api/preflight', 'preflight'],

  ['POST', '/api/admin/workspace/delete-plan', 'workspaceDeletePlan'],
  ['POST', '/api/admin/workspace/delete', 'workspaceDelete'],
];

export function attachDataApi(middlewares, handlers) {
  middlewares.use(async (req, res, next) => {
    if (!req.url.startsWith('/api/data') && !req.url.startsWith('/api/voice') && !req.url.startsWith('/api/session') && !req.url.startsWith('/api/consent') && !req.url.startsWith('/api/migration') && !req.url.startsWith('/api/retention') && !req.url.startsWith('/api/audit') && !req.url.startsWith('/api/admin') && !req.url.startsWith('/api/preflight')) { next(); return; }
    const { pathname } = parseUrl(req);
    for (const [method, pattern, handlerName] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;
      try {
        await handlers[handlerName](req, res, params);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? 'Internal error.', code: 'server_error' });
      }
      return;
    }
    sendJson(res, 404, { error: 'No such data-API route.', code: 'not_found' });
  });
}
