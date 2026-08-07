# Roma AI — Engineering Handoff

Last reconciled: **2026-08-06**, wearer-and-server-agent phase, P3 (Claude).
This file is the authoritative orientation document. The per-subsystem
design docs it links are accurate as of the same date.

## 1. Current verified state (measured, not copied)

| Check | Result |
|---|---|
| Offline tests | **683/683 pass** (56 files, ~3 s, `npm test`) |
| Deterministic simulations | **11/11 pass** (see §10) |
| Virtual-hardware lab | **13/13 scenarios pass** closed-loop through real Deepgram/Groq/gate/TTS/COCO-SSD on virtual `MediaStream` devices, + 17-check smoke (`verify:virtual-lab`; see [VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md)) |
| Wearer + dispatch round-trip | **5/5 assertions** with the mock worker (`agent_task_dispatch_roundtrip`, 3/3 consecutive) AND with the REAL Qwen CLI (`dispatch_real_qwen_smoke`, 2/2) — spoken request → classification → dispatch → completion, no progress chatter |
| Real Qwen Code worker | **15/15 checks** live, both modes, on `qwen3-coder-plus` with its own configured credential (`verify:qwen-worker -- --write`, 2026-08-06; see [AGENT-ENV.md](AGENT-ENV.md)) |
| Production build | ✓ Vite 8.0.16 — ~465 kB JS (~145 kB gzip); simulation code and worker internals proven absent from the bundle |
| Bundle secret scan | ✓ no key values, no `node:sqlite`, no DB paths, no dev headers, no simulation markers, no worker/CLI strings |
| Runtime | Node v24.18.0 x64 win32 (npm 11.16.0); `node:sqlite` works; Chrome 150 + Edge 150 for the lab |
| DB schema | `0004_agent_environment` (migrations idempotent; real dev DB upgraded in place, data preserved) |
| Live dev-server check | ✓ real Groq agent + live Deepgram voice catalog + memory write→queue→SQLite→recall, zero console errors |
| Physical mic/camera | Software integration path **closed-loop verified virtually**; physical pass remains recommended for hardware/room calibration, required for biometric-accuracy claims ([HARDWARE-VERIFICATION.md](HARDWARE-VERIFICATION.md)) |

Environment quirks of this dev box:

- `node` and `npm` **are** on PATH now (`C:\Program Files\nodejs`, Node 24.18.0
  / npm 11.16.0). Earlier notes in this file said otherwise; that is fixed.
- Qwen Code 0.20.1 is installed at `%LOCALAPPDATA%\qwen-code\qwen-code`; the
  worker finds it automatically. This box is currently configured with
  `AGENT_WORKER=qwen` and a scoped `AGENT_WORKER_API_KEY` in `.env`, so
  background tasks run the real CLI in normal dev sessions (tests still force
  the mock). The worker uses a private `QWEN_HOME` and does **not** use the
  personal credentials in `~/.qwen`.
- `ffmpeg` is **not installed**. Only `scripts/stream.mjs` and fresh-clip
  extraction in `simulate:voice-identity` want it (the latter falls back to
  cached `.testdata/*.pcm` fixtures automatically).
- The user's `.env` still uses legacy `VITE_DEEPGRAM_API_KEY`/`VITE_GROQ_API_KEY`
  names — accepted with a startup rename warning; keys are NOT leaked to the
  bundle (verified — no client file references them, so Vite never inlines).
- `BIOMETRIC_ENCRYPTION_KEY` is not set in `.env` — voice identity currently
  fails closed on this machine (by design; set it per `.env.example`).

## 2. Architecture and data flow

