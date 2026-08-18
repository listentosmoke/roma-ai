#!/usr/bin/env node
// Server-side startup preflight — checks the same things GET /api/preflight
// reports, without starting Vite or a browser. Prints states only, never a
// secret value. Exit code 0 when core conversation can work (Deepgram+Groq
// configured, database writable); 1 otherwise. Optional subsystems
// (voice identity, TTS) degrade the report but do not fail the exit code.
//
//   node scripts/preflight.mjs [--db data/roma.db]

import { loadServerEnv, loadWorkerConfigEnv } from '../server/env.mjs';
import { openDatabase, currentSchemaVersion } from '../server/db/index.mjs';
import { loadAuthEnv } from '../server/auth.mjs';
import { createQwenCodeWorker } from '../server/agentEnv/workers/qwenCode.mjs';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : undefined;

const rows = [];
function report(name, state, detail = '') {
  rows.push([name, state, detail]);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
report('node', nodeMajor >= 24 ? 'ready' : 'misconfigured', `v${process.versions.node} (requires >= 24 for built-in node:sqlite) — ${process.platform}/${process.arch}`);

let coreOk = nodeMajor >= 24;

try {
  const db = openDatabase(dbPath ? { path: dbPath } : {});
  const version = currentSchemaVersion(db);
  let writable = false;
  try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); writable = true; } catch { /* locked or read-only */ }
  report('database', writable ? 'ready' : 'degraded', `schema ${version}${writable ? '' : ' — NOT writable (locked or read-only)'}`);
  coreOk = coreOk && writable;
  db.close();
} catch (error) {
  report('database', 'unavailable', error.message);
  coreOk = false;
}

const workerConfigEnvEarly = loadWorkerConfigEnv();
const env = loadServerEnv();
report('groq', env.groqApiKey ? 'ready' : 'unavailable', env.groqApiKey ? `agent ${env.agentModel} · vision ${env.visionModel}` : 'GROQ_API_KEY not set — agent falls back to mock');
report('deepgram', env.deepgramApiKey ? 'ready' : 'unavailable', env.deepgramApiKey ? 'STT streaming via local proxy' : 'DEEPGRAM_API_KEY not set — transcription unavailable');
report('tts', env.tts.apiKey ? 'ready' : 'unavailable', `provider ${env.tts.provider} · ${env.tts.model}`);
for (const warning of env.warnings) report('env', 'degraded', warning);

const auth = loadAuthEnv();
report('auth', auth.mode === 'development' ? 'degraded' : 'blocked', auth.mode === 'development'
  ? `development principal (${auth.devUserId}/${auth.devWorkspaceId}) — NOT production authentication`
  : 'production mode fails closed until a real verifyToken is configured');

// Read through the .env loader like every other check above. Reading
// process.env directly reported a correctly-configured key as missing.
const biometricConfigured = Boolean((workerConfigEnvEarly.BIOMETRIC_ENCRYPTION_KEY ?? '').trim());
const biometricKey = biometricConfigured ? 'ready' : 'misconfigured';
report('biometricEncryption', biometricKey, biometricKey === 'ready' ? `key version ${workerConfigEnvEarly.BIOMETRIC_ENCRYPTION_KEY_VERSION ?? 1}` : 'BIOMETRIC_ENCRYPTION_KEY not set — voice identity fails closed (optional subsystem)');

// Background engineering worker (optional subsystem; see AGENT-ENV.md).
// Worth reporting because "which engine will actually run my tasks, and can it
// authenticate" is invisible otherwise until a task silently fails.
const workerEnv = loadWorkerConfigEnv();
const requestedWorker = (workerEnv.AGENT_WORKER ?? 'mock').trim().toLowerCase();
if (requestedWorker === 'qwen') {
  const described = createQwenCodeWorker({ env: workerEnv }).describe();
  if (!described.available) report('agentWorker', 'misconfigured', `AGENT_WORKER=qwen but the CLI was not found — ${described.note}`);
  else if (described.credential !== 'configured') report('agentWorker', 'misconfigured', 'AGENT_WORKER=qwen but AGENT_WORKER_API_KEY is not set — the worker has no identity of its own, so every task fails');
  else report('agentWorker', 'ready', `REAL Qwen Code CLI · model ${described.model} · own credential configured (tests always force the mock)`);
} else {
  report('agentWorker', 'degraded', `${requestedWorker === 'mock' ? 'mock' : `unknown "${requestedWorker}" → mock`} — background tasks are scripted, not real work`);
}

const width = Math.max(...rows.map(([name]) => name.length));
console.log('\nRoma preflight');
console.log('──────────────');
for (const [name, state, detail] of rows) {
  const icon = state === 'ready' ? 'OK ' : state === 'degraded' ? 'WRN' : 'ERR';
  console.log(`${icon}  ${name.padEnd(width)}  ${state}${detail ? `  — ${detail}` : ''}`);
}
console.log(coreOk
  ? '\nCore conversation (STT -> agent -> TTS) can start. Optional subsystems above may still be degraded.'
  : '\nCore conversation is NOT ready — fix the ERR rows above.');
process.exit(coreOk ? 0 : 1);
