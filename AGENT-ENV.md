# Server agent environment — background engineering work

Roma runs on glasses. Her live model is a conversational front-end: it decides
who is speaking, who they are speaking to, whether the wearer is expected to
answer, and what (if anything) is worth saying out loud. It is deliberately not
the thing that writes code.

Real engineering work — reading a codebase, running tests, debugging, database
work, anything that takes minutes rather than seconds — is handed to a
**worker** running in the server process, and the result comes back through
Roma's normal speech path. The wearer asks out loud, gets an acknowledgement,
and hears about it again when there is something worth hearing.

```
wearer speaks → Roma classifies the turn → dispatch_server_task tool
                                              ↓
                              task store (SQLite) ← dispatcher → worker (Qwen Code CLI)
                                              ↓
                                    taskNotifier decides loudness
                                              ↓
                              Intervention Policy → Speech Gate → TTS
```

## The split, and why it is drawn here

Roma keeps, and never delegates:

> conversation understanding · speech · task dispatch · notifications ·
> permission handling · personal memory · privacy · cancellation

The worker gets, and controls nothing else:

> coding · project inspection · testing · database work · debugging ·
> long-running background execution

The load-bearing consequence is that **a worker has no route to the wearer**.
It cannot speak, cannot authorize speech, and cannot decide it is urgent. It
emits events into the task store; `src/agent/taskNotifier.js` decides whether
any of that is worth mentioning; the existing Speech Gate decides whether it may
be said. A task update is just another `sourceType: 'task_update'` alongside
direct answers and proactive coaching — same gate, same denial-to-visual
fallback.

## Engineering memory is not personal memory

`eng_memory` is a separate table with its own retrieval path
(`server/agentEnv/engineeringMemory.mjs`), holding ten kinds of durable project
knowledge: `codebase`, `architecture`, `commands`, `db_structure`, `fix`,
`known_bug`, `decision`, `failed_approach`, `deployment`, `task_note`.

There is **no code path from engineering memory into `assembleContext()`**, and
none from personal memory into a task brief. The wearer's life and the
project's build commands do not mix in either direction. Retrieval for a brief
applies a relevance floor and boosts `failed_approach` / `known_bug`, on the
theory that the most valuable thing to tell a fresh agent is what already
didn't work.

Learnings are harvested by the *dispatcher* from the worker's structured
result. A worker cannot write to memory itself.

## Projects are an allowlist

A task can only run inside a registered project (`eng_projects`, created
explicitly with `POST /api/agent-projects`). Asking Roma to "run the tests on
the widget service" when no such project is registered is refused with
`unknown_project` — a worker is never handed a filesystem path that someone
invented in conversation.

## The worker contract

`server/agentEnv/workers/adapter.mjs` defines everything a worker must satisfy:

```js
startTask({ brief, cwd, mode, timeoutMs, onEvent, approvalGate }) → { cancel(), finished }
```

and exactly six event types, anything else being dropped rather than trusted:

| event | meaning |
| --- | --- |
| `progress` | one bounded status line |
| `log` | diagnostic detail (stored, never spoken) |
| `question` | needs information only the wearer has |
| `approval_request` | needs permission to proceed |
| `result` | `{ summary, filesChanged, testsRun, learnings, artifacts }` |
| `error` | failed |

`approvalGate()` resolves with `{ approved, response }` — the wearer's actual
words, not just a yes/no, so an engine that supports resuming can pick up where
it stopped instead of being told to carry on blindly.

Two engines ship:

- **`mock`** (default) — `workers/mock.mjs`, deterministic and scripted, no
  network and no subprocess. Every unit test and lab scenario runs against it,
  so dispatch, approval, cancellation and restart behavior are verified without
  depending on a real model's mood. It is labeled `mock` everywhere it surfaces.
- **`qwen`** — `workers/qwenCode.mjs`, the locally installed Qwen Code CLI.

`AGENT_WORKER=qwen` selects the real one. The **default is `mock`**: a wearable
that can silently start driving a real coding agent has to be opted into, never
inherited from a stray environment variable.

**A test run always gets the mock**, whatever `.env` says (`selectWorker()` in
`server/dataApiPlugin.mjs` checks `NODE_TEST_CONTEXT`/`NODE_ENV`). This is not
belt-and-braces: the first time `AGENT_WORKER=qwen` was put in a real `.env`,
`npm test` — which builds the data API in three test files — spawned five live
CLI processes and started spending tokens before it was killed. Worker
selection fails safe now, and `test/agent-env.test.js` holds the regression.

## The Qwen Code worker

