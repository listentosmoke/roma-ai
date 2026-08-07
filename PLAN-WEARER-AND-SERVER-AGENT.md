# Plan — Wearer-Centered Conversation & Server Agent Environment

Status: **P1, P2 and P3 all complete and verified.** Grounded in the
repository as of 2026-07-24; P1 built 2026-07-25, P2 built 2026-07-29 and
live-verified 2026-08-03, P3 built and live-verified 2026-08-05.
Facial recognition stays deferred.

## P3 status (2026-08-05) — complete, live-verified

The real Qwen Code adapter is in behind the unchanged worker contract
(`AGENT_WORKER=qwen`), split into a pure protocol module
(`workers/qwenProtocol.mjs`) and process/worktree orchestration
(`workers/qwenCode.mjs`). 674/674 offline tests, production build clean, no
worker internals in the bundle.

Live verification (`npm run verify:qwen-worker -- --write`): **15/15 checks**.
Readonly ran with exactly six tools, found a planted bug, changed no files, and
its learnings landed in engineering memory with nothing in personal memory.
Write mode asked first, worked in a disposable git worktree, produced a correct
fix as a reviewable patch, left the working tree clean, and left no worktree
behind.

Three findings worth keeping:

1. **The default tool surface was far too wide.** Out of the box the CLI offers
   56 tools including 35 `computer_use__*` (the wearer's actual desktop),
   `send_message`, `cron_*`, `web_fetch` and subagent spawning. `send_message`
   alone would have been a second route to the wearer bypassing the Speech
   Gate. Narrowed with `--core-tools` + `--exclude-tools` + a system-settings
   overlay, and then *verified* against the tool list the CLI advertises.
2. **`--safe-mode` and `--core-tools` are mutually exclusive** — safe mode
   ignores the allowlist and leaves Computer Use registered. The overlay
   (`QWEN_CODE_SYSTEM_SETTINGS_PATH`, a Roma-owned temp file) is what actually
   disables it, without touching the user's `~/.qwen`.
3. **The surface check earned its place immediately** — it caught a wrong guess
   about the editor tool's name on the first live write run and refused to
   start rather than proceeding over-privileged.

Also fixed along the way: the first real run returned a correct analysis with
an empty `learnings` array, because nothing in the brief asked for durable
facts. `buildTaskBrief()` now does, and learnings have been harvested on every
run since.

Docs written/updated: [AGENT-ENV.md](AGENT-ENV.md) (new), README, HANDOFF,
AGENT.md, PROACTIVE.md.

## P2 status (2026-07-29) — built, unit-verified, live round-trip pending

Implemented and green (645/645 offline tests, production build clean):

- **Migration `0004_agent_environment`**: `eng_projects`, `eng_memory`,
  `agent_tasks`. Engineering memory is structurally separate from personal
  memory — different tables, different module tree, and no code path from
  `eng_memory` into `assembleContext()`.
- **`server/agentEnv/engineeringMemory.mjs`**: 10 knowledge kinds
  (architecture, commands, fixes, known bugs, decisions, failed approaches,
  deployment…), ranked brief retrieval reusing the existing keyword scorer,
  with a relevance floor so briefs are not padded with filler matches.
- **`server/agentEnv/taskStore.mjs`**: bounded 50-entry progress ring,
  optimistic versioning, terminal-state protection, and a restart sweep that
  marks interrupted tasks `failed` — never left looking alive.
- **`server/agentEnv/workers/adapter.mjs`**: the replaceable-worker contract
  (progress · log · question · approval_request · result · error). Unknown
  event types are dropped, so a worker cannot invent a way to reach the
  wearer. Briefs carry engineering context only — no personal memory, no
  transcript, no credentials.
- **`server/agentEnv/workers/mock.mjs`**: deterministic scripted worker used
  by every test and lab scenario; identifies itself honestly as a mock.
- **`server/agentEnv/dispatcher.mjs`**: single-concurrency queue, wall clock,
  hard cancellation, write-mode approval gating, audit on every transition,
  and harvesting of worker `learnings` into engineering memory.
- **`server/routes/agentTasks.mjs`**: authenticated, tenant-scoped,
  rate-limited task API. A task naming an unregistered project is refused —
  a worker never receives an invented filesystem location.
- **Roma side**: four tools (`dispatch_server_task`, `check_task_status`,
  `answer_task_question`, `cancel_server_task`), the deterministic
  `src/agent/taskNotifier.js`, `src/useAgentTasks.js`, and a bounded
  `BACKGROUND TASKS WAITING ON THE WEARER` context block so a spoken
  "yes, go ahead" resolves to the right task.

**The notifier is the behavioral heart** (13 tests): progress is visual/silent
with at most one spoken milestone per interval; approvals and questions are
spoken immediately; completion and failure are announced once, when
convenient; a cancellation the wearer requested is not read back to them. The
worker never touches speech — everything spoken passes the existing Speech
Gate as `sourceType: 'task_update'`.

**Live round-trip VERIFIED (2026-08-03): 3/3 consecutive passes.** The wearer
says "Roma, run the test suite on the roma project in the background and tell
me how it goes"; Roma classifies it as addressed to her, calls
`dispatch_server_task`, answers *"Got it, I've started the test suite in the
background. I'll let you know when it's done"* — not pretending the work is
finished — the task runs and completes, and no routine progress is spoken.

Chasing this failure found **a real production bug the unit tests could not
see**: `useAgentTasks`'s polling effect depended on `refresh`/`refreshRecent`,
whose identities change whenever the voice/speech dependencies do — many times
a second while the microphone is live. Every re-render tore down the interval
and fired an immediate poll, a request storm that tripped the server's own
rate limiter, after which Roma truthfully told the wearer it was
"rate-limited". Fixed with refs so the poll effect depends only on the client.
A second, smaller fix: terminal tasks leave the ACTIVE list, so the hook now
also tracks recent tasks — otherwise nothing could observe that a task had
finished.

**Deliberate design correction made during verification:** `check_task_status`
no longer counts as "handling" a dispatch request in the consistency guard —
the model calling it and then answering means it looked at existing tasks
instead of starting the one that was asked for.

## P1 status (2026-07-25) — implemented, with an open regression

Built and unit-verified (604/604 offline tests, production build green):
- `turn_analysis` on every decision (`src/agent/schema.js`), bounded and
  degrading safely when absent.
- Deterministic wearer resolution (`src/agent/wearer.js`) — confirmed /
  assumed / unknown, clear-majority close-mic heuristic, fed by real peak mic
  level per turn from `main.jsx`.
- Wearer-aware addressee codes (`addressed_to_wearer`, `wearer_reply_expected`,
  `third_party_conversation`, `wearer_speaking`).
- Assist-opportunity channel: runtime → `useAgent` → Opportunity Engine
  (`noteAssistOpportunity`) as evaluation CONTEXT only; never speech.
- Spoken proactive defaults: `spokenSuggestionsEnabled: true`,
  `conversationDelivery: 'speak_when_convenient'` as a deterministic FLOOR
  (urgent `speak_now` warnings are never downgraded), Speech Gate untouched.
- Lab: 4 new oracle conditions, bridge exposure of per-turn classification,
  3 `wearer` scenarios.

**Verified working against the real Groq model** (probe runs, 2026-07-25):
`turn_analysis` flows end to end; wearer-directed turns produce real assist
hints (e.g. *"You have the Building 5 quote stored as $8,400, which could be
shared if the wearer asks"*); the Opportunity Engine produced a suggestion
from one.

### Regression RESOLVED (2026-07-25) — and it was never the prompt

Option 2 was implemented (`src/agent/directAddress.js`): a deterministic guard
rejects an `ignore` when the wake word was spoken, an engagement window is
open, or the model's own `addressed_to` says "roma", then re-infers ONCE with
the contradiction stated. It never fabricates an answer — a considered second
refusal stands (10 unit tests, including that case).

Adding the guard's observability to lab reports then exposed the *actual*
root cause, which prompt tuning could never have fixed. Two schema bugs were
killing whole turns with HTTP 400 `failed_generation`, exhausting the
provider's retries and leaving direct questions unanswered:

1. **Nested `turn_analysis` destabilized Groq's constrained decoding.** Turns
   failed generation at `/tool_calls/0/arguments`. Fixed by flattening the
   analysis into three top-level scalars (`addressed_to`,
   `wearer_expected_to_respond`, `assist_opportunity`) and dropping
   `speaker_role` — `src/agent/wearer.js` answers that deterministically and
   more trustworthily than the model can.
2. **`task_update` with empty strings was treated as fatal.** Strict mode
   forces the model to emit the object even with nothing to report, which it
   does as `{active:false, taskId:"", goal:"", status:""}`. Validation
   rejected it and discarded the entire decision. Now a NON-active, entirely
   blank update means "no update" (an `{active:true}` update with no
   id/goal/status still fails loudly — it is incoherent).

**Verified: 4/4 consecutive `direct_address_and_followup` runs green**
(previously ~50%), plus `wearer_conversation_taxonomy` and
`wearer_spoken_assistance` passing with correct `addressed_to=wearer` and
`addressed_to=roma` classification. 614/614 offline tests, build green.

### Wearer-directed classification FIXED (2026-07-25)

`wearer_addressed_by_other` now passes: a request only a human could fulfil
("drive to the site with me after lunch") is classified
`addressed_to=wearer` with `wearer_expected_to_respond=true`, and Roma stays
silent instead of answering on the wearer's behalf. Three changes:

1. **Roma now knows it has no body.** The system prompt states plainly that it
   cannot go anywhere, drive, carry, or be physically present, so a request
   needing a body is necessarily for the wearer. This is the general fix — it
   works even when no name is used and the diarization label is shared.
2. **Identity can name the wearer.** `wearerResolver.nameWearer()` attaches an
   identity-resolved display name to the speaker already believed to be the
   wearer. It can never promote anyone into the role, and the name does not
   follow the slot to a different speaker (3 tests).
3. **The engagement window no longer over-claims.** Strengthening it to fix the
   follow-up regression had made Roma treat a *coworker's* physical request
   during an open window as a continuation of its own conversation. It now
   explicitly yields for turns that need a body or are aimed at another person.

**Verified:** all three `wearer` scenarios green standalone;
`direct_address_and_followup` 3/3 consecutive green *after* these changes
(so the two behaviors hold simultaneously); 617/617 offline tests; build
green.

**Residual variance:** in back-to-back family runs one borderline line in
`wearer_conversation_taxonomy` ("Alex, did you get a chance to look at the
roof drawings?") is occasionally answered when it should be ignored. It
passes standalone. Same provider-latency/stochasticity profile already
documented in VIRTUAL-HARDWARE.md — treat a single family-run failure as a
rerun candidate first.

**Lab limitation discovered (2026-07-25):** Deepgram diarization does NOT
separate the synthetic Aura voices used by the lab — two different voices at
different distances both transcribe as `Speaker 1`. Recorded human fixtures DO
separate. Consequence: multi-speaker wearer scenarios cannot rely on distinct
speaker labels; the model must classify from content alone, which is harder
than the real-hardware case. Full wearer-vs-other verification needs either
recorded human fixtures (fixed content) or physical devices.

## The two reframes this plan implements

1. **Roma lives on glasses worn by one person.** The wearer is the center of
   every interaction. "Not addressed to Roma → no action needed" is no longer
   a permitted conclusion: every turn must be classified — who spoke, to
   whom, whether the wearer is expected to respond, and whether Roma can
   usefully help the wearer — and useful help should usually be SPOKEN
   (privately, into the wearer's ear), not silently displayed.
2. **Roma's live model is a conversational front-end, not an engineer.**
   Engineering-scale work (code, tests, DB work, long tasks) is dispatched to
   a server-side worker agent (default: the locally installed **Qwen Code**)
   behind a Roma-controlled adapter, with its own engineering memory,
   structured progress events, and Roma retaining sole authority over speech,
   approvals, privacy, and cancellation.

---

## 1. Wearer-centered conversation & addressee detection

**Reuse:** the entire decision pipeline (`agent/runtime.js` FIFO,
`schema.js` validation, `addressee.js` overlay, `engagement.js` window,
Speech Gate) stays. The decision enum (`ignore | respond | clarify |
tool_call | inspect_vision | update_task`) does NOT grow — no new executable
paths, so no new safety surface.

**Change:**

- `src/agent/schema.js` — add an optional, strictly-bounded `turn_analysis`
  object to every decision (validated, arrays-of-pairs not needed — flat
  enums/bool/short string; Groq strict mode compatible):

  ```json
  {
    "speaker_role": "wearer | other_person | unknown",
    "addressed_to": "roma | wearer | another_person | group | unclear",
    "wearer_expected_to_respond": false,
    "assist_opportunity": null
  }
  ```

  `assist_opportunity` is a ≤140-char hint ("wearer was asked about tomorrow's
  schedule — calendar memory may help"), or null. The prompt requires the
  model to fill `turn_analysis` on EVERY decision including `ignore`.
- `src/agent/prompt.js` — rewrite the posture paragraphs of `SYSTEM_PROMPT`:
  glasses framing; wearer identity block (`WEARER: Speaker 0 (assumed)` /
  `(confirmed)` / `(unknown)`); the six-way classification duty; "you will
  almost never be addressed directly — your name remains the strong
  activation signal, but understanding the wearer's conversation is your
  continuous job"; ignore still governs *speech*, never *analysis*.
- **New** `src/agent/wearer.js` — deterministic wearer resolution (never the
  model): a person record with role `wearer` + session continuity from the
  identity resolver maps a diarized label → wearer; fallback heuristic:
  the speaker with sustained highest mic level / closest-speaker profile is
  `assumed`; otherwise `unknown`. Compiled into context by `prompt.js`.
- `src/agent/addressee.js` — extend reason codes (keep the existing six):
  `addressed_to_wearer`, `third_party_conversation`, `background_speech`,
  `wearer_reply_expected`, derived from `turn_analysis` + wake word +
  engagement. Emitted on the existing `addressee-decision` event (now
  carrying the full analysis for observability/oracle use).
- `src/agent/runtime.js` — one additive step: after an `ignore` decision
  with a non-null `assist_opportunity`, forward
  `{hint, turnId, analysis}` to a registered `onAssistOpportunity` callback
  (wired by `useAgent` → the Opportunity Engine as extra evaluation
  context). The deterministic Intervention Policy + Speech Gate still fully
  gate whether anything is shown or spoken — a hint is never speech.

**Tests:** schema bounds; addressee derivation matrix; runtime emits
`turn-analyzed` with hints; prompt renders the wearer block; latency
delta of the enlarged schema measured (fallback documented: if
`turn_analysis` measurably degrades p50 turn latency, populate it only when
`decision = ignore`).

## 2. Spoken proactive suggestions

**Reuse:** Opportunity Engine, Intervention Policy scoring, Speech Gate
budgets, gap detector, `speak_when_convenient` scheduling, pending-speech
UI — all already built; today they are simply defaulted off.

**Change (`src/proactive/`):**

- `preferences.js` — `spokenSuggestionsEnabled: true` by default; new
  `assistWearerSpoken: true`; keep quiet/balanced/proactive modes and all
  budgets (1 unprompted/min, ≥20 s spacing).
- `policy.js` — glasses-audio reframe: the speaker is near-ear and
  semi-private, so `publicConversationSuggestions` no longer hard-caps to
  `visual_only`; instead conversation-active suggestions default to
  `speak_when_convenient` (gap-gated) with `visual_only` as the fallback
  when the gap never comes. Privacy/urgency/confidence/relevance stay in
  the score; `sensitive`-flagged content still never auto-speaks
  (existing sensitivity policy `speech.deliver` rule unchanged).
- `engine.js` — accept `assistOpportunity` hints as an additional
  evaluation trigger/context (a fingerprint input, not an authorization).

**Speech Gate is untouched** — it remains the sole authorizer; this phase
changes only preferences/policy defaults that feed it.

**Tests:** policy matrix (spoken vs visual per mode/urgency/sensitivity);
gate budget unchanged; existing proactive tests updated for new defaults.

## 3. Engineering memory (separate from personal memory)

**Not** the existing `src/memory/` system, not the `memories` table, never
compiled into wearer conversation context.

**New** `server/agentEnv/engineeringMemory.mjs` + migration
`0004_agent_environment.sql`:

- `eng_projects(project_id, workspace_id, name, root_path, default_test_cmd, created_at)`
- `eng_memory(memory_id, workspace_id, project_id, kind, title, body,
  tags, source_task_id, created_at, updated_at)` — kinds:
  `codebase | architecture | commands | db_structure | fix | known_bug |
  decision | failed_approach | deployment | task_note`
- Retrieval: keyword/tag/kind ranking reusing the pure
  `createKeywordScorer()` from `src/memory/embeddings.js` (no duplication).
- Flow: the dispatcher compiles relevant rows into the worker's task brief
  (and refreshes the project's `QWEN.md` context file); the worker's result
  contract carries `learnings[]` which the dispatcher writes back as new
  rows (auditable, bounded, per-project).
- Personal memory isolation is structural: different tables, different
  module tree, no route from `eng_memory` into `assembleContext()`.

## 4. Background task & dispatch system

**New** `server/agentEnv/`:

- `taskStore.mjs` — `agent_tasks(task_id, workspace_id, project_id, title,
  goal, status, progress_ring(json, bounded 50), approval_request(json),
  result_summary, error, operation_id, created_at, updated_at)`; statuses
  `queued | running | awaiting_approval | awaiting_input | completed |
  failed | cancelled`. Optimistic versioning like `sessions`. Server restart
  marks `running` tasks `failed(reason: interrupted)` — visible, never
  silently resumed.
- `dispatcher.mjs` — single-concurrency queue; spawns the worker via the
  adapter; normalizes worker events → task-store updates + audit records;
  bounded wall clock (default 20 min) and hard cancellation (process-tree
  kill); every transition audited with operationId + reason code.
- `server/routes/agentTasks.mjs` — `/api/agent-tasks` (create/list/get/
  cancel/approve/provide-input/events), mounted exactly like `dataApi.mjs`
  (same auth boundary, tenant scoping, rate limiting, idempotency ledger,
  audit, bounded errors). Polling first; SSE later if needed.

**Roma side:**

- Four new tools in the existing registry (`src/agent/serverTasks.js`):
  `dispatch_server_task({goal, project})`, `check_task_status({task_id?})`,
  `answer_task_question({task_id, response, approve?})`,
  `cancel_server_task({task_id})`. Prompt guidance: answer small things
  directly; dispatch engineering-scale work; never fabricate task results.
- **New** `src/agent/taskNotifier.js` (deterministic, the "Roma decides how
  loud" layer): converts task events into candidate announcements —
  `progress` → visual/silent (spoken at most once per N minutes per task,
  only on milestones), `awaiting_approval`/`awaiting_input` → spoken
  question (priority normal; `urgent` flag may `speak_now`), `completed`/
  `failed` → concise spoken summary via `speak_when_convenient`. ALL of it
  routes through the existing Intervention-Policy/Speech-Gate path as a new
  `sourceType: 'task_update'` — the worker never touches speech, and gate
  denial falls back to visual exactly like coaching does.
- `src/useAgentTasks.js` — hook: polls task events, feeds the notifier,
  renders a dev Task panel, injects a `PENDING SERVER TASKS` /
  `PENDING TASK APPROVALS` context block (bounded) so the wearer's spoken
  "yes, go ahead" on the next turn resolves to `answer_task_question`.
- Capability registry additions: `dispatch_server_task_readonly:
  allowed_with_notification`, `dispatch_server_task_write:
  requires_confirmation` — enforced deterministically in the dispatcher
  (write-capable briefs refuse to start unapproved), and both become
  IMPLEMENTED entries.

## 5. Replaceable worker adapter

**New** `server/agentEnv/workers/`:

- `adapter.mjs` — the contract every worker satisfies:
  `startTask({brief, cwd, mode: 'readonly'|'write', timeoutMs, onEvent})
  → {cancel()}` with normalized events `progress | log | question |
  approval_request | result | error`; result contract
  `{summary, filesChanged[], testsRun, learnings[], artifacts[]}`.
- `qwenCode.mjs` — default worker: spawns the installed CLI
  (`C:\Users\natha\AppData\Local\qwen-code\bin\qwen.cmd`) headless
  (`qwen -p <brief>` in the project cwd), stream-parses output into
  events. Two execution modes, because headless approval interop is the
  known risk: **readonly/plan mode** (restricted approval mode; file writes
  denied; output = analysis/plan) and **write mode** (runs only after
  Roma-side approval, inside an isolated git worktree/copy of the project;
  results land as a diff the dispatcher reports — nothing edits a working
  tree the wearer didn't approve). Worker env is stripped of Roma's
  secrets (`DEEPGRAM/GROQ/TTS/BIOMETRIC/ROMA_DB_PATH`); Qwen uses its own
  `~/.qwen` credentials.
- `mock.mjs` — deterministic scripted worker (full event contract, no
  network) for tests and lab scenarios.
- Config: `AGENT_WORKER=qwen|mock`, `AGENT_WORKER_CMD` override — an
  OpenCode/Claude-Code/other CLI becomes a drop-in later by satisfying
  `adapter.mjs`; nothing else changes.

## 6. Safe execution boundaries

- Project allowlist (`eng_projects.root_path`, created explicitly — never
  inferred); worker cwd is always inside an allowlisted root; write mode
  always in an isolated worktree/copy.
- Live Roma SQLite is never handed to a worker — DB tasks operate on
  migration files + disposable copies; the worker can run the repo's own
  test/simulation commands (including the Virtual Hardware Lab CLI — it is
  just a project command) under the task's wall-clock bound.
- Every dispatch/approve/cancel/result audited; sensitivity/consent/
  Speech-Gate code paths untouched; new security tests: worker env has no
  Roma secrets, task routes are tenant-scoped and fail closed in
  production mode, task events never carry secrets, and the client bundle
  gains no new server internals.

## 7. Virtual Hardware Lab verification (all through observed behavior)

Bridge/oracle additions: expose bounded `taskSnapshot` (statuses, last
events) + last `turn_analysis` via the observability bridge; new oracle
conditions `roma.turn_classified` (param: `addressed_to=wearer` etc.),
`roma.assist_suggestion_spoken`, `roma.task_dispatched`,
`roma.task_awaiting_approval`, `roma.task_completed_spoken`,
`roma.no_progress_chatter`.

New scenarios (family `wearer` + `agent_env`):

1. `wearer_addressed_by_other` — a sim person asks the wearer (not Roma) a
   question; assert: no direct reply, `addressed_to=wearer` classification,
   and a gate-approved SPOKEN assist suggestion delivered in a real
   conversational gap.
2. `conversation_taxonomy` — layered background pair + wearer-directed
   speech; assert distinct classifications per turn.
3. `spoken_coaching_default` — the HVAC-price coaching case now audibly
   plays (`sourceType: conversation_coaching`) instead of visual-only, and
   stays silent while others are mid-sentence.
4. `dispatch_roundtrip_mock` — wearer speaks a task → `dispatch_server_task`
   → mock worker emits progress (assert NO playback per progress event) →
   `approval_request` → Roma asks aloud → wearer speaks approval → worker
   completes → concise spoken summary; task rows + audit verified via the
   isolated server's API.
5. `dispatch_cancel_and_crash` — spoken cancellation kills a running task;
   a crashing worker surfaces `failed` visibly with a spoken notice.
6. `dispatch_real_qwen_smoke` (opt-in flag, `real_worker_verified` label) —
   a tiny real Qwen Code task in a scratch project (write a file, run
   `node --test`), full event round-trip.

## Sequencing, effort, verification gates

- **P1 — wearer-centric perception + spoken proactive** (items 1–2):
  ~6 files changed, 2 new; gates: 585+ tests green, lab scenarios 1–3.
- **P2 — task system with mock worker** (items 4, 6, parts of 5):
  migration 0004, ~7 new modules, tools + notifier + panel; gates: new unit
  tests, lab scenario 4–5, security tests.
- **P3 — real Qwen adapter + engineering memory + docs** (items 3, 5):
  gates: real-worker smoke, AGENT-ENV.md written, README/HANDOFF/AGENT.md/
  PROACTIVE.md updated, full `verify:virtual-lab` including new families.

**Known risks:** Groq strict-schema growth may add latency (measured in P1,
with a documented fallback); Qwen headless approval interop varies by
version (mitigated: mock-first contract, plan/worktree modes, adapter
replaceability); spoken-update fatigue (mitigated: notifier milestones +
existing budgets — and every threshold is a preference, not a constant).