```
 BROWSER                                       IN-PROCESS NODE SERVER (Vite plugins)
 mic → audio.js (PCM16 @16k) ── WS ──────────► /api/deepgram/stream ─► Deepgram nova-3
   ◄─ interim + finalized diarized words ◄─────┘        (server-side key)
 engine/segmenter.js → speaker-labeled turns
        │                                      /api/agent/infer ──► Groq (gpt-oss-20b)
 camera → inspector/* → Live Scene State       /api/vision/analyze ► Groq (llama-4-scout)
        │                     │                /api/opportunity/evaluate ► Groq
        ▼                     ▼                /api/tts/synthesize ► Deepgram Aura
 agent/runtime.js (FIFO turn queue)            /api/tts/voices ► live catalog
   context: transcript window · task state     /api/data/* /api/session /api/consent
   · scene snapshot · RELEVANT MEMORIES        /api/migration /api/retention /api/audit
   · CURRENT SPEAKER (all ephemeral)           /api/admin /api/preflight
        │ strict-JSON decision                 /api/voice/* (bounded biometric ops)
        ▼                                                │
 proactive engine ─► intervention policy                 ▼
        └──► SPEECH GATE (deterministic, sole authorizer) auth boundary → sensitivity
                │ minted authorization                    policy → SQLite (data/roma.db)
                ▼                                         17+ tables · WAL · migrations
 voice/delivery.js → turn manager → TTS → playback        append-only audit · tombstones
                                                          AES-256-GCM voice templates
 durable writes: local mirror (sync) + MUTATION QUEUE ───► idempotency ledger
   (operation IDs · retry/backoff · visible states)        (tenant-scoped)
```

## 3. Subsystem ownership map

