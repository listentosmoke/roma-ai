// Pure protocol layer for the Qwen Code worker.
//
// Everything here is a pure function over strings and plain objects: command
// resolution, the child environment, the structured-result schema, and the
// stream-json parser. Keeping it free of `spawn` is deliberate — the parts
// most likely to be wrong (event mapping, secret leakage, partial lines) are
// then testable without a network call or a subprocess.
//
// server/agentEnv/workers/qwenCode.mjs does the process and git-worktree work
// and delegates every decision it can to this file.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { ENG_MEMORY_KINDS } from '../engineeringMemory.mjs';

const MAX_PROGRESS = 300;

// ── child environment ────────────────────────────────────────────────────────
//
// ALLOWLIST, not a denylist. A denylist has to predict every secret Roma will
// ever hold; an allowlist only has to name what a CLI needs to run. Qwen Code
// reads its own credentials from ~/.qwen/settings.json, so USERPROFILE/HOME is
// all the auth it needs from us — Roma's Deepgram/Groq/TTS/biometric keys and
// its database path never cross into the worker process.
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'OS',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PROGRAMW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
]);

// Belt-and-braces assertion target: nothing matching this may reach a worker.
// The allowlist above already excludes it; this exists so a future edit that
// widens the allowlist fails a test instead of leaking quietly.
export const SECRET_ENV_PATTERN = /(GROQ|DEEPGRAM|AURA|TTS|BIOMETRIC|ENCRYPTION|VOICE_?ID|ROMA_|AUTH_|SESSION_|WEBHOOK|_KEY|APIKEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

// The ONE credential a worker is allowed to hold: its own model provider's.
// It is Roma's to hand over (configured as AGENT_WORKER_API_KEY) rather than
// something the CLI picks up from whoever last logged in on this machine —
// so the worker's identity is deployment configuration, rotatable in one
// place, and a task can never quietly bill or impersonate the developer's
// personal account.
export const WORKER_CREDENTIAL_KEYS = new Set(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);

/**
 * Build the environment handed to the worker process.
 *
 * @param {object} sourceEnv typically process.env
 * @param {object} options
 * @param {string|null} options.systemSettingsPath overlay that disables Computer Use
 * @param {string|null} options.qwenHome private config dir for the worker
 * @returns {Record<string,string>}
 */
export function buildWorkerEnv(sourceEnv = {}, { systemSettingsPath = null, qwenHome = null } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    if (!ENV_ALLOWLIST.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  // Unattended run: no colour codes to strip out of the event stream, and no
  // TTY heuristics. Retry-forever is deliberately NOT enabled — a background
  // task must die inside its wall clock, not wait out a provider outage.
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  if (systemSettingsPath) env.QWEN_CODE_SYSTEM_SETTINGS_PATH = systemSettingsPath;

  // A private QWEN_HOME means the worker cannot reach the developer's own
  // ~/.qwen — no inherited credentials, no personal extensions, skills, MCP
  // servers, or memories. It runs on exactly what Roma gives it, which is
  // also what makes "the configured key works" an honest claim rather than a
  // run that quietly succeeded on somebody's cached login.
  if (qwenHome) env.QWEN_HOME = qwenHome;

  const apiKey = sourceEnv.AGENT_WORKER_API_KEY?.trim();
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = sourceEnv.AGENT_WORKER_API_BASE?.trim() || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    env.OPENAI_MODEL = sourceEnv.AGENT_WORKER_MODEL?.trim() || 'qwen3-coder-plus';
  }
  return env;
}

/**
 * Roma secrets that leaked into a worker environment. The worker's own
 * provider credential is excluded by name — it is meant to be there; anything
 * else matching the pattern is a bug.
 * @returns {string[]}
 */
export function leakedSecretKeys(env = {}) {
  return Object.keys(env).filter((key) => !WORKER_CREDENTIAL_KEYS.has(key) && SECRET_ENV_PATTERN.test(key));
}

// ── command resolution ───────────────────────────────────────────────────────

/**
 * Find how to launch Qwen Code without going through a shell.
 *
 * Windows `.cmd` shims can only be spawned with `shell: true`, which would put
 * the task brief on a command line an attacker could inject into. So the
 * standalone install is launched as `node lib/cli-entry.js` directly, with an
 * argv array and no shell anywhere.
 */
export function resolveQwenCommand({ env = {}, execPath = process.execPath, exists = existsSync } = {}) {
  const override = env.AGENT_WORKER_CMD?.trim();
  if (override) {
    if (/\.(mjs|js|cjs)$/i.test(override)) {
      if (!exists(override)) return { ok: false, reason: `AGENT_WORKER_CMD points at a missing file: ${override}` };
      return { ok: true, command: env.AGENT_WORKER_NODE?.trim() || execPath, baseArgs: [override], source: 'AGENT_WORKER_CMD (script)' };
    }
    if (/\.(cmd|bat)$/i.test(override)) {
      return { ok: false, reason: 'AGENT_WORKER_CMD must not be a .cmd/.bat shim (it would require a shell); point it at lib/cli-entry.js instead.' };
    }
    return { ok: true, command: override, baseArgs: [], source: 'AGENT_WORKER_CMD' };
  }

  // Standalone installer layout: <LOCALAPPDATA>/qwen-code/qwen-code/{node,lib}
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
  if (localAppData) {
    const root = path.join(localAppData, 'qwen-code', 'qwen-code');
    const entry = path.join(root, 'lib', 'cli-entry.js');
    if (exists(entry)) {
      const bundledNode = path.join(root, 'node', 'node.exe');
      return { ok: true, command: exists(bundledNode) ? bundledNode : execPath, baseArgs: [entry], source: 'standalone install' };
    }
  }

  // POSIX/global npm install: a real executable with a shebang, no shell needed.
  if (process.platform !== 'win32') return { ok: true, command: 'qwen', baseArgs: [], source: 'PATH' };
  return { ok: false, reason: 'Qwen Code was not found. Install it, or set AGENT_WORKER_CMD to its lib/cli-entry.js.' };
}

// ── tool surface ─────────────────────────────────────────────────────────────
//
// Qwen Code ships far more authority than a background engineering worker
// should ever hold: out of the box a run is offered `computer_use__click` /
// `type_text` (the wearer's actual desktop), `send_message`, `cron_create`,
// `web_fetch`, and subagent spawning. Roma's contract says the worker gets
// coding, inspection, testing and debugging — and nothing else, least of all a
// second route to the wearer that bypasses the Speech Gate.
//
// Three independent mechanisms, because any one of them can be version-fragile:
//   1. `--core-tools`   allowlist for built-ins,
//   2. `--exclude-tools` denylist (wins over everything, per Qwen's docs),
//   3. a system-settings overlay that switches Computer Use off at the source,
// and then `verifyToolSurface()` CHECKS the tool list the CLI actually
// advertises. If a future Qwen release ignores all three, the run is refused
// rather than silently over-privileged.

export const READONLY_TOOLS = ['read_file', 'list_directory', 'grep_search', 'glob', 'todo_write'];
// `edit` is what this CLI calls its in-place editor; `replace` is the older
// name and is listed so a downgrade still works. Both were guesses once — the
// verification below is what turned the wrong guess into a refused run instead
// of a silently over-privileged one.
export const WRITE_TOOLS = [...READONLY_TOOLS, 'write_file', 'edit', 'replace', 'run_shell_command'];

// Named individually: `--exclude-tools computer_use` (a server-level pattern)
// was measured to have NO effect, which is why mechanism 3 exists.
export const DENIED_TOOLS = [
  'send_message', 'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup',
  'web_fetch', 'agent', 'create_sub_session', 'task_stop', 'skill',
  'read_mcp_resource', 'record_artifact', 'enter_worktree', 'exit_worktree',
  'tool_search',
];

// Written to disk by the worker and pointed at with QWEN_CODE_SYSTEM_SETTINGS_PATH.
// System settings outrank user settings in Qwen's layering, so this disables
// Computer Use for the worker WITHOUT touching the user's own ~/.qwen config —
// their credentials and model providers still load normally.
export const SYSTEM_SETTINGS_OVERLAY = {
  tools: { computerUse: { enabled: false } },
};

/**
 * MCP servers the worker may reach, declared in Roma's own config rather than
 * inherited from the user's ~/.qwen. That distinction is the point: the worker
 * runs against a private QWEN_HOME precisely so it cannot pick up whatever the
 * user happens to have connected. Connecting a tool to Roma is a deliberate
 * act, recorded in one place.
 *
 * Declared as `AGENT_WORKER_MCP` in .env, as JSON:
 *
 *   AGENT_WORKER_MCP={"github":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"…"}}}
 *
 * Malformed JSON yields no servers rather than a crashed dispatch — a broken
 * connector must not take the whole worker down.
 */
export function parseMcpServers(raw) {
  if (!raw || typeof raw !== 'string') return { servers: {}, errors: [] };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { return { servers: {}, errors: [`AGENT_WORKER_MCP is not valid JSON: ${error.message}`] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { servers: {}, errors: ['AGENT_WORKER_MCP must be a JSON object of server name -> config'] };

  const servers = {};
  const errors = [];
  for (const [name, config] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { errors.push(`ignored MCP server "${name}": names must be alphanumeric`); continue; }
    if (!config || typeof config !== 'object') { errors.push(`ignored MCP server "${name}": config must be an object`); continue; }
    // Either a spawned command or a URL — the two shapes Qwen Code accepts.
    const hasCommand = typeof config.command === 'string' && config.command.trim();
    const hasUrl = typeof config.url === 'string' || typeof config.httpUrl === 'string';
    if (!hasCommand && !hasUrl) { errors.push(`ignored MCP server "${name}": needs a command or a url`); continue; }
    servers[name] = {
      ...(hasCommand ? { command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [] } : {}),
      ...(typeof config.url === 'string' ? { url: config.url } : {}),
      ...(typeof config.httpUrl === 'string' ? { httpUrl: config.httpUrl } : {}),
      ...(config.env && typeof config.env === 'object' ? { env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, String(v)])) } : {}),
      ...(Number.isFinite(config.timeout) ? { timeout: config.timeout } : {}),
      // Roma decides what a connector may do, not the connector.
      ...(Array.isArray(config.includeTools) ? { includeTools: config.includeTools.map(String) } : {}),
      ...(Array.isArray(config.excludeTools) ? { excludeTools: config.excludeTools.map(String) } : {}),
      trust: false,
    };
  }
  return { servers, errors };
}

