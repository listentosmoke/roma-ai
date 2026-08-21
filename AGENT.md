# Roma's main agent

This document covers the **reactive reasoning core**: the part of Roma that
hears a finalized speaker turn, automatically gets the latest visual context
from the Inspector (see [INSPECTOR.md](INSPECTOR.md)), decides whether to act,
optionally uses a tool, and produces a response. The **proactive layer**
(Opportunity Engine, Conversation Coach, intervention policy, speech gate,
suggestion queue, background-task proposals) is documented separately in
[PROACTIVE.md](PROACTIVE.md) — note that since that phase, direct answers pass
the shared deterministic speech gate too (`spokenApproved` on response events),
and `runtime.setTaskState()` lets approved proposals become local task state.

Nothing about the audio engine (`src/engine/`) or the Inspector (`src/inspector/`,
`src/context/compiler.js`) changed except two additive one-liners: `buildInspector`
now also returns `deepAnalyzer`, and `useInspector` exposes `frameBuffer` +
`deepAnalyzer` refs alongside `sceneStore` (needed so the agent's vision tools can
reach them).

## Architecture

```
engine → finalized segment ──► runtime.handleTurn(segment)
                                   │  records into a bounded transcript window
                                   │  (outside the model; NOT the same as
                                   │  conversation history — see below)
                                   ▼
                        single-flight FIFO turn queue
                     (turnId assigned; strictly in order —
                      a slow turn can never let a later one answer first)
                                   ▼
                          context assembly (agent/prompt.js)
                            recent transcript window · current turn
                            · active task state · latest visual snapshot
                            (labeled, revision + age) · tool descriptions
                            · tool results so far
                                   ▼
                    provider.infer({ system, messages, schema })
                       agent/provider.js — Groq adapter or mock
                                   ▼
                       schema.js validateDecision(raw)
                    invalid output ⇒ safe failure, nothing executes
                                   ▼
             ignore | respond | clarify | tool_call | inspect_vision | update_task
                                   │
                    tool_call / inspect_vision ⇒ execute tool(s) (agent/tools.js)
                    ⇒ ONE bounded follow-up inference (config: maxToolRounds)
                                   ▼
                    freshness check (scene revision at start vs now)
                                   ▼
                        output event (runtime.subscribeOutput)
```

The Inspector still just writes; the runtime still just reads at think-time and
attaches a snapshot **ephemerally**. What's new: the runtime now also reasons
about *whether* to attach an answer at all, and can act.

## Time sense and thinking one step ahead

Roma used to have timestamps on transcript turns and no idea what **day** it
was — which is why she could not be prudent about anything. "Before Friday"
means nothing without knowing today is Thursday, and a plan that needs a shop
open is worthless at 11pm.

Two blocks now sit in every compiled context:

- **`RIGHT NOW`** — the real weekday, date, time and part of day, in the terms
  a person uses (`describeNow` in `src/clock.js`). The model reasons about
  "this afternoon", not epoch milliseconds.
- **`COMING UP`** — commitments, tasks and goals with a `validUntil` that is
  near or already passed (`memory.upcoming()`). This is deliberately **not**
  retrieval: a deadline matters because of the date, not because somebody
  happened to mention it. Overdue items come first, since they are the most
  actionable. Absent entirely when nothing is due.

Three prompt rules govern their use, and all three are about restraint:
work out what "tomorrow" actually is rather than repeating the word; raise a
deadline only when it genuinely bears on what is being discussed, and never
recite the list; and **think one step ahead** — if what the wearer is about to
do has an obvious near-term consequence they have not accounted for, fold it
into the answer in a clause or two.

That last one is common sense, not a consequence engine. There is no model of
outcomes, no risk scoring, no enumeration of what might go wrong. The rule
explicitly says not to speculate about remote possibilities and to say nothing
when unsure — because an assistant that lists risks is worse than one that
stays quiet.

## Files

