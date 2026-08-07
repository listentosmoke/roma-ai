// Isolated Roma server for lab runs: the REAL Vite dev server (same plugins,
// same routes, same providers) started with a DISPOSABLE SQLite database, an
// isolated tenant, a temporary biometric encryption key, and a unique port.
// The developer's real data/roma.db, memories, people, profiles, and consent
// records are never touched — the ROMA_DB_PATH env override (see
// server/dataApiPlugin.mjs) points every repository at the throwaway file.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startIsolatedServer({ port = 0, log = () => {} } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'roma-lab-run-'));
  const dbPath = join(workDir, 'lab.db');
  const runId = `lab_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const chosenPort = port || (20000 + Math.floor(Math.random() * 20000));
  const biometricKey = randomBytes(32).toString('base64'); // temporary, this run only

  const env = {
    ...process.env,
    ROMA_DB_PATH: dbPath,
    BIOMETRIC_ENCRYPTION_KEY: biometricKey,
    BIOMETRIC_ENCRYPTION_KEY_VERSION: '1',
    DEV_PRINCIPAL_USER_ID: `${runId}_user`,
    DEV_PRINCIPAL_WORKSPACE_ID: `${runId}_workspace`,
  };

  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(chosenPort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => { output.push(String(chunk)); log(String(chunk).trim()); });
  child.stderr.on('data', (chunk) => { output.push(String(chunk)); });

  const baseUrl = `http://127.0.0.1:${chosenPort}`;
  let ready = false;
  for (let waited = 0; waited < 30000; waited += 300) {
    try {
      const response = await fetch(`${baseUrl}/api/data/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) {
    child.kill();
    throw new Error(`Isolated server never became healthy on ${baseUrl}. Output tail: ${output.join('').slice(-500)}`);
  }

  return {
    baseUrl,
    port: chosenPort,
    dbPath,
    runId,
    workspaceId: `${runId}_workspace`,
    output,
    async close() {
      try { child.kill(); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { rmSync(workDir, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 400)); }
      }
    },
  };
}