/**
 * The system settings the worker actually runs with: the standing overlay plus
 * whatever MCP servers are configured. `trust: false` on every server is
 * deliberate — an MCP tool call goes through the same approval path as any
 * other write, so connecting a tool never silently widens what runs unattended.
 */
export function buildSystemSettings({ mcpServers = {} } = {}) {
  const names = Object.keys(mcpServers);
  if (!names.length) return { ...SYSTEM_SETTINGS_OVERLAY };
  return { ...SYSTEM_SETTINGS_OVERLAY, mcpServers };
}

/**
 * MCP tools arrive with names Roma cannot know in advance, so the tool-surface
 * guard has to allow them by SHAPE. Qwen namespaces them as `server__tool`,
 * so only names prefixed by a server that was actually configured are allowed
 * — an unconfigured server's tools are still refused.
 */
export function mcpToolPrefixes(mcpServers = {}) {
  return Object.keys(mcpServers).map((name) => `${name}__`);
}

/**
 * Tools the CLI advertised that we never granted. Empty means the run is safe
 * to start.
 *
 * `mcpPrefixes` covers tools whose names cannot be known ahead of time: an MCP
 * server's tools are namespaced `server__tool`, so a configured server's tools
 * pass and an unconfigured one's do not. Everything else must be named
 * exactly, which is what caught the wrong `replace`/`edit` guess.
 */