Split in two on purpose: `workers/qwenProtocol.mjs` is pure (argv, environment,
tool policy, event mapping, terminal outcome) and `workers/qwenCode.mjs` owns
processes, git worktrees, and cancellation. The parts most likely to be wrong
are therefore testable without a subprocess or a paid model run.

### No shell, ever

The brief is user-derived text. It is written to the child's **stdin**, never
onto a command line, and the CLI is launched as `node lib/cli-entry.js` with an
argv array — a Windows `.cmd` shim is explicitly *refused*, because spawning one
requires `shell: true`.

### The environment is an allowlist

A denylist would have to predict every secret Roma will ever hold. The worker
gets `PATH`, `USERPROFILE`, temp dirs, proxy settings and little else — no Groq
key, no Deepgram key, no TTS key, no biometric encryption key, no
`ROMA_DB_PATH`. Note that the *configuration* the worker is selected from is the
whole `.env` file (`loadWorkerConfigEnv()`), which does hold those keys; the
allowlist is what stops them crossing into the child process, and a test asserts
exactly that.

### The worker has its own identity

Exactly one credential is allowed through, and Roma supplies it:
`AGENT_WORKER_API_KEY` (with `AGENT_WORKER_API_BASE` / `AGENT_WORKER_MODEL`)
becomes the child's `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`.

The worker also runs with a **private `QWEN_HOME`** under Roma's temp state
directory, so it cannot reach `~/.qwen` at all: no inherited login, no personal
extensions, skills, MCP servers or memories. Two things follow. The worker can
never quietly bill or act as whoever last logged into the CLI on that machine —
its identity is deployment configuration, rotatable in one place. And
"the configured key works" becomes an honest claim, because a run that
authenticates cannot have succeeded on a cached personal session.

`describe()` reports the credential as `configured` / `missing`, never its
value; that field is surfaced through `/api/agent-tasks/health` and the startup
log.

### Tool authority is restricted *and verified*

Out of the box this CLI offers a run 56 tools, including 35 `computer_use__*`
tools that drive the wearer's actual desktop, plus `send_message`,
`cron_create`, `web_fetch`, and subagent spawning. `send_message` alone would be
a second channel to the wearer that bypasses the Speech Gate entirely.

Three mechanisms narrow it, because any one of them can be version-fragile:

1. `--core-tools` — allowlist for built-ins,
2. `--exclude-tools` — denylist, which wins over everything,
3. a system-settings overlay pointed at by `QWEN_CODE_SYSTEM_SETTINGS_PATH`
   that turns Computer Use off at the source. It is written to a Roma-owned
   temp file; **the user's own `~/.qwen/settings.json` is never edited**, so
   their credentials and model providers keep working.

Then the worker **checks the tool list the CLI actually advertises** in its
session-start event and refuses to run if it is wider than what we granted.
That last step is not theoretical: it caught a wrong guess about the editor
tool's name during the first live write-mode run and stopped the run instead of
proceeding over-privileged.

Measured result: a readonly run is offered exactly six tools —
`read_file`, `list_directory`, `grep_search`, `glob`, `todo_write`,
`structured_output`.

### Readonly means readonly

Readonly runs use Qwen's `plan` approval mode, which removes `write_file` and
`run_shell_command` from the registry entirely. The bound is structural, not a
request in the prompt for the model to behave.

### Write mode: consent, isolation, and a patch

A write-mode task, in order:

1. refuses outright unless the project is a git repository,
2. emits `approval_request` and **stops** — nothing has run yet,
3. on approval, creates a detached `git worktree` under the OS temp directory,
4. runs the agent there with auto-approval (a worktree it may freely edit),
5. stages the result and writes a `.patch` file, reporting the changed files,
6. removes the worktree and prunes it.

The wearer's working tree is never edited, and no stale worktree is left
registered in their repository. What comes back is a reviewable patch.

### Structured results instead of prose

`--json-schema` registers a terminal `structured_output` tool the model must
call to finish, so "did the agent report something usable?" is a validated
contract mapping one-to-one onto the `result` event — including `learnings`
typed to the kinds engineering memory can actually store.

One forgiving case: if the model answers in prose instead, the CLI fails the run
even though the work usually happened. That prose becomes the summary, flagged
as such. Every other failure stays a failure — a worker that crashed is never
dressed up as a success.

### Budgets and cancellation

`--max-wall-time` (set below the dispatcher's own timeout so the worker stops
itself with a reportable result first), `--max-session-turns`, and
`--max-tool-calls`. Retry-forever is deliberately *not* enabled: a background
task must die inside its wall clock rather than wait out a provider outage.

