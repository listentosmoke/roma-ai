// Live verification for the REAL Qwen Code worker.
//
//   node scripts/verify-qwen-worker.mjs            readonly task only
//   node scripts/verify-qwen-worker.mjs --write     also verify write mode
//
// Opt-in and never part of `npm test`, for the same reason the other live
// scripts are: this one spends real tokens against the model configured in the
// user's own ~/.qwen. Everything it touches is disposable — a scratch git repo
// under the OS temp directory and an in-memory database. It never reads or
// writes the developer's roma.db, the real project, or the user's Qwen config.
//
// What it proves that the unit tests cannot: that the CLI honours the tool
// restrictions we ask for, that the event stream maps onto the adapter
// contract, that learnings land in ENGINEERING memory, and that write mode
// produces a reviewable patch without touching a working tree.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadWorkerConfigEnv } from '../server/env.mjs';
import { openDatabase } from '../server/db/index.mjs';
import { createTaskStore } from '../server/agentEnv/taskStore.mjs';
import { createEngineeringMemory } from '../server/agentEnv/engineeringMemory.mjs';
import { createDispatcher } from '../server/agentEnv/dispatcher.mjs';
import { createQwenCodeWorker } from '../server/agentEnv/workers/qwenCode.mjs';
import { READONLY_TOOLS, verifyToolSurface } from '../server/agentEnv/workers/qwenProtocol.mjs';

const execFileAsync = promisify(execFile);
const PRINCIPAL = { workspaceId: 'ws_verify', userId: 'user_verify' };
const wantWrite = process.argv.includes('--write');