| File | Role |
|---|---|
| `src/agent/schema.js` | `AGENT_DECISION_JSON_SCHEMA` (given to providers with structured-output support) + `validateDecision()`/`validateTaskUpdate()` — the single source of truth for what counts as a safe decision, shared by every provider including the mock. |
| `src/agent/prompt.js` | Roma's system prompt (behavior rules) + `assembleContext()` — renders transcript window, task state, labeled visual context, tool results, and tool descriptions into one message. Pure, provider-agnostic. |
| `src/agent/provider.js` | `provider.infer({system, messages, schema, signal}) -> {decisionRaw, usage, latencyMs}`. `createGroqProvider` (real), `createMockProvider` (scripted/rule-based), `createProvider(config)` factory. |
| `src/agent/tools.js` | `createToolRegistry()` (validation + safe execution) and `createDefaultTools()` — wires `inspect_current_view` / `inspect_view_at_time` to the **existing** frame buffer + deep-analysis interface, plus a deterministic `check_clock` test tool. |
| `src/agent/runtime.js` | The orchestrator: transcript window, FIFO turn queue, context assembly, decision execution, freshness check, task state, output events, per-turn metrics. Also keeps the original `beginSession`/`observeTranscript`/`respond`/`history` API for back-compat. |
| `src/agent/speech.js` | Legacy speech-output boundary (`{ speak }`) kept for tests/back-compat. In the browser the runtime is given the real **Selective Voice Delivery** layer (`src/voice/`, see [VOICE.md](VOICE.md)) instead: a gate-approved direct answer mints an authorization and drives TTS + playback. |
| `src/agent/config.js` | Env-driven config (model, timeouts, token limits, provider choice). Never hardcode credentials elsewhere. |
| `src/useAgent.js` | React hook: builds the runtime once, proxies the Inspector's refs (camera may start after this hook mounts) into the tools, subscribes to output events. |
| Agent panel in `src/main.jsx` | Status, latest decision, response, scene revision/age, task, tool calls, latency, errors, and a dev-only "assembled model input" viewer. |

## Provider configuration & API-key security

`.env` (gitignored) — **server-side names, no VITE_ prefix**:

```
GROQ_API_KEY=your_key_here                              # required for real models
GROQ_MODEL=openai/gpt-oss-20b                           # optional — the default
GROQ_BASE_URL=https://api.groq.com/openai/v1            # optional
VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct  # optional — the default
```

**The Groq key never enters the browser.** All model calls from the app go
through local API routes served by a Vite plugin inside the dev/preview server
process ([server/groqApi.js](server/groqApi.js), wired in
[vite.config.js](vite.config.js)):

- `GET  /api/health` — is a key configured; which agent/vision models (no secrets)
- `POST /api/agent/infer` — main-agent inference (browser uses `createProxyProvider`)
- `POST /api/vision/analyze` — vision analysis (browser uses `createProxyVisionProvider`)

The key is read server-side by [server/env.mjs](server/env.mjs)
(`GROQ_API_KEY` preferred; a legacy `VITE_GROQ_API_KEY` entry is accepted with a
warning — rename it). No client file references a VITE_ Groq variable, so Vite
never inlines the key; `test/vision.test.js` fails the suite if such a reference
is reintroduced, and a `grep` of `dist/` after a build confirms zero occurrences.
No key ⇒ the routes return 503 and the app falls back to mock providers (the
Agent panel says so). The **Deepgram** key is now server-side too: the browser
streams through a local proxy (`/api/deepgram/stream`) and no client file
references a VITE_ Deepgram variable (`test/voice-security.test.js` enforces
this). TTS uses the same server-side pattern via `POST /api/tts/synthesize`
([VOICE.md](VOICE.md)).

The Groq agent adapter (`createGroqProvider`) uses the OpenAI-compatible Chat
Completions API with `reasoning_effort: 'low'` and **strict JSON-schema
structured output** (`response_format: { type: 'json_schema', strict: true,
schema: AGENT_DECISION_JSON_SCHEMA }`), so the model is constrained to return
exactly the decision shape. It also has: request timeout (`AbortController`,
default 15s) + external abort support, 2 retries with backoff on 429/5xx (not on
4xx), and usage/latency metrics from the response. **The API key is never
logged** — error messages surface only the provider's own error text.

