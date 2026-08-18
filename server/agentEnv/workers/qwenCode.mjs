// Real worker engine: the locally installed Qwen Code CLI, driven headless.
//
// Satisfies server/agentEnv/workers/adapter.mjs exactly like the mock does, so
// swapping AGENT_WORKER=mock → qwen changes nothing else in the system. All
// pure decisions (argv, environment, tool policy, event mapping) live in
// qwenProtocol.mjs; this file owns processes, git worktrees, and cancellation.
//
// Boundaries this file is responsible for holding:
//   - no shell anywhere (the brief is untrusted text; argv arrays only),
//   - an environment allowlist, so Roma's keys and DB path never cross over,
//   - a verified tool surface — the run is refused if the CLI offers the model
//     more authority than we granted,
//   - readonly means readonly: enforced by Qwen's plan mode removing the write
//     and shell tools from the registry, not by asking the model to behave,
//   - write mode touches an isolated git worktree only, after the wearer says
//     yes, and reports a patch — the wearer's working tree is never edited.

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveQwenCommand,
  buildWorkerEnv,
  buildQwenArgs,
  createQwenStreamParser,
  buildTerminalEvent,
  verifyToolSurface,
  READONLY_TOOLS,
  WRITE_TOOLS,
  SYSTEM_SETTINGS_OVERLAY,
  OUTPUT_DIRECTIVE,
} from './qwenProtocol.mjs';

const execFileAsync = promisify(execFile);
const MAX_STDERR_TAIL = 4000;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_DIFF_BYTES, windowsHide: true });
  return stdout;
}

async function isGitRepository(dir) {
  try {
    const out = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
    return out.trim() === 'true';
  } catch { return false; }
}

