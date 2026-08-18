// Qwen Code worker — protocol-level tests.
//
// Everything here runs against server/agentEnv/workers/qwenProtocol.mjs, which
// is deliberately free of `spawn`: the parts most likely to be wrong (secret
// leakage into the child environment, tool authority, partial stream lines,
// and turning a failed run into a "result") are all pure functions, so they are
// tested without a subprocess, a network call, or a paid model run.
//
// The live end-to-end check against the real CLI is scripts/verify-qwen-worker.mjs,
// which is opt-in because it costs money and needs credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildWorkerEnv,
  leakedSecretKeys,
  resolveQwenCommand,
  buildQwenArgs,
  verifyToolSurface,
  createQwenStreamParser,
  buildTerminalEvent,
  describeToolUse,
  READONLY_TOOLS,
  WRITE_TOOLS,
  DENIED_TOOLS,
  RESULT_SCHEMA,
} from '../server/agentEnv/workers/qwenProtocol.mjs';

// ── child environment ────────────────────────────────────────────────────────

test('the worker environment carries no Roma secrets, only what a CLI needs to run', () => {
  const env = buildWorkerEnv({
    PATH: '/usr/bin',
    USERPROFILE: 'C:\\Users\\someone',
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
    // Everything below is Roma's and must not cross the boundary.
    GROQ_API_KEY: 'gsk_live',
    DEEPGRAM_API_KEY: 'dg_live',
    TTS_API_KEY: 'tts_live',
    BIOMETRIC_ENCRYPTION_KEY: 'aes-key',
    ROMA_DB_PATH: 'C:\\Users\\someone\\roma.db',
    AUTH_MODE: 'development',
    SESSION_SECRET: 'shhh',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.USERPROFILE, 'C:\\Users\\someone');
  assert.deepEqual(leakedSecretKeys(env), []);
  for (const forbidden of ['GROQ_API_KEY', 'DEEPGRAM_API_KEY', 'TTS_API_KEY', 'BIOMETRIC_ENCRYPTION_KEY', 'ROMA_DB_PATH', 'AUTH_MODE', 'SESSION_SECRET']) {
    assert.equal(env[forbidden], undefined, `${forbidden} must not reach the worker`);
  }
});

test('the environment is an allowlist: an unknown variable is dropped even when it looks harmless', () => {
  const env = buildWorkerEnv({ PATH: '/usr/bin', SOME_FUTURE_ROMA_THING: 'value' });
  assert.equal(env.SOME_FUTURE_ROMA_THING, undefined);
});

test('unattended runs get no colour, no TTY guessing, and no retry-forever', () => {
  const env = buildWorkerEnv({ PATH: '/usr/bin' });
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
  // Retry-forever would let a task outlive its wall clock waiting on a provider.
  assert.equal(env.QWEN_CODE_UNATTENDED_RETRY, undefined);
});

test('the system-settings overlay is passed by path so the user config is never edited', () => {
  const env = buildWorkerEnv({ PATH: '/usr/bin' }, { systemSettingsPath: '/tmp/roma/qwen-system-settings.json' });
  assert.equal(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, '/tmp/roma/qwen-system-settings.json');
});

test('the worker gets a private config home, so it cannot borrow the developer\'s login', () => {
  const env = buildWorkerEnv({ PATH: '/usr/bin', USERPROFILE: 'C:\\Users\\someone' }, { qwenHome: 'C:\\temp\\roma-agent-worker\\qwen-home' });
  assert.equal(env.QWEN_HOME, 'C:\\temp\\roma-agent-worker\\qwen-home');
});

test('the worker carries its OWN provider credential, configured by Roma', () => {
  const env = buildWorkerEnv({
    PATH: '/usr/bin',
    AGENT_WORKER_API_KEY: 'worker-key',
    AGENT_WORKER_API_BASE: 'https://example.invalid/v1',
    AGENT_WORKER_MODEL: 'some-model',
  });
  assert.equal(env.OPENAI_API_KEY, 'worker-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://example.invalid/v1');
  assert.equal(env.OPENAI_MODEL, 'some-model');
  // That one credential is expected; nothing else secret may ride along.
  assert.deepEqual(leakedSecretKeys(env), []);
});

test('no configured credential means no credential — never a silent fallback to whoever is logged in', () => {
  const env = buildWorkerEnv({ PATH: '/usr/bin', AGENT_WORKER_API_KEY: '   ' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

test('config sourced from .env still cannot smuggle Roma keys through to the worker', () => {
  // loadWorkerConfigEnv() merges the whole .env file, which holds the Deepgram
  // and Groq keys — the allowlist is what keeps them out of the child.
  const env = buildWorkerEnv({
    PATH: '/usr/bin',
    VITE_DEEPGRAM_API_KEY: 'dg_live',
    VITE_GROQ_API_KEY: 'gsk_live',
    AGENT_WORKER_API_KEY: 'worker-key',
  });
  assert.equal(env.VITE_DEEPGRAM_API_KEY, undefined);
  assert.equal(env.VITE_GROQ_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, 'worker-key');
  assert.deepEqual(leakedSecretKeys(env), []);
});

// ── command resolution ───────────────────────────────────────────────────────

test('a .cmd shim is refused, because launching it would require a shell', () => {
  const result = resolveQwenCommand({ env: { AGENT_WORKER_CMD: 'C:\\qwen\\bin\\qwen.cmd' }, exists: () => true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /shell/i);
});

test('an explicit script override runs under node with an argv array', () => {
  const result = resolveQwenCommand({ env: { AGENT_WORKER_CMD: '/opt/qwen/cli-entry.js' }, execPath: '/usr/bin/node', exists: () => true });
  assert.equal(result.ok, true);
  assert.equal(result.command, '/usr/bin/node');
  assert.deepEqual(result.baseArgs, ['/opt/qwen/cli-entry.js']);
});

test('a missing override is reported rather than silently falling back', () => {
  const result = resolveQwenCommand({ env: { AGENT_WORKER_CMD: '/nope/cli-entry.js' }, exists: () => false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing file/i);
});

test('the standalone install is found through LOCALAPPDATA and uses its bundled node', () => {
  const localAppData = 'C:\\Users\\someone\\AppData\\Local';
  const entry = path.join(localAppData, 'qwen-code', 'qwen-code', 'lib', 'cli-entry.js');
  const bundledNode = path.join(localAppData, 'qwen-code', 'qwen-code', 'node', 'node.exe');
  const result = resolveQwenCommand({ env: { LOCALAPPDATA: localAppData }, exists: (p) => p === entry || p === bundledNode });
  assert.equal(result.ok, true);
  assert.equal(result.command, bundledNode);
  assert.deepEqual(result.baseArgs, [entry]);
});

// ── tool authority ───────────────────────────────────────────────────────────

test('readonly mode grants no way to write a file or run a command', () => {
  const { args } = buildQwenArgs({ mode: 'readonly' });
  const core = args[args.indexOf('--core-tools') + 1].split(',');
  assert.deepEqual(core, READONLY_TOOLS);
  for (const forbidden of ['write_file', 'edit', 'replace', 'run_shell_command']) {
    assert.ok(!core.includes(forbidden), `${forbidden} must not be granted in readonly mode`);
  }
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'plan');
});

test('write mode grants the editing tools and auto-approves, because it only ever runs in an isolated worktree', () => {
  const { args } = buildQwenArgs({ mode: 'write' });
  const core = args[args.indexOf('--core-tools') + 1].split(',');
  assert.deepEqual(core, WRITE_TOOLS);
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo');
});

test('the routes back to the wearer and out to the world are denied in both modes', () => {
  for (const mode of ['readonly', 'write']) {
    const { args } = buildQwenArgs({ mode });
    const denied = args[args.indexOf('--exclude-tools') + 1].split(',');
    // send_message would be a second channel to the wearer that bypasses the
    // Speech Gate; cron_* would outlive the task; agent/create_sub_session
    // would escape the tool-call budget.
    for (const tool of ['send_message', 'cron_create', 'agent', 'create_sub_session', 'web_fetch']) {
      assert.ok(denied.includes(tool), `${tool} must be denied in ${mode} mode`);
    }
    assert.deepEqual(denied, DENIED_TOOLS);
  }
});

test('the worker stops itself before the dispatcher has to kill it', () => {
  const timeoutMs = 10 * 60 * 1000;
  const { args, wallTimeSeconds } = buildQwenArgs({ mode: 'readonly', timeoutMs });
  assert.ok(wallTimeSeconds < timeoutMs / 1000, 'the worker wall clock must expire before the dispatcher timeout');
  assert.equal(args[args.indexOf('--max-wall-time') + 1], String(wallTimeSeconds));
  assert.ok(args.includes('--max-tool-calls'));
  assert.ok(args.includes('--max-session-turns'));
});

test('a resumed run points at the session it is continuing', () => {
  const { args } = buildQwenArgs({ mode: 'readonly', resumeSessionId: 'session-42' });
  assert.equal(args[args.indexOf('--resume') + 1], 'session-42');
  assert.ok(!buildQwenArgs({ mode: 'readonly' }).args.includes('--resume'));
});

test('the result schema only admits learning kinds engineering memory can store', () => {
  const kinds = RESULT_SCHEMA.properties.learnings.items.properties.kind.enum;
  assert.ok(kinds.includes('known_bug'));
  assert.ok(kinds.includes('failed_approach'));
  assert.equal(RESULT_SCHEMA.additionalProperties, false);
});

test('the advertised tool surface is checked, not assumed', () => {
  // Measured reality: Qwen offers desktop control and messaging by default.
  const advertised = ['read_file', 'glob', 'structured_output', 'computer_use__click', 'send_message'];
  const violations = verifyToolSurface(advertised, READONLY_TOOLS);
  assert.deepEqual(violations, ['computer_use__click', 'send_message']);
  assert.deepEqual(verifyToolSurface(['read_file', 'structured_output'], READONLY_TOOLS), []);
});

// ── stream parsing ───────────────────────────────────────────────────────────

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'qwen3.6-plus', permission_mode: 'plan', tools: ['read_file', 'glob', 'structured_output'] };

function parseAll(lines, { chunkSize = 0 } = {}) {
  const events = [];
  const parser = createQwenStreamParser({ onEvent: (event) => events.push(event) });
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  if (chunkSize) {
    for (let i = 0; i < text.length; i += chunkSize) parser.push(text.slice(i, i + chunkSize));
  } else {
    parser.push(text);
  }
  parser.end();
  return { events, summary: parser.summary() };
}

test('the session announcement is captured and the tool list recorded', () => {
  const { events, summary } = parseAll([INIT]);
  assert.equal(summary.sessionId, 'sess-1');
  assert.deepEqual(summary.advertisedTools, ['read_file', 'glob', 'structured_output']);
  assert.equal(events[0].type, 'log');
  assert.match(events[0].message, /qwen3\.6-plus/);
});

test('a tool call becomes one readable progress line', () => {
  const { events } = parseAll([
    INIT,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read_file', input: { file_path: 'C:\\proj\\src\\audio.js' } }] } },
  ]);
  const progress = events.filter((event) => event.type === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].message, 'read_file · audio.js');
});

test("the model's private reasoning is never recorded", () => {
  const { events } = parseAll([
    INIT,
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Maybe the user is hiding something.' }] } },
  ]);
  assert.ok(!events.some((event) => JSON.stringify(event).includes('hiding something')));
});

test('the terminal structured_output call is not reported as work', () => {
  const { events } = parseAll([
    INIT,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'structured_output', input: { summary: 'done' } }] } },
  ]);
  assert.equal(events.filter((event) => event.type === 'progress').length, 0);
});