Cancellation kills the whole process tree. `child.kill()` on Windows leaves
grandchildren — the agent's own `npm test`, say — running after the wearer has
said stop, which is precisely the case cancellation exists for.

## What the wearer hears

`src/agent/taskNotifier.js` is deterministic and decides one of four things per
task snapshot:

- `silent` — routine progress. Background work does not become chatter.
- `visual` — worth showing, not worth interrupting for.
- `speak_when_convenient` — completions and failures, delivered in a real gap.
- `speak_now` — only when the task is blocked on the wearer and nothing
  proceeds until they answer.

Roma's four tools (`src/agent/serverTasks.js`): `dispatch_server_task`,
`check_task_status`, `answer_task_question`, `cancel_server_task`. The wearer's
spoken "yes, go ahead" on a later turn resolves against the pending-task context
block, so approval is a normal part of the conversation rather than a UI chore.

## Verification

```bash
npm test                       # includes 34 protocol tests + 18 agent-env tests
npm run verify:qwen-worker     # live, opt-in: real CLI, readonly only
npm run verify:qwen-worker -- --write   # also verifies write mode

# Spoken end-to-end, through the virtual microphone (needs Deepgram + Groq keys):
node scripts/run-virtual-scenarios.mjs --family agent_env               # mock worker
node scripts/run-virtual-scenarios.mjs --family agent_env --real-worker # …and the real one
```

A lab scenario declares `"worker": "qwen"` to opt into the real engine. The
isolated lab server always sets `AGENT_WORKER` **explicitly** rather than
inheriting it, so a developer with `AGENT_WORKER=qwen` in `.env` does not
silently turn every scenario into a paid run; real-worker scenarios are skipped
unless named or run with `--real-worker`.

### Making it usable in a real session

Projects are an allowlist, so a fresh install can dispatch nothing. Register
this repository and seed what is already known about it with:

```bash
node scripts/seed-engineering-memory.mjs --dry-run   # review first
node scripts/seed-engineering-memory.mjs
```

Re-running is safe — entries are matched by title and skipped if present.

The live script reads the same configuration the server does, builds a
throwaway git repo in the OS temp directory and an in-memory database, and never
touches `data/roma.db`, the real project, or the user's Qwen configuration. It
costs real tokens, which is why it is opt-in and not part of `npm test`.

Last measured, 2026-08-07 with `AGENT_WORKER=qwen` and a configured
`AGENT_WORKER_API_KEY`: **15/15 checks**, both modes, on `qwen3-coder-plus`.
The readonly task found a planted bug with six tools and no file changes;
learnings landed in engineering memory and nothing landed in personal memory;
the write task asked first, produced a correct fix as a patch, left the working
tree clean, and left no worktree behind.

`dispatch_real_qwen_smoke` closes the loop end to end, with nothing scripted:
the wearer speaks aloud, real Deepgram transcribes, the real Groq agent
classifies the turn as addressed to Roma, she dispatches to the real CLI and
answers *"I've started a background task to read src/clock.js in the roma
project and will let you know when it's done"* — an acknowledgement, not a
fabricated result — the task completes, and no progress becomes chatter.

### What that scenario caught

The first run failed, and usefully. Roma classified the turn correctly and then
said *"I'm sorry, but I don't have access to the source code of the Roma
project."* True of herself — she cannot read files — but wrong overall, because
a background agent was standing by with that exact repository registered. She
had never been told any project existed.

Two fixes, both structural rather than prompt-tuning: the context now names the
registered projects (`formatRegisteredProjects`, wired through
`useAgentTasks` → `useAgent` → runtime → prompt), and the dispatch tool's
description now states plainly that Roma cannot read files, so questions that
sound small — *"what does this file do"* — route to the worker instead of being
answered from guesswork. Root paths stay out of the prompt; only names go in.

## Known limits

- One task in flight at a time. A wearable narrating five concurrent jobs is
  noise, not help.
- Questions are answered by resuming the CLI session (up to two rounds). The
  dispatcher's wall clock keeps running while a task waits on the wearer.
- Write mode auto-approves tool calls *inside the worktree*, which includes
  shell commands running at the host's privilege level. The isolation is the
  worktree and the wearer's explicit approval, not a sandbox.
- The `mock` worker is the default; nothing runs a real agent until someone
  sets `AGENT_WORKER=qwen` **and** gives it a key.
- `AGENT_WORKER_API_KEY` lives in `.env` in plaintext, like every other key in
  this project. Use a restricted, scoped key for the worker and rotate it
  independently of your personal credentials — that separation is most of the
  point of giving the worker its own identity.