/**
 * Kill the worker and everything it started. `child.kill()` on Windows leaves
 * grandchildren (the model's own `npm test`, say) running after the wearer has
 * said "stop", which is exactly the case cancellation exists for.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

export function createQwenCodeWorker({
  env = process.env,
  resolve = resolveQwenCommand,
  maxResumes = 2,
  stateDir = path.join(os.tmpdir(), 'roma-agent-worker'),
} = {}) {
  const resolved = resolve({ env });
  const qwenHome = path.join(stateDir, 'qwen-home');
  let systemSettingsPath = null;

  /**
   * Write the settings overlay and create the worker's private config home.
   * Both are identical for every run, so this happens once.
   */
  async function ensureWorkerHome() {
    if (systemSettingsPath) return systemSettingsPath;
    await fs.mkdir(qwenHome, { recursive: true });
    const file = path.join(stateDir, 'qwen-system-settings.json');
    await fs.writeFile(file, JSON.stringify(SYSTEM_SETTINGS_OVERLAY, null, 2), 'utf8');
    systemSettingsPath = file;
    return file;
  }

  return {
    name: 'qwen',
    describe: () => ({
      engine: 'qwen-code',
      real: true,
      available: resolved.ok,
      command: resolved.ok ? resolved.command : null,
      source: resolved.source ?? null,
      // State, never the value — this is reported through an API and logged.
      credential: env.AGENT_WORKER_API_KEY?.trim() ? 'configured' : 'missing',
      model: env.AGENT_WORKER_MODEL?.trim() || 'qwen3-coder-plus',
      note: resolved.ok
        ? 'Qwen Code CLI, headless, private config home, tool surface restricted and verified per run'
        : resolved.reason,
    }),

    startTask({ brief, cwd, mode = 'readonly', timeoutMs = 20 * 60 * 1000, onEvent, approvalGate = null }) {
      let cancelled = false;
      let child = null;
      let worktree = null;
      let projectRoot = null;

      const emit = (event) => { if (!cancelled) onEvent(event); };

      /** One headless pass. Resolves with the parser summary + exit info. */
      function runPass({ prompt, workDir, resumeSessionId, stdin }) {
        return new Promise((resolvePass) => {
          const { args } = buildQwenArgs({ mode, timeoutMs, resumeSessionId, prompt });
          const parser = createQwenStreamParser({ onEvent: emit });

          child = spawn(resolved.command, [...resolved.baseArgs, ...args], {
            cwd: workDir,
            env: buildWorkerEnv(env, { systemSettingsPath, qwenHome }),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let stderrTail = '';
          let surfaceViolation = null;

          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            parser.push(chunk);
            if (!surfaceViolation) {
              const advertised = parser.summary().advertisedTools;
              if (advertised) {
                const extra = verifyToolSurface(advertised, mode === 'write' ? WRITE_TOOLS : READONLY_TOOLS);
                if (extra.length) {
                  surfaceViolation = extra;
                  killTree(child);
                }
              }
            }
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL);
          });

          child.on('error', (error) => {
            resolvePass({ summary: parser.summary(), exitCode: null, stderrTail: String(error?.message ?? error), surfaceViolation });
          });
          child.on('close', (code) => {
            parser.end();
            child = null;
            resolvePass({ summary: parser.summary(), exitCode: code, stderrTail, surfaceViolation });
          });

          // The brief goes in on stdin rather than argv: it can be long, and it
          // is user-derived text that has no business on a command line.
          child.stdin.on('error', () => { /* the child may exit before we finish writing */ });
          child.stdin.end(stdin ?? '');
        });
      }

      const finished = (async () => {
        if (!resolved.ok) { emit({ type: 'error', message: resolved.reason }); return { cancelled: false }; }
        if (!cwd) { emit({ type: 'error', message: 'This task has no registered project, so the worker has nowhere to run.' }); return { cancelled: false }; }

        await ensureWorkerHome();
        let workDir = cwd;

        // ── write mode: consent first, then an isolated worktree ─────────────
        if (mode === 'write') {
          projectRoot = cwd;
          if (!(await isGitRepository(projectRoot))) {
            emit({ type: 'error', message: 'Write mode needs a git repository so changes can be isolated and reviewed. This project is not one.' });
            return { cancelled: false };
          }
          emit({
            type: 'approval_request',
            request: 'This task needs to change files. May I go ahead?',
            detail: 'I will work in an isolated copy of the project and give you a patch to review — your working files are not touched.',
          });
          const decision = await approvalGate?.();
          if (cancelled) return { cancelled: true };
          const approved = decision === true || decision?.approved === true;
          if (!approved) { emit({ type: 'error', message: 'Not approved — nothing was changed.' }); return { cancelled: false }; }

          await fs.mkdir(stateDir, { recursive: true });
          worktree = path.join(stateDir, `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
          try {
            await runGit(['worktree', 'add', '--detach', worktree, 'HEAD'], projectRoot);
          } catch (error) {
            emit({ type: 'error', message: `Could not create an isolated copy of the project: ${String(error?.message ?? error).slice(0, 160)}` });
            worktree = null;
            return { cancelled: false };
          }
          workDir = worktree;
          emit({ type: 'log', message: 'Working in an isolated copy of the project.' });
        }

        // ── run, resuming if the worker came back with a question ────────────
        let pass = await runPass({ prompt: OUTPUT_DIRECTIVE, workDir, resumeSessionId: null, stdin: brief });
        let terminal = pass.surfaceViolation
          ? { type: 'error', message: `Refused to run: the worker was offered tools it must not have (${pass.surfaceViolation.slice(0, 4).join(', ')}).` }
          : buildTerminalEvent({ summary: pass.summary, exitCode: pass.exitCode, cancelled, stderrTail: pass.stderrTail });

        for (let resumes = 0; terminal?.type === 'question' && resumes < maxResumes && !cancelled; resumes += 1) {
          emit(terminal);
          const decision = await approvalGate?.();
          if (cancelled) break;
          const answered = decision === true || decision?.approved === true;
          const reply = typeof decision?.response === 'string' ? decision.response.trim() : '';
          if (!answered) { terminal = { type: 'error', message: 'Stopped without an answer to the worker\'s question.' }; break; }
          const sessionId = pass.summary.sessionId;
          if (!sessionId) { terminal = { type: 'error', message: 'The worker could not be resumed (no session to return to).' }; break; }
          pass = await runPass({
            prompt: `${reply || 'Continue with your best judgement.'}\n\n${OUTPUT_DIRECTIVE}`,
            workDir,
            resumeSessionId: sessionId,
            stdin: '',
          });
          terminal = buildTerminalEvent({ summary: pass.summary, exitCode: pass.exitCode, cancelled, stderrTail: pass.stderrTail });
        }

        if (cancelled) return { cancelled: true };

        // ── write mode: turn the worktree into a reviewable patch ────────────
        if (worktree && terminal?.type === 'result') {
          try {
            await runGit(['add', '-A'], worktree);
            const names = (await runGit(['diff', '--cached', '--name-only'], worktree)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (names.length) {
              const patch = await runGit(['diff', '--cached', '--binary'], worktree);
              const patchPath = path.join(stateDir, `${path.basename(worktree)}.patch`);
              await fs.writeFile(patchPath, patch, 'utf8');
              terminal.filesChanged = names.slice(0, 50);
              terminal.artifacts = [patchPath];
              terminal.summary = `${terminal.summary} Changes are staged as a patch for review (${names.length} file${names.length === 1 ? '' : 's'}); nothing in your working tree was modified.`;
            } else {
              terminal.summary = `${terminal.summary} No files ended up changed.`;
            }
          } catch (error) {
            emit({ type: 'log', message: `Could not capture the diff: ${String(error?.message ?? error).slice(0, 200)}` });
          }
        }

        if (terminal) emit(terminal);
        return { cancelled: false };
      })()
        .catch((error) => {
          emit({ type: 'error', message: `The background worker failed: ${String(error?.message ?? error).slice(0, 250)}` });
          return { cancelled };
        })
        .finally(async () => {
          // Always give the worktree back: a stale one would leave entries in
          // the wearer's real repository.
          if (worktree && projectRoot) {
            try { await runGit(['worktree', 'remove', '--force', worktree], projectRoot); } catch { /* best effort */ }
            try { await runGit(['worktree', 'prune'], projectRoot); } catch { /* best effort */ }
          }
        });

      return {
        cancel() {
          cancelled = true;
          killTree(child);
        },
        finished,
      };
    },
  };
}