test('a failing tool is logged, never spoken as progress', () => {
  const { events } = parseAll([
    INIT,
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] } },
  ]);
  const logs = events.filter((event) => event.type === 'log');
  assert.ok(logs.some((event) => /Tool failed: ENOENT/.test(event.message)));
  assert.equal(events.filter((event) => event.type === 'progress').length, 0);
});

test('events split across chunk boundaries still parse', () => {
  const messages = [
    INIT,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'glob', input: { pattern: '**/*.js' } }] } },
    { type: 'result', subtype: 'success', is_error: false, structured_result: { summary: 'ok' } },
  ];
  const whole = parseAll(messages);
  const chunked = parseAll(messages, { chunkSize: 7 });
  assert.deepEqual(chunked.events, whole.events);
  assert.equal(chunked.summary.structuredResult.summary, 'ok');
});

test('non-JSON noise on stdout is ignored rather than trusted', () => {
  const events = [];
  const parser = createQwenStreamParser({ onEvent: (event) => events.push(event) });
  parser.push('warning: something\n');
  parser.push(`${JSON.stringify(INIT)}\n`);
  parser.end();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'log');
});

test('a long path is shortened but a command is kept readable', () => {
  assert.equal(describeToolUse('read_file', { file_path: '/a/b/c/deep/file.js' }), 'read_file · file.js');
  assert.equal(describeToolUse('run_shell_command', { command: 'node --test' }), 'run_shell_command · node --test');
  assert.equal(describeToolUse('todo_write', {}), 'todo_write');
});