| Area | Code | Doc | Tests |
|---|---|---|---|
| STT + segmentation | `src/engine/`, `src/audio.js` | old HANDOFF §3 (superseded), [README](README.md) | `deepgram`, `audio`, `live-voice` |
| Visual perception | `src/inspector/`, `src/context/compiler.js` | [INSPECTOR.md](INSPECTOR.md) | `inspector`, `compiler` |
| Reactive agent | `src/agent/`, `src/vision/`, `src/useAgent.js` | [AGENT.md](AGENT.md) | `agent*`, `schema`, `tools`, `provider`, `vision` |
| Proactive layer | `src/proactive/`, `src/useProactive.js` | [PROACTIVE.md](PROACTIVE.md) | `proactive*` |
| Voice delivery | `src/voice/`, `src/useVoiceDelivery.js` | [VOICE.md](VOICE.md) | `voice*` |
| Memory | `src/memory/`, `src/useMemory.js` | [MEMORY.md](MEMORY.md) | `memory-*` |
| Identity | `src/identity/`, `src/usePeople.js` | [IDENTITY.md](IDENTITY.md) | `identity-*` |
| Server data + policy | `server/`, `src/policy/`, `src/server/`, `src/useServerData.js` | [SERVER-DATA.md](SERVER-DATA.md) | `server-*`, `policy-sensitivity`, `sync-reliability` |
| Voice identity | `server/voiceIdentity/`, `src/useVoiceIdentity.js` | [VOICE-IDENTITY.md](VOICE-IDENTITY.md) | `voice-identity` |
| Sync reliability | `src/server/mutationQueue.js` + queue wiring | [SERVER-DATA.md](SERVER-DATA.md#stabilization-update-2026-07-reliable-browserserver-synchronization) | `sync-reliability` |
| Virtual hardware lab | `src/simulation/`, `scripts/lib/{virtualLab,chrome,simServer,voices,wav,reports}.mjs`, `scripts/*virtual*.mjs` | [VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md) | `simulation-schema`, `simulation-lab` |
| Wearer perception | `src/agent/wearer.js`, `src/agent/addressee.js`, `src/agent/directAddress.js`, `src/agent/prompt.js` | [AGENT.md](AGENT.md) | `wearer`, `direct-address` |
| Server agent env | `server/agentEnv/`, `server/routes/agentTasks.mjs`, `src/agent/serverTasks.js`, `src/agent/taskNotifier.js`, `src/useAgentTasks.js` | [AGENT-ENV.md](AGENT-ENV.md) | `agent-env`, `task-notifier`, `qwen-worker` |

## 4. Important invariants (do not break)

1. **Models advise; deterministic code decides.** Speech approval, identity
   resolution, memory evidence rules, sensitivity policy, and sync conflict
   handling are all code.
2. **No audio without a Speech-Gate-minted authorization.** No code path
   reaches TTS/playback otherwise.
3. **All secrets server-side; never `VITE_`-prefixed.** Security tests fail
   the suite on violation.
4. **Everything model-facing is ephemeral and quoted.** Memories/identity/
   scene context are rebuilt per turn as data, never instructions.
5. **The segmenter stays pure** (no browser globals) so Node harnesses test
   the exact production code.
6. **Diarization labels are transient**; only explicit operations create or
   confirm identities.
7. **A mutation is durable only after server acknowledgement**; the queue's
   states are visible; deletions cannot be resurrected; corrections outrank
   older retries; biometric ops are never queueable/replayable.
8. **Production fails closed** — auth without a verifier, voice identity
   without its key, storage without a reachable server: all visible, none
   silently degrade to localStorage authority.
9. **Additive phases.** Prior modules are extended through their existing
   interfaces, not redesigned.
10. **A background worker has no route to the wearer.** It cannot speak,
    authorize speech, decide urgency, reach personal memory, or receive Roma's
    secrets; its tool surface is verified against what was granted and the run
    is refused if it is wider. Engineering memory and personal memory have no
    code path between them, in either direction.
11. **Write-mode work needs explicit approval and never touches the wearer's
    working tree** — it runs in a disposable git worktree and comes back as a
    patch.

## 5. Repository layout

```
src/                     browser app (React 19, no framework beyond Vite)
  engine/ audio.js       STT streaming + segmentation (pure logic in segmenter.js)
  inspector/ context/    visual fast path + scene store + snapshot compiler
  agent/ vision/         runtime, schema, prompt, providers, tools
  proactive/             opportunity engine, policy, speech gate, suggestions
  voice/                 authorization, turn manager, TTS, playback, echo, stop
  memory/ identity/      schemas, repositories, writers/resolvers, coordinators, tools
  policy/sensitivity.js  six-level sensitivity policy engine (shared client/server)
  server/                dataClient, mutationQueue, remote repositories, preflight
  use*.js                one React hook per subsystem; main.jsx composes them + panels
server/                  in-process API (Vite plugins; keys + SQLite live here)
  groqApi.js             /api/health|agent|vision|opportunity|tts routes
  deepgramProxy.mjs      /api/deepgram/stream WS proxy (+ bounded voice-capture tap)
  auth.mjs env.mjs       principal resolution; env loading (legacy-name fallbacks)
  db/                    openDatabase + migrations/0001..0004 (idempotent, ledgered)
  repositories/          memory, identity, audit, consent, session, retention,
                         deletion, operationLedger — all forWorkspace()-scoped
  routes/dataApi.mjs     ~40 authenticated routes + idempotent-replay wrapper + preflight
  routes/agentTasks.mjs  /api/agent-tasks|agent-projects|agent-memory
  agentEnv/              engineering memory, task store, dispatcher,
                         workers/{adapter,mock,qwenCode,qwenProtocol}
  voiceIdentity/         WavLM provider, sample manager, AES-GCM crypto, service
  migration/             localStorage → SQLite import (dry-run/import/verify)
scripts/                 11 simulate-*.mjs + stream/transcribe/preflight + live checks
                         + verify-virtual-lab / verify-qwen-worker
test/                    56 offline test files (node --test)
*.md                     README + this file + 9 subsystem docs + HARDWARE-VERIFICATION
```

## 6. Server routes (families)

`/api/health` `/api/agent/infer` `/api/vision/analyze` `/api/opportunity/evaluate`
`/api/tts/synthesize` `/api/tts/voices` — provider proxies (groqApi.js).
`/api/deepgram/stream` — STT WebSocket proxy.
`/api/data/memory*` `/api/data/people*` `/api/data/evidence` `/api/data/relationships*`
`/api/data/identity/export` — CRUD/search/export, sensitivity-filtered, rate-limited.
`/api/session/*` — optimistic-concurrency session state.
`/api/consent*` — grant/revoke (revoke freezes linked voice profiles).
`/api/voice/*` — bounded biometric ops (loopback-only in dev, 12/min, never
idempotent-replayed, legacy opaque routes return 410).
`/api/migration/*` `/api/retention/cleanup` `/api/audit` (dev-only read)
`/api/admin/workspace/*` `/api/preflight`.
`/api/agent-tasks*` — background task create/list/get/respond/cancel + health
(same auth boundary, tenant scoping, rate limiting; dispatch limited to 10/min).
`/api/agent-projects` `/api/agent-memory` — the project allowlist and
engineering memory (dev/admin surface).
Mutation routes honor `X-Roma-Operation-Id` (tenant-scoped replay); memory
create/update refuse tombstoned IDs (409 `record_deleted`).

## 7. Database

SQLite via `node:sqlite`, `data/roma.db` (WAL) or `:memory:` in tests.
Migrations in `server/db/migrations/`, run on every open, tracked in
`schema_migrations`: `0001_init` (17 tables), `0002_voice_identity`
(`voice_templates` + capture bookkeeping), `0003_sync_reliability`
(`operation_ids` rebuilt with composite `(operation_id, workspace_id)` key),
`0004_agent_environment` (`eng_projects`, `eng_memory`, `agent_tasks` —
deliberately separate tables from personal memory, with no join between them).
Application IDs are the TEXT primary keys. Identity data is normalized
(aliases/evidence/relationships/links as real FK tables; person arrays are
derived by JOIN). Hard deletes cascade links and write tombstones; soft
deletes are retention-only; both are distinguishable.

## 8. Configuration

See `.env.example` (names + docs, no values): `DEEPGRAM_API_KEY`,
`GROQ_API_KEY` (+ optional model overrides), TTS overrides, `AUTH_MODE`,
dev principal IDs, `BIOMETRIC_ENCRYPTION_KEY(_VERSION)`, voice-identity
model pins, `VITE_`-safe non-secret voice tuning. `npm run preflight`
(CLI) and `GET /api/preflight` (+ the Server Data panel button) report
subsystem states without secrets.

`AGENT_WORKER` selects the background worker engine and defaults to `mock`
(deterministic, no subprocess). `AGENT_WORKER=qwen` runs the real Qwen Code
CLI; `AGENT_WORKER_CMD` overrides how it is located (must point at a JS entry
or a real executable — a `.cmd` shim is refused because it would need a shell).
`AGENT_WORKER_API_KEY` (+ `_API_BASE`, `_MODEL`) is the worker's **own**
provider credential: it runs with a private `QWEN_HOME` and cannot borrow the
developer's `~/.qwen` login, so without this key every task fails by design.
The worker's environment is an allowlist, so none of the other keys reach it —
and `selectWorker()` forces the mock in any test run whatever `.env` says.

## 9. Provider selection truth table

| Concern | Real provider | Fallback (always labeled) |
|---|---|---|
| STT | Deepgram nova-3 (proxy) | none — transcription unavailable |
| Agent/extraction/opportunity | Groq `openai/gpt-oss-20b` | scripted mock (Agent panel says so) |
| Vision | Groq `llama-4-scout-17b` | canned stub (Inspector's free path) |
| TTS | Deepgram Aura (`aura-2-thalia-en`, live catalog) | mock in Node/tests |
| Speaker embeddings | local WavLM `Xenova/wavlm-base-plus-sv` (q8, CPU, server) | fails closed without key |
| Memory embeddings | **none** — keyword/structured retrieval is the real path | mock embedder in tests only |
| Durable storage | server SQLite | dev-only labeled localStorage; production fails closed |
| Face recognition | **not implemented** | placeholder returns nobody |
| Background engineering worker | Qwen Code CLI (`AGENT_WORKER=qwen`) | deterministic mock worker (**the default**, labeled `mock` wherever it surfaces) |

## 10. Test and simulation inventory (verified 2026-08-05)

**Offline: 683 tests, 56 files, all passing.** Families: engine/audio,
inspector/compiler, agent (schema/runtime/tools/provider/vision), wearer +
direct-address, proactive, voice (units/delivery/integration/security/
live-voice), memory (8 files), identity (9), server (13), policy,
voice-identity, sync-reliability (21), simulation (schema/lab), agent-env (18),
task-notifier (15), qwen-worker (34).

**Simulations (registered in package.json):**

| Script | Checks | Notes |
|---|---|---|
| simulate | 8 scenario PASSes | Inspector→agent snapshot |
| simulate:agent | scripted storyline | mock provider by default |
| simulate:vision-agent | scripted storyline | real vision with `--provider groq` |
| simulate:proactive-agent | 12 | |
| simulate:selective-voice | 12 | |
| simulate:live-conversation | 12 | |
| simulate:memory | 24 | |
| simulate:identity | 41 | |
| simulate:server-state | 28 | real HTTP + file DB parts |
| simulate:voice-identity | 33 | real WavLM; ffmpeg or cached PCM fixtures |
| simulate:recovery | 20 | new: outage/retry/idempotency/recovery |

Live-API scripts (cost credits, not in `npm test`): `test:vision-live`,
`test:tts-live`, `stream:test`, `transcribe:file`, `verify:qwen-worker`
(10 checks readonly, 15 with `-- --write`).

## 11. Real-hardware verification

**Pending, user-assisted** — the automation sandbox has no microphone or
camera access (verified: permission `denied` via the in-app preflight).
[HARDWARE-VERIFICATION.md](HARDWARE-VERIFICATION.md) contains the exact
checklist (mic conversation loop, camera/Inspector, two-speaker voice
identity, measurements to record). Everything software-side behind those
devices is verified via the harness + simulations, including a live
dev-server session with real Groq/Deepgram and the full memory
write→queue→SQLite→recall loop (zero console errors).

## 12. Known mocks, placeholders, heuristics

Face identification (placeholder returns nobody) · scene interpreter
(templates) · COCO-SSD 80 generic classes · greedy-IoU tracking · keyword
(not semantic) memory retrieval · lexical echo/dedup detection ·
quiet-gap heuristic for `speak_when_convenient` · heuristic VAD/overlap
in voice capture · exact-fingerprint replay check (not liveness) ·
in-process rate limiting · dev-mode auth principal · the **mock worker is the
default** background engine (real work needs `AGENT_WORKER=qwen`).

## 13. Known limitations

Single-writer local SQLite; no TLS; no production token verifier (fails
closed); no field-level encryption (no key-management design yet); voice
calibration tiny/local; TTS synthesized whole; no in-flight turn
cancellation; single active task; `GET /api/audit` dev-only; the client
policy pass is defense-in-depth (the hard boundary is server-side); one
background engineering task at a time, whose write mode auto-approves shell
commands inside its isolated worktree (the isolation is the worktree plus the
wearer's approval, not a sandbox — [AGENT-ENV.md](AGENT-ENV.md)).

## 14. Worktree state and commit plan

**Everything beyond the original transcription demo is uncommitted.** The
5 existing commits end at the old "diarization benchmark" stage; the
worktree deletes that era's files (`backend/`, benchmark scripts) and adds
~100 new source/test/script files plus these docs.

**Recommendation: one verified baseline commit, not fabricated per-phase
history.** The phases were built incrementally *in the same files* —
`src/main.jsx`, `src/agent/runtime.js`, `src/agent/prompt.js`,
`package.json`, `server/routes/dataApi.mjs` each contain interleaved work
from 4–8 phases. Splitting them into per-phase commits would require
hand-crafting intermediate file states that never existed and were never
tested — misleading history with zero verification. The honest structure:

1. `feat: Roma AI verified baseline — perception, agent, voice, memory,
   identity, server persistence, voice identity, sync reliability, virtual
   hardware lab, wearer-centric perception, background engineering agent`
   (everything currently modified/untracked except the exclusions below,
   including the `backend/`+benchmark deletions and all docs).
2. Future work proceeds as ordinary focused commits from that baseline.

Must stay uncommitted/ignored: `.env` (real keys), `data/*.db`,
`.testdata/`, `.bench-audio/`, `roma-tts.mp3`, `dist/`, `node_modules/`,
`.claude/` (machine-specific launch config — add `.claude/` to .gitignore
before committing, or commit a sanitized launch.json), `.agents/`,
`.codex/`. `VOICE-IDENTITY.ja.md` is a translation of VOICE-IDENTITY.md —
include it. Do **not** commit without explicit authorization.

## 15. Exact next phase

Facial recognition was explicitly deferred until after stabilization, the
virtual-hardware lab, and the wearer/server-agent phase. All three are done
(P1 wearer-centric perception, P2 task dispatch, P3 real Qwen worker — see
[PLAN-WEARER-AND-SERVER-AGENT.md](PLAN-WEARER-AND-SERVER-AGENT.md) and
[AGENT-ENV.md](AGENT-ENV.md)). Before starting it: (1) make the
baseline commit above; (2) set `BIOMETRIC_ENCRYPTION_KEY` in `.env` so voice
identity runs for real in normal dev sessions; (3) optionally run the
physical checklist for hardware calibration. The face phase then follows the
already-prepared extension points — a face provider mirroring
`voiceProvider.js`'s interface, `future_face_match` evidence through the
existing resolver, `faceProfileIds` on the person schema, consent +
sensitivity + encrypted-template patterns identical to voice — and should be
developed AGAINST the virtual lab from day one: rendered/licensed face
assets in the video engine, enrollment-consent scenarios, cross-modal
face+voice timing, and photo-replay adversarial cases (see
[VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md) "Toward facial recognition").
Two smaller increments also queued: automating the People-panel voice-
enrollment click-through inside the lab, and fixing the React duplicate-key
warning the lab surfaced during camera sessions.