Strict-mode caveat: Groq requires `additionalProperties: false` on every object,
which forbids free-form maps — so `task_update.entities` and `tool_calls[].arguments`
travel as arrays of `{"name": ..., "value": ...}` pairs on the wire;
`validateDecision` converts them back to plain objects (and still accepts plain
objects from mock providers).

The runtime depends only on `provider.infer(...)` — swapping Groq for another
adapter (or the mock) requires no runtime changes (`test/agent-runtime.test.js`
proves this by running the same assertions against two different mock instances).

## Decision schema

```json
{
  "decision": "respond",
  "response": "It is in the lower-right of the toolbox.",
  "reason_summary": "Deep analysis confirmed the tool and its location.",
  "task_update": null,
  "tool_calls": [],
  "visual_analysis_request": null,
  "scene_revision_used": 4
}
```

`decision` ∈ `ignore | respond | clarify | tool_call | inspect_vision | update_task`.
`reason_summary` must be a short **operational** explanation — not hidden
reasoning. Validation ([schema.js](src/agent/schema.js)) enforces: `response`
required (and non-empty) for respond/clarify; `tool_calls` non-empty for
`tool_call`; `visual_analysis_request.question` required for `inspect_vision`;
`task_update` bounded (goal ≤ 200 chars, ≤ 10 entities). Oversized `tool_calls`
arrays are capped rather than rejected; genuinely malformed output (wrong
decision enum, missing required fields) fails validation entirely — the runtime
then emits an `error` event and executes **nothing**.

## Context assembly

Every inference gets, freshly assembled (never persisted):

