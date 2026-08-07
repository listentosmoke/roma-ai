// Vite plugin wiring the authenticated data API into the SAME dev/preview
// server process as groqApiPlugin (no second process, no new port) — see
// server/groqApi.js for the sibling pattern this deliberately mirrors.

import { openDatabase } from './db/index.mjs';
import { loadAuthEnv, createAuthBoundary } from './auth.mjs';
import { loadWorkerConfigEnv } from './env.mjs';
import { createSqliteMemoryRepository } from './repositories/memoryRepository.mjs';
import { createSqliteIdentityRepository } from './repositories/identityRepository.mjs';
import { createSqliteAuditRepository } from './repositories/auditRepository.mjs';
import { createSqliteConsentRepository } from './repositories/consentRepository.mjs';
import { createSqliteSessionRepository } from './repositories/sessionRepository.mjs';
import { createDataApiHandlers, attachDataApi } from './routes/dataApi.mjs';
import { getSharedVoiceIdentityService } from './voiceIdentity/service.mjs';
import { createTaskStore } from './agentEnv/taskStore.mjs';
import { createEngineeringMemory } from './agentEnv/engineeringMemory.mjs';
import { createDispatcher } from './agentEnv/dispatcher.mjs';
import { createMockWorker } from './agentEnv/workers/mock.mjs';
import { createQwenCodeWorker } from './agentEnv/workers/qwenCode.mjs';
import { createAgentTaskHandlers, attachAgentTaskApi } from './routes/agentTasks.mjs';

/**
 * Is this process a test run? `node --test` sets NODE_TEST_CONTEXT in the
 * child it spawns per file.
 */
export function isTestContext(env = process.env) {
  return Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
}

/**
 * Choose the background worker engine.
 *
 * Fails SAFE: a test run always gets the mock, whatever `.env` says. Without
 * that, adding `AGENT_WORKER=qwen` to a developer's `.env` silently turned
 * `npm test` into something that spawned real coding-agent processes and spent
 * real tokens — which is exactly what happened the first time this was wired
 * up, and is why the regression test in test/agent-env.test.js exists.
 */
export function selectWorker({ env = loadWorkerConfigEnv(), log = console, testContext = isTestContext() } = {}) {
  const requested = (env.AGENT_WORKER ?? 'mock').trim().toLowerCase();
  if (requested !== 'mock' && testContext) {
    return createMockWorker();
  }
  if (requested === 'mock') return createMockWorker();
  if (requested !== 'qwen') {
    log.warn?.(`[agent-env] unknown AGENT_WORKER="${requested}" — falling back to the mock worker.`);
    return createMockWorker();
  }

  const worker = createQwenCodeWorker({ env });
  const described = worker.describe();
  if (!described.available) log.warn?.(`[agent-env] AGENT_WORKER=qwen but the CLI was not found: ${described.note}`);
  else if (described.credential !== 'configured') log.warn?.('[agent-env] AGENT_WORKER=qwen but AGENT_WORKER_API_KEY is not set — the worker has no credentials of its own and every task will fail. See AGENT-ENV.md.');
  else log.warn?.(`[agent-env] AGENT_WORKER=qwen — background tasks run the REAL Qwen Code CLI (${described.source}, model ${described.model}).`);
  return worker;
}

export function createDataApi({ dbPath = process.env.ROMA_DB_PATH || undefined, log = console, voiceIdentity = getSharedVoiceIdentityService() } = {}) {
  // ROMA_DB_PATH: used by the virtual-hardware lab (scripts/lib/simServer.mjs)
  // to point an isolated server run at a DISPOSABLE database instead of the
  // developer's real data/roma.db. Unset in normal development/production.
  const db = openDatabase(dbPath ? { path: dbPath } : {});
  const authEnv = loadAuthEnv();
  const auth = createAuthBoundary({ mode: authEnv.mode, devUserId: authEnv.devUserId, devWorkspaceId: authEnv.devWorkspaceId });
  if (auth.mode === 'development') log.warn(`[data-api] AUTH_MODE=development — using the deterministic development principal ("${authEnv.devUserId}"/"${authEnv.devWorkspaceId}"). This is NOT production authentication. See SERVER-DATA.md "Authentication boundary".`);
  else log.warn('[data-api] AUTH_MODE=production with no verifyToken configured — every data-API request will fail closed (401 auth_not_configured) until a real token verifier is wired in.');

  const repositories = {
    memoryRepository: createSqliteMemoryRepository({ db }),
    identityRepository: createSqliteIdentityRepository({ db }),
    auditRepository: createSqliteAuditRepository({ db }),
    consentRepository: createSqliteConsentRepository({ db }),
    sessionRepository: createSqliteSessionRepository({ db }),
  };
  voiceIdentity.configure({ database: db, dataRepositories: repositories });
  const handlers = createDataApiHandlers({ db, repositories, auth, voiceIdentity });

  // ── server agent environment (background task dispatch) ──────────────────
  // The worker engine is replaceable by configuration, and defaults to the
  // deterministic scripted worker: a wearable that can silently start driving a
  // real coding agent has to be opted into, never inherited from a stray env.
  // AGENT_WORKER=qwen selects the installed Qwen Code CLI; anything else
  // satisfying server/agentEnv/workers/adapter.mjs drops in the same way.
  const taskStore = createTaskStore({ db });
  const engineeringMemory = createEngineeringMemory({ db });
  const worker = selectWorker({ log });
  const dispatcher = createDispatcher({ taskStore, engineeringMemory, worker, auditRepository: repositories.auditRepository });
  // Anything mid-flight died with the previous process: mark it failed and
  // visible rather than leaving it looking alive.
  const interrupted = taskStore.failInterruptedEverywhere();
  if (interrupted) log.warn(`[agent-env] marked ${interrupted} interrupted background task(s) as failed after restart.`);
  const agentTaskHandlers = createAgentTaskHandlers({ taskStore, engineeringMemory, dispatcher, auth });

  return { db, auth, repositories, handlers, voiceIdentity, taskStore, engineeringMemory, dispatcher, agentTaskHandlers };
}

export function dataApiPlugin({ voiceIdentity = getSharedVoiceIdentityService() } = {}) {
  let api;
  const setup = (server) => {
    api ??= createDataApi({ voiceIdentity });
    attachDataApi(server.middlewares, api.handlers);
    attachAgentTaskApi(server.middlewares, api.agentTaskHandlers);
  };
  return {
    name: 'roma-data-api',
    configureServer(server) { setup(server); },
    configurePreviewServer(server) { setup(server); },
  };
}