export function verifyToolSurface(advertised = [], allowed = [], { mcpPrefixes = [] } = {}) {
  const permitted = new Set([...allowed, 'structured_output']);
  return advertised.filter((tool) => !permitted.has(tool) && !mcpPrefixes.some((prefix) => tool.startsWith(prefix)));
}

/**
 * Full argv for one headless run (after the resolved command + base args).
 * `--approval-mode plan` is the real readonly bound: Qwen removes `write_file`
 * and `run_shell_command` from the registry entirely, so readonly is enforced
 * by the tool set rather than by asking the model nicely.
 */
export function buildQwenArgs({
  mode = 'readonly',
  timeoutMs = 20 * 60 * 1000,
  maxTurns = 50,
  maxToolCalls = 100,
  resumeSessionId = null,
  prompt = OUTPUT_DIRECTIVE,
} = {}) {
  const write = mode === 'write';
  // Leave the dispatcher's hard kill as the backstop, not the first line of
  // defence: Qwen should stop itself with a reportable result first.
  const wallTimeSeconds = Math.max(60, Math.floor(timeoutMs / 1000) - 30);
  const args = [
    '--prompt', prompt,
    '--approval-mode', write ? 'yolo' : 'plan',
    '--output-format', 'stream-json',
    '--core-tools', (write ? WRITE_TOOLS : READONLY_TOOLS).join(','),
    '--exclude-tools', DENIED_TOOLS.join(','),
    '--max-wall-time', String(wallTimeSeconds),
    '--max-session-turns', String(maxTurns),
    '--max-tool-calls', String(maxToolCalls),
    '--json-schema', JSON.stringify(RESULT_SCHEMA),
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return { args, wallTimeSeconds };
}

// ── structured result contract ───────────────────────────────────────────────
//
// `--json-schema` registers a synthetic `structured_output` tool the model must
// call to finish. That turns "did the agent actually report something usable?"
// into a validated contract instead of prose we have to guess at, and it maps
// one-to-one onto the adapter's `result` event.
export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three factual sentences: what you did and what you found.' },
    files_changed: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you modified. Empty in readonly mode.' },
    tests_run: { type: 'string', description: 'The test command you ran and its outcome, or an empty string if you ran none.' },
    blocked_question: { type: 'string', description: 'If you could not finish without information only the user has, the ONE question to ask. Otherwise an empty string.' },
    learnings: {
      type: 'array',
      description: 'Durable facts about this project worth remembering for future tasks. Omit anything obvious or one-off.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...ENG_MEMORY_KINDS] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['kind', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary'],
  additionalProperties: false,
};