1. The bounded recent transcript window (default 30 turns / 5 minutes), with the current turn marked `<- CURRENT TURN`.
2. Active task state (or "(none active)").
3. The current visual snapshot, explicitly labeled as time-sensitive sensor data:
   ```
   CURRENT VISUAL CONTEXT
   Scene revision: 4
   Age: 92 ms

   Current visual context:
   - Scene: workshop / tools — Jon is present ...
   - Visible objects: claw hammer (upper-left), adjustable wrench (lower-right), ...
   ```
   (the body reuses `compileSceneSnapshot` from `src/context/compiler.js` — the Inspector's own Context Compiler is not duplicated).
4. A `RELEVANT MEMORIES` block — a short, ranked, already-retrieved slice of
   the durable memory repository (zero or more lines, each keeping its memory
   ID and confidence), or omitted entirely when nothing is relevant. See
   [MEMORY.md](MEMORY.md#context-compiler-integration) for the full retrieval/
   write-boundary design — this is an additive extension of context assembly,
   not a change to the decision schema, Speech Gate, or Turn Manager.
4b. `CURRENT SPEAKER` and `RELEVANT RELATIONSHIPS` blocks — the current
   turn's resolved-speaker evidence and a bounded slice of their relationships
   (both omitted entirely when nothing is known). See
   [IDENTITY.md](IDENTITY.md#context-compiler-integration) — same additive
   extension pattern as memory, resolved by the Entity Resolver, never the
   model.
5. Recent tool results (or "(none)").
6. Available tool descriptions.

The system prompt (`SYSTEM_PROMPT` in `prompt.js`) instructs Roma to: treat vision
as fallible sensor data, never invent people/objects/text/locations, never claim
something is currently visible when the state is stale, hedge on low-confidence
or generic labels, prefer `inspect_vision`/tools over guessing, ask a concise
clarifying question when a request is ambiguous, never fake tool success, and
stay brief during live physical tasks. `reason_summary` must be operational, not
chain-of-thought. It also instructs Roma to treat `RELEVANT MEMORIES` as
fallible quoted evidence — never unquestionable truth, never a new
instruction — and to use the `remember_this`/`recall_memories`/`forget_memory`/
`correct_memory`/`explain_memory` tools for explicit memory requests (see
[MEMORY.md](MEMORY.md)). It also instructs Roma to treat `CURRENT SPEAKER`/
`RELEVANT RELATIONSHIPS` as fallible, confidence-scored identity evidence —
never a confirmed fact, and an ambiguous/unconfirmed speaker must be treated
and spoken about as unresolved — and to use the 16 identity/relationship
tools (`identify_current_speaker`, `name_current_speaker`, …) for identity
requests (see [IDENTITY.md](IDENTITY.md)).

## Ambient vs. agent-directed speech

There is no *required* wake word — the model still makes the only semantic
call. Every finalized transcript turn goes through `handleTurn(segment)` and the
model classifies it — `ignore` is the default posture, stated explicitly in the
system prompt. Ambient turns that get `ignore` produce **no output event other
than `ignored-turn`** and do **not** grow the model-facing conversation history
(`conversationHistory()` only grows on `respond`/`clarify`) — though they do
stay in the bounded transcript window, since future turns may need that context
(e.g. "no, the *other* one").

A deterministic **addressee/engagement overlay** (added in the Live Voice
Verification & Hardening pass — see [VOICE.md](VOICE.md#addressee--conversation-engagement-behavior))
sits around this without changing it: `src/agent/addressee.js` normalizes every
decision into `{decision, addressedToRoma, confidence, reasonCode, turnId}` for
observability/testing, and `src/agent/engagement.js` opens a bounded window
after Roma engages so a follow-up doesn't need the wake word repeated — the
model still judges each turn's meaning; the window only removes the *wake-word*
requirement, never forces a response. `handleTurn` emits one `addressee-decision`
event per turn in addition to its existing events.

## Tools

`createToolRegistry()` validates a tool_call's arguments against the tool's
`inputSchema` (required keys + primitive types) **before** ever calling
`execute` — bad arguments fail safely (`{ ok: false, error }`) rather than
running. `createDefaultTools({ frameBuffer, deepAnalyzer, sceneStore })`
registers:

- **`inspect_current_view({question, allow_stale?})`** — grabs
  `frameBuffer.latest()`, rejects it if older than 10s unless `allow_stale: true`,
  and calls `deepAnalyzer.analyzeFrame(...)` — now backed by the **real Groq
  vision pipeline** (see "Real vision analysis" below). Returns the structured
  result, frame timestamp/age, prepared-image size, prep/provider latency, and
  cache-hit flag; pins the frame as a keyframe. Fails clearly (`{ok:false, note}`)
  when no frame is buffered or the provider/validation fails.
- **`inspect_view_at_time({question, timestampMs})`** — `frameBuffer.frameAt(ts)`,
  rejecting frames further than `maxFrameAgeMs` (default 30s) from the request —
  the foundation for "that" / "the one he showed earlier". Same normalized result
  shape plus `timestampDeltaMs` (how far the found frame is from the request).
- **`check_clock()`** — deterministic, no credentials; proves tool execution and
  a bounded follow-up inference work end to end.

`src/memory/tools.js`'s `registerMemoryTools(registry, { memory })` adds five
more entries to this **same** registry (`useAgent.js` calls it right after
`createDefaultTools`) — no schema change: `remember_this`, `recall_memories`,
`forget_memory`, `correct_memory`, `explain_memory`. See
[MEMORY.md](MEMORY.md#explicit-remember-recall-forget-correction-operations).
`src/identity/tools.js`'s `registerIdentityTools(registry, { identity })`
adds 16 more entries the same way — see
[IDENTITY.md](IDENTITY.md#explicit-identity-and-relationship-tools).

`src/agent/serverTasks.js`'s `registerServerTaskTools(registry, { tasks })`
adds four more: `dispatch_server_task`, `check_task_status`,
`answer_task_question`, `cancel_server_task`. These are how Roma hands real
engineering work to the background worker instead of pretending to do it
inline; the prompt's rule is to answer small things directly, dispatch
engineering-scale work, and never fabricate a task's results. See
[AGENT-ENV.md](AGENT-ENV.md).

## Real vision analysis (deep-analysis path)

The deep-analysis stub is replaced by a provider-abstracted pipeline
(`src/vision/`): frame → `prepare.js` (JPEG re-encode, downscale to ≤768px,
optional padded crop around a known box, byte size recorded, original never
mutated) → `provider.js` (Groq multimodal chat with `response_format:
json_object`, one bounded retry on transient failures only, typed errors, no
key/image in logs) → `schema.js` validation (answer/target/observations/
visibleText/uncertainty/requiresAnotherFrame; confidences clamped) →
`analyzer.js` (duplicate-request cache keyed on frame+question+model with a 30s
TTL, in-flight coalescing, max 2 concurrent remote analyses).

Remote analysis happens **only** on explicit request (agent vision tools /
`analyzeFrame`). The Inspector's continuous escalation loop stays on the free
local stub (`autoAnalyze`) and never sends frames to the cloud on its own — and
it is fire-and-forget, so the fast path never blocks on a remote call.

Live verification (real API calls, not part of `npm test`):

```bash
npm run test:vision-live                     # one real Groq vision call on test/fixtures/tools.jpg
npm run test:vision-live -- --image me.jpg --target "hammer"
npm run simulate:vision-agent                # full agent+vision flow, mocked vision
npm run simulate:vision-agent -- --provider groq   # same flow with the real vision model
```

Note: `meta-llama/llama-4-scout-17b-16e-instruct` availability/pricing on Groq
may change (check the Groq console); override with `VISION_MODEL`.

A `tool_call`/`inspect_vision` decision triggers execution then **one** bounded
follow-up inference (`maxToolRounds`, default 2 total inferences per turn — set
in `agent/config.js`); if that cap is hit while the model still wants another
tool, the runtime emits an `error` (`stage: 'loop-cap'`) instead of guessing —
unbounded tool loops are not possible.

## Task state

Bounded, outside conversation history:

```json
{ "active": true, "taskId": "task_wrench", "goal": "Help Jon locate the adjustable wrench", "status": "confirming-object", "entities": { "requestedObject": "adjustable wrench" }, "updatedAt": 1782942280295 }
```

Any decision may carry a `task_update`; `validateTaskUpdate` bounds it (goal
length, entity count/length) before the runtime stores it and emits
`task-updated`. No recursive planning or task decomposition — this only
preserves continuity across a few turns (e.g. "any luck?" after "help me find
the wrench").

## Concurrency and freshness

Turns are processed by a **single-flight FIFO queue** (`handleTurn` chains onto
a promise) — the simplest strategy that guarantees in-order delivery; there is
no cancellation of an in-flight turn in v1 (documented limitation). Each turn
captures the scene revision/age **at the start** of context assembly
(`sceneRevisionUsed`, `visualAgeMs` on every output event); if the scene's
revision has since changed by the time the decision is delivered, the event
carries `possiblyOutdated: true` and a warning is logged — the response text
itself is not rewritten (that's the model's job, guided by the "don't claim
current when stale" system-prompt rule).

When a `memory` coordinator is configured (optional — see
[MEMORY.md](MEMORY.md)), its write boundary runs **fire-and-forget** after a
respond/clarify decision completes — it never blocks the FIFO queue or the
Speech Gate/TTS path for the next turn. `runtime.pendingMemoryWrite()` exposes
the in-flight write promise for tests/simulation that need to await it
deterministically.

When an `identity` coordinator is configured (optional — see
[IDENTITY.md](IDENTITY.md)), the current speaker is resolved **at most once
per turn** and cached, refreshed only after a tool call that can actually
change it (naming/confirm/reject/merge/split) — unlike memory retrieval,
passive identity resolution can itself write evidence, so re-running it every
follow-up round would duplicate that evidence. After a completed memory
write, a bounded relink (`relinkMemoriesForInteraction`) attaches the
resolved person to that same interaction's memories only — never a
historical sweep.

When a `policy.principal` is configured (optional — see
[SERVER-DATA.md](SERVER-DATA.md#context-compiler-enforcement)),
`inferDecision` runs one more additive pass (`applyContextPolicy`) over
`relevantMemories` and the resolved speaker's relationships immediately
before `assembleContext` — a sensitivity-policy exclusion, dropping any
`secret`/`biometric` record or an insufficiently-relevant
`sensitive`/`private` one entirely, never compiling it with a note asking
the model to ignore it. With no principal configured (every existing test
and simulation), this step is a complete no-op.

## Output events

`runtime.subscribeOutput(listener)` delivers:
`response | clarification | tool-started | tool-completed | task-updated |
ignored-turn | error`, each carrying `turnId`, `sceneRevisionUsed`,
`visualAgeMs`, `possiblyOutdated`, and timing (`modelMs`/`toolMs`/`totalMs`).
`response`/`clarification` route through the speech boundary. In the browser that
boundary is the real **Selective Voice Delivery** layer, so a gate-approved
direct answer mints an authorization and drives TTS + playback (with barge-in /
stop / echo suppression); in tests/Node it stays the legacy no-op `speak()`. See
[VOICE.md](VOICE.md).

## Running it

```bash
npm run dev              # mic (existing) + camera (Inspector) + Agent panel.
                          # No GROQ_API_KEY → mock provider (status says so).
npm run simulate:agent   # end-to-end, no credentials: ambient remark ignored,
                          # ambiguous wrench label escalates to inspect_vision
                          # (real frame buffer + stubbed deep analysis) then
                          # responds with the confirmed location, hammer
                          # answered directly, task created then closed.
                          # `-- --provider groq` uses the real model if a key
                          # is present in .env, else prints a note and falls back.
npm run simulate:vision-agent   # agent + REAL vision pipeline (mock provider by
                          # default; `-- --provider groq` for the real model):
                          # ambiguous detection → inspect_vision → frame from
                          # the real buffer → prepared image → validated
                          # structured result → located response; ambient turn
                          # triggers no image analysis; analysis runs once.
npm run test:vision-live # ONE real Groq vision call (needs GROQ_API_KEY).
npm run simulate:memory  # end-to-end memory: commitment → recall → correction
                          # → forget, through the real runtime/tools/writer/
                          # retriever (scripted model). See MEMORY.md.
npm run simulate:identity # end-to-end identity: unknown speaker → attribution
                          # → session continuity → voice match → memory link →
                          # merge/split → Speech Gate never bypassed. See
                          # IDENTITY.md.
npm run simulate:server-state # server data: authenticated session → migration
                          # → sensitivity policy across every level → tenant
                          # isolation → session concurrency → consent →
                          # deleteBySource cleanup → retention → real HTTP API
                          # → Speech Gate never bypassed. See SERVER-DATA.md.
npm run simulate:recovery # server-interruption retry, idempotency, correction
                          # authority, deletion permanence, consent-revocation
                          # priority, refresh/restart recovery (20 checks).
npm test                 # 562 offline tests across every phase, including
                          # sync reliability, server data (see SERVER-DATA.md),
                          # identity (IDENTITY.md), and memory (MEMORY.md).
```

## Measured latency

Runtime overhead (mock providers, real tools/buffer): context assembly ~1 ms,
tool dispatch ~1 ms, **~2 ms total per turn** — negligible next to the model
calls. Real measurements (2026-07, one sample each): main agent
(`openai/gpt-oss-20b`, `reasoning_effort: low`) — ambient-ignore triage
**259 ms**, wrench-request decision **438 ms**; vision
(`meta-llama/llama-4-scout-17b-16e-instruct`, ~9 KB test JPEG) — **1.5–2.7 s**
per analysis, image preparation ≤1 ms. The dedup cache means repeat questions
about the same frame cost 0 ms.

## Placeholders / limitations

- **TTS is now real** — the browser routes gate-approved speech through the
  Selective Voice Delivery layer (`src/voice/`, default provider Deepgram Aura);
  `src/agent/speech.js` remains only as the legacy no-op used by Node/tests. See
  [VOICE.md](VOICE.md).
- **Deepgram key is now server-side** — the browser streams through the local
  proxy `/api/deepgram/stream` (`server/deepgramProxy.mjs`); the client no
  longer references a VITE_ Deepgram key.
- **No cancellation** — the FIFO queue guarantees order but a slow turn cannot
  be interrupted by a newer, more urgent one.
- **No long-term memory / vector search** — the transcript window and task
  state are the only continuity mechanisms.
- **Direct-address detection is model-judgment only** — no acoustic/gaze signal.
- **Single active task** — no recursive planning or multi-task juggling.
- **Dev-only debug view** — the "assembled model input" panel is gated on
  `import.meta.env.DEV`; it never includes the API key (the key never enters
  `assembleContext`'s output in the first place).