const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function makeScratchProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roma-qwen-verify-'));
  await fs.writeFile(path.join(root, 'temperature.js'), [
    'export function toFahrenheit(celsius) {',
    '  return celsius * 9 / 5 + 32;',
    '}',
    '',
    '// BUG: this returns Celsius unchanged instead of converting back.',
    'export function toCelsius(fahrenheit) {',
    '  return fahrenheit;',
    '}',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# scratch\n\nA throwaway project used to verify the background worker.\n', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'verify@example.invalid'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Roma Verify'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['commit', '-q', '-m', 'scratch'], { cwd: root });
  return root;
}

async function waitFor(predicate, { timeoutMs = 300_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main() {
  // Same configuration path the server uses, so this verifies the deployment
  // as configured rather than some bespoke setup only this script has.
  const worker = createQwenCodeWorker({ env: loadWorkerConfigEnv() });
  const described = worker.describe();
  console.log(`\nQwen Code worker: ${described.available ? described.command : 'NOT AVAILABLE'} (${described.source ?? described.note})`);
  console.log(`Credential: ${described.credential} · model: ${described.model}`);
  if (!described.available) {
    console.error('\nCannot verify: the Qwen Code CLI was not found. Install it or set AGENT_WORKER_CMD.\n');
    process.exit(2);
  }
  if (described.credential !== 'configured') {
    console.error('\nCannot verify: AGENT_WORKER_API_KEY is not set. The worker runs with its own private QWEN_HOME and\ncannot borrow the developer\'s ~/.qwen login, so it has no way to authenticate.\n');
    process.exit(2);
  }

  const root = await makeScratchProject();
  const db = openDatabase({ memory: true });
  const taskStore = createTaskStore({ db });
  const engineeringMemory = createEngineeringMemory({ db });
  const dispatcher = createDispatcher({ taskStore, engineeringMemory, worker, timeoutMs: 8 * 60 * 1000 });
  const tasks = taskStore.forWorkspace(PRINCIPAL.workspaceId, PRINCIPAL.userId);
  const memory = engineeringMemory.forWorkspace(PRINCIPAL.workspaceId, PRINCIPAL.userId);
  const project = memory.createProject({ name: 'scratch', rootPath: root, defaultTestCmd: 'node --test' }).project;

  console.log(`Scratch project: ${root}\n`);

  // ── readonly ───────────────────────────────────────────────────────────────
  console.log('READONLY task');
  const readTask = tasks.create({
    goal: 'Read temperature.js and report what each exported function does, including any bug you find.',
    projectId: project.projectId,
    mode: 'readonly',
  }).task;
  dispatcher.dispatch(PRINCIPAL, { taskId: readTask.taskId });
  const readDone = await waitFor(() => ['completed', 'failed', 'cancelled'].includes(tasks.get(readTask.taskId).status));
  const finishedRead = tasks.get(readTask.taskId);

  check('the readonly task reached a terminal state', readDone, finishedRead.status);
  check('the readonly task completed', finishedRead.status === 'completed', finishedRead.error ?? '');
  check('the worker reported a real summary', Boolean(finishedRead.resultSummary?.length > 20), (finishedRead.resultSummary ?? '').slice(0, 120));
  check('the worker actually found the bug', /celsius|convert|unchanged|return[s]? .*fahrenheit/i.test(finishedRead.resultSummary ?? ''));

  const progress = finishedRead.progress ?? [];
  const sessionLine = progress.find((entry) => /Worker session started/.test(entry.message ?? ''));
  check('the CLI announced its session and tool surface', Boolean(sessionLine), sessionLine?.message ?? '');
  const toolCount = Number(/· (\d+) tools/.exec(sessionLine?.message ?? '')?.[1] ?? NaN);
  check(
    'the tool surface stayed inside the readonly allowlist',
    Number.isFinite(toolCount) && toolCount <= READONLY_TOOLS.length + 1,
    `${toolCount} tools offered, ${READONLY_TOOLS.length + 1} granted`,
  );
  check('progress was recorded without speaking', progress.some((entry) => entry.kind === 'progress'), `${progress.length} entries`);

  const learned = memory.list({ projectId: project.projectId });
  check('learnings landed in engineering memory', learned.length > 0, learned.map((entry) => `[${entry.kind}] ${entry.title}`).join('; ').slice(0, 160));
  check('nothing landed in personal memory', db.prepare('SELECT COUNT(*) AS n FROM memories').get().n === 0);

  const dirtyAfterRead = (await execFileAsync('git', ['status', '--porcelain'], { cwd: root })).stdout.trim();
  check('readonly mode changed no files', dirtyAfterRead === '', dirtyAfterRead.slice(0, 120));

  // ── write ──────────────────────────────────────────────────────────────────
  if (wantWrite) {
    console.log('\nWRITE task');
    const writeTask = tasks.create({
      goal: 'Fix the bug in toCelsius so it converts Fahrenheit to Celsius, then verify it by running node with a quick inline check.',
      projectId: project.projectId,
      mode: 'write',
    }).task;
    dispatcher.dispatch(PRINCIPAL, { taskId: writeTask.taskId });

    const asked = await waitFor(() => tasks.get(writeTask.taskId).status === 'awaiting_approval', { timeoutMs: 60_000 });
    check('write mode stopped and asked before changing anything', asked, tasks.get(writeTask.taskId).pendingRequest?.text ?? tasks.get(writeTask.taskId).status);
    if (asked) {
      dispatcher.respond(PRINCIPAL, { taskId: writeTask.taskId, approved: true });
      await waitFor(() => ['completed', 'failed', 'cancelled'].includes(tasks.get(writeTask.taskId).status));
      const finishedWrite = tasks.get(writeTask.taskId);
      check('the write task completed', finishedWrite.status === 'completed', finishedWrite.error ?? (finishedWrite.resultSummary ?? '').slice(0, 140));

      const dirtyAfterWrite = (await execFileAsync('git', ['status', '--porcelain'], { cwd: root })).stdout.trim();
      check('the wearer\'s working tree was left untouched', dirtyAfterWrite === '', dirtyAfterWrite.slice(0, 120));
      const worktrees = (await execFileAsync('git', ['worktree', 'list'], { cwd: root })).stdout.trim().split(/\r?\n/);
      check('no stale worktree was left behind', worktrees.length === 1, worktrees.join(' | ').slice(0, 160));
      check('the change came back as a reviewable patch', /patch/i.test(finishedWrite.resultSummary ?? ''), (finishedWrite.resultSummary ?? '').slice(0, 160));
    }
  } else {
    console.log('\n(write mode skipped — pass --write to verify it)');
  }

  db.close();
  await fs.rm(root, { recursive: true, force: true });

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:');
    for (const entry of failed) console.log(`  - ${entry.label}${entry.detail ? ` (${entry.detail})` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('\nVerification crashed:', error);
  process.exit(1);
});