/** The run-specific instruction appended after the brief (which arrives on stdin). */
export const OUTPUT_DIRECTIVE = [
  'Finish by calling the structured_output tool with your report. Do NOT answer in prose —',
  'a plain-text answer is discarded. If you were blocked, still call structured_output and put',
  'the single question you need answered in blocked_question.',
].join(' ');

// ── stream-json parsing ──────────────────────────────────────────────────────

function bounded(value, max = MAX_PROGRESS) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, human-readable line for one tool call: "read_file · adder.js". */
export function describeToolUse(name, input) {
  const target = input && typeof input === 'object'
    ? input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.absolute_path ?? null
    : null;
  if (!target || typeof target !== 'string') return bounded(name, 120);
  const short = /[\\/]/.test(target) && !/\s/.test(target) ? path.basename(target) : target;
  return bounded(`${name} · ${short}`, 160);
}

/**
 * Line-delimited JSON parser for `--output-format stream-json`.
 *
 * Emits adapter events through `onEvent`. It never emits `result` or `error`
 * itself — the caller decides that once the process has also exited, because a
 * clean-looking final message plus a non-zero exit code is still a failure.
 * The terminal outcome is exposed on `summary()`.
 */
export function createQwenStreamParser({ onEvent = () => {} } = {}) {
  let buffer = '';
  const state = {
    sessionId: null,
    model: null,
    // null until the CLI announces its tool registry; the caller checks this
    // against what we granted and aborts the run if it is wider.
    advertisedTools: null,
    permissionMode: null,
    lastText: '',
    structuredResult: null,
    resultSubtype: null,
    resultError: null,
    isError: false,
    permissionDenials: [],
    sawResult: false,
    toolCalls: 0,
  };

  function handle(message) {
    switch (message?.type) {
      case 'system':
        if (message.subtype === 'init') {
          state.sessionId = message.session_id ?? null;
          state.model = message.model ?? null;
          state.advertisedTools = Array.isArray(message.tools) ? message.tools : [];
          state.permissionMode = message.permission_mode ?? null;
          onEvent({ type: 'log', message: `Worker session started · model ${state.model ?? 'unknown'} · mode ${state.permissionMode ?? 'unknown'} · ${state.advertisedTools.length} tools.` });
        }
        break;
      case 'assistant':
        for (const block of message.message?.content ?? []) {
          // `thinking` blocks are the model's private reasoning: never stored,
          // never shown, never spoken.
          if (block?.type === 'tool_use') {
            if (block.name === 'structured_output') continue; // the terminal contract, not work
            state.toolCalls += 1;
            onEvent({ type: 'progress', message: describeToolUse(block.name, block.input) });
          } else if (block?.type === 'text' && bounded(block.text)) {
            state.lastText = bounded(block.text, 2000);
            onEvent({ type: 'log', message: bounded(block.text) });
          }
        }
        break;
      case 'user':
        for (const block of message.message?.content ?? []) {
          if (block?.type === 'tool_result' && block.is_error) {
            onEvent({ type: 'log', message: `Tool failed: ${bounded(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))}` });
          }
        }
        break;
      case 'result':
        state.sawResult = true;
        state.resultSubtype = message.subtype ?? null;
        state.isError = message.is_error === true;
        state.structuredResult = message.structured_result ?? null;
        state.resultError = bounded(message.error?.message, 500) || null;
        state.permissionDenials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
        if (state.permissionDenials.length) {
          onEvent({ type: 'log', message: `The worker was denied ${state.permissionDenials.length} action(s) by its permission mode.` });
        }
        break;
      default:
        break;
    }
  }

  function consume(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); } catch { return; } // non-JSON noise is ignored, not trusted
    handle(message);
  }

  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer) { consume(buffer); buffer = ''; }
    },
    summary: () => ({ ...state }),
  };
}

