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
import { createFaceIdentityService } from './faceIdentity/service.mjs';
import { createFaceTemplateRepository } from './faceIdentity/templateRepository.mjs';
import { createFaceImageStore } from './faceIdentity/imageStore.mjs';
import { createTemplateCipher } from './voiceIdentity/crypto.mjs';
import { createFaceApiHandlers, attachFaceApi } from './routes/faceApi.mjs';
import { createEmbeddingsApiHandlers, createMemoryEmbeddingHandlers, attachEmbeddingsApi } from './routes/embeddingsApi.mjs';
import { createMemoryEmbeddingStore } from './repositories/memoryEmbeddingStore.mjs';
import { getSharedTextEmbeddingProvider } from './textEmbeddings/provider.mjs';

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
  // Enrollment frames are kept beside the database as redundancy for the
  // templates; recognition frames still are not (faceIdentity/imageStore.mjs
  // explains the boundary). ROMA_FACE_IMAGES=0 turns the redundancy off.
  // Built here because deleting a PERSON must delete their pictures too.
  const faceImageStore = loadWorkerConfigEnv().ROMA_FACE_IMAGES === '0' ? null : createFaceImageStore();
  const handlers = createDataApiHandlers({ db, repositories, auth, voiceIdentity, faceImageStore });

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

  // ── face identity ────────────────────────────────────────────────────────
  // Consent enforcement is OFF here (FACE_IDENTITY_REQUIRE_CONSENT=1 restores
  // it). The encoder loads lazily on first use so startup never blocks on a
  // 190 MB model, and a machine without the model simply has the subsystem
  // fail closed rather than the server refusing to boot.
  // The cipher reads its key from .env through the loader, not from
  // process.env: a key correctly set in .env was otherwise reported as missing
  // and the whole subsystem failed closed for no reason.
  const biometricEnv = loadWorkerConfigEnv();
  const faceCipher = createTemplateCipher({
    key: biometricEnv.BIOMETRIC_ENCRYPTION_KEY,
    keyVersion: Number(biometricEnv.BIOMETRIC_ENCRYPTION_KEY_VERSION ?? 1),
  });
  const faceIdentity = createFaceIdentityService({
    db,
    repository: createFaceTemplateRepository({ db, cipher: faceCipher }),
    consentRepository: repositories.consentRepository,
    imageStore: faceImageStore,
  });
  const faceDescribed = faceIdentity.describe();
  if (!faceDescribed.configured) log.warn('[face-identity] BIOMETRIC_ENCRYPTION_KEY not set — face identity fails closed.');
  else if (!faceDescribed.requireConsent) log.warn('[face-identity] enabled with CONSENT ENFORCEMENT OFF — templates can be enrolled without a consent record. Set FACE_IDENTITY_REQUIRE_CONSENT=1 to restore it.');
  const faceHandlers = createFaceApiHandlers({ faceIdentity, auth, identityRepository: repositories.identityRepository, auditRepository: repositories.auditRepository, imageStore: faceImageStore });

  // ── text embeddings ──────────────────────────────────────────────────────
  // Loaded lazily on first use, like the other two encoders, so startup never
  // waits on a model. Memory text is embedded here rather than anywhere else
  // precisely so it never leaves the machine.
  const textEmbeddings = getSharedTextEmbeddingProvider();
  const embeddingStore = createMemoryEmbeddingStore({ db });
  const embeddingsHandlers = createEmbeddingsApiHandlers({ provider: textEmbeddings, auth, embeddingStore });
  // Vectors persist server-side (migration 0008) so a fresh browser profile
  // seeds its cache instead of re-embedding the whole memory store.
  const memoryEmbeddingHandlers = createMemoryEmbeddingHandlers({
    provider: textEmbeddings, auth, embeddingStore, memoryRepository: repositories.memoryRepository,
  });

  return { db, auth, repositories, handlers, voiceIdentity, taskStore, engineeringMemory, dispatcher, agentTaskHandlers, faceIdentity, faceHandlers, textEmbeddings, embeddingsHandlers, embeddingStore, memoryEmbeddingHandlers };
}

export function dataApiPlugin({ voiceIdentity = getSharedVoiceIdentityService() } = {}) {
  let api;
  const setup = (server) => {
    api ??= createDataApi({ voiceIdentity });
    attachDataApi(server.middlewares, api.handlers);
    attachAgentTaskApi(server.middlewares, api.agentTaskHandlers);
    attachFaceApi(server.middlewares, api.faceHandlers);
    attachEmbeddingsApi(server.middlewares, api.embeddingsHandlers, api.memoryEmbeddingHandlers);
  };
  return {
    name: 'roma-data-api',
    configureServer(server) { setup(server); },
    configurePreviewServer(server) { setup(server); },
  };
}