// ── terminal outcome ─────────────────────────────────────────────────────────

function summaryOf(overrides = {}) {
  return { sessionId: 'sess-1', lastText: '', structuredResult: null, resultError: null, isError: false, ...overrides };
}

test('a structured report becomes a result with its learnings intact', () => {
  const event = buildTerminalEvent({
    summary: summaryOf({ structuredResult: { summary: 'Ran the suite.', files_changed: ['src/a.js'], tests_run: 'node --test (all passed)', learnings: [{ kind: 'known_bug', title: 'Flaky timer', body: 'The clock test fails under load.' }] } }),
    exitCode: 0,
  });
  assert.equal(event.type, 'result');
  assert.equal(event.testsRun, 'node --test (all passed)');
  assert.deepEqual(event.filesChanged, ['src/a.js']);
  assert.equal(event.learnings[0].kind, 'known_bug');
});

test('a worker that got stuck asks one question instead of reporting success', () => {
  const event = buildTerminalEvent({
    summary: summaryOf({ structuredResult: { summary: 'Could not proceed.', blocked_question: 'Which database should I migrate?' } }),
    exitCode: 0,
  });
  assert.equal(event.type, 'question');
  assert.equal(event.question, 'Which database should I migrate?');
});

test('prose instead of the structured report still lands the work, and says so', () => {
  const event = buildTerminalEvent({
    summary: summaryOf({ isError: true, resultError: 'Model produced plain text instead of calling the structured_output tool as required by --json-schema', lastText: 'The exports are add and sub.' }),
    exitCode: 1,
  });
  assert.equal(event.type, 'result');
  assert.match(event.summary, /add and sub/);
  assert.match(event.summary, /prose/i);
});

test('a crashed worker is a failure, never dressed up as a result', () => {
  const event = buildTerminalEvent({ summary: summaryOf({ isError: true, resultError: 'provider returned 500' }), exitCode: 1 });
  assert.equal(event.type, 'error');
  assert.match(event.message, /500/);
});

test('a worker that died with nothing to say still fails loudly', () => {
  const event = buildTerminalEvent({ summary: summaryOf(), exitCode: null, stderrTail: 'spawn ENOENT' });
  assert.equal(event.type, 'error');
  assert.match(event.message, /ENOENT/);
});

test('a cancelled run reports nothing — the wearer already knows', () => {
  assert.equal(buildTerminalEvent({ summary: summaryOf(), exitCode: null, cancelled: true }), null);
});