/**
 * Turn a finished run into the single terminal adapter event.
 *
 * The one forgiving case: Qwen fails a run outright when the model answers in
 * prose instead of calling `structured_output`. The work usually happened —
 * only the reporting format is wrong — so the prose becomes the summary and
 * the task completes, flagged. Every other failure stays a failure; a worker
 * that crashed is never dressed up as a success.
 */
export function buildTerminalEvent({ summary, exitCode, cancelled = false, stderrTail = '' }) {
  if (cancelled) return null;
  const schemaMiss = summary.isError && /structured_output/i.test(summary.resultError ?? '');

  if (summary.structuredResult && !summary.isError) {
    const payload = summary.structuredResult;
    const question = bounded(payload.blocked_question, 400);
    if (question) return { type: 'question', question };
    return {
      type: 'result',
      summary: bounded(payload.summary, 2000) || 'The worker finished without describing what it did.',
      filesChanged: Array.isArray(payload.files_changed) ? payload.files_changed : [],
      testsRun: bounded(payload.tests_run, 300) || null,
      learnings: Array.isArray(payload.learnings) ? payload.learnings : [],
    };
  }

  if (schemaMiss && summary.lastText) {
    return {
      type: 'result',
      summary: `${bounded(summary.lastText, 1800)} (Reported as prose; the worker skipped its structured report.)`,
      filesChanged: [],
      testsRun: null,
      learnings: [],
    };
  }

  const detail = summary.resultError || bounded(stderrTail, 300) || (exitCode === null ? 'the worker stopped unexpectedly' : `exit code ${exitCode}`);
  return { type: 'error', message: bounded(`The background worker failed: ${detail}`, 300) };
}
