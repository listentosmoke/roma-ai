# Roma AI — a local, voice-first ambient assistant

Roma listens continuously (and optionally watches through a camera), shows a
live speaker-labeled transcript, decides on her own whether she is being
addressed, answers out loud, remembers things durably, and keeps auditable
records of who people are — all running locally as a Vite + React app with an
in-process Node server that holds every API key and a SQLite database.

## Current capabilities

- **Live transcription + diarization** — Deepgram `nova-3` streaming through a
  local server proxy; turns split on real speaker changes, not every pause.
- **Visual perception (Inspector)** — webcam → in-browser COCO-SSD object
  detection → tracked "Live Scene State" + a rolling frame buffer; the agent
  reads a compact scene snapshot at think-time. Recognised people are named in
  the snapshot; the scene interpreter itself is still template-based.
- **Reactive agent** — every finalized turn is classified by a Groq-hosted
  model (`openai/gpt-oss-20b`) under a strict JSON decision schema:
  ignore / respond / clarify / tool call / vision inspection / task update.
  Wake-word-free follow-ups via a bounded engagement window.
- **Wearer-centric perception** — Roma is worn by one person and is rarely
  addressed directly, so every turn is also classified for *who it was
  addressed to* (Roma / the wearer / someone else / background), whether the
  wearer is expected to answer, and whether there is something worth quietly
  offering them. The wearer is resolved from evidence and is never guessed
  from a single utterance.
- **Background engineering tasks** — Roma can hand real engineering work
  (reading a codebase, running tests, debugging) to a worker in the server
  process, acknowledge it out loud, stay quiet while it runs, and speak again
  only when it needs the wearer or finishes. Separate engineering memory,
  a project allowlist, and a replaceable worker engine — see
  [AGENT-ENV.md](AGENT-ENV.md).
- **Proactive assistance** — an Opportunity Engine proposes coaching; a
  deterministic intervention policy + Speech Gate decide delivery. Model
  recommendations can only ever be downgraded.
- **Selective voice delivery** — no audio plays without a Speech-Gate-minted
  authorization. Deepgram Aura TTS, barge-in, deterministic stop phrases,
  echo suppression, live voice catalog.
- **Episodic memory** — evidence-ranked structured records with corrections,
  supersession chains, and ranked retrieval, stored server-side in SQLite.
  Retrieval is **semantic**: a local MiniLM encoder runs server-side (text
  never leaves the machine), so "when is that write-up due" finds "the Q3
  report is due Friday" with no shared words. Measured 5/7 against keyword
  overlap's 2/7 on real questions (`npm run verify:embeddings`); without the
  model, retrieval falls back to keyword scoring rather than failing.
- **Entity resolution + relationships** — stable person records, aliases,
  evidence chains; diarization labels are never auto-promoted to identities.
- **Facial recognition** — local InsightFace (SCRFD + ArcFace, 512-d) running
  server-side through onnxruntime; templates never leave the machine and are
  stored unencrypted at rest, relying on full-disk encryption (migration 0006
  records that trade). Per-frame identity is smoothed by temporal voting, and
  a match becomes `face_match` **presence** evidence in the identity resolver:
  because the camera is worn and looks outward, a face can corroborate or
  contradict a voice match but never decides who is speaking on its own. A
  match is *evidence*, never authentication, there is **no liveness
  detection**, and **consent enforcement is currently OFF**
  (`FACE_IDENTITY_REQUIRE_CONSENT=1` restores it). Models are non-commercial
  research use. See [PLAN-FACE-IDENTITY.md](PLAN-FACE-IDENTITY.md).
- **Real voice identity** — explicit, consented speaker enrollment with a
  local WavLM encoder (audio never leaves the machine); AES-256-GCM-encrypted
  templates; probabilistic matching that is *evidence*, never authentication.
- **Server persistence + policy** — authenticated SQLite data API with tenant
  scoping, a six-level sensitivity policy, consent, retention, tombstones,
  and an append-only audit log.
- **Reliable browser/server sync** — every write is a tracked, idempotent,
  retryable operation with visible pending/failed states (see
  [SERVER-DATA.md](SERVER-DATA.md)).
- **Virtual hardware lab** — an autonomous hardware-in-the-loop simulator:
  virtual rooms produce real audio samples and rendered video frames that
  enter through the browser's actual `getUserMedia` boundary, driving the
  real Deepgram/Groq/gate/TTS/COCO-SSD pipeline closed-loop, with declarative
  scenarios, fault injection, and parameter sweeps (see
  [VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md)).

## Architecture (one paragraph)

The browser does perception and interaction; the in-process Node server
(Vite plugins — no second process) holds the secrets and the database.
Mic → PCM16 → `/api/deepgram/stream` proxy → segmenter → agent runtime →
Groq via `/api/agent/infer` → deterministic Speech Gate → TTS via
`/api/tts/synthesize` → playback. Durable state (memories, people,
relationships, evidence, consent, voice templates) lives in SQLite behind
`/api/data/*`; the browser keeps a synchronous in-memory mirror hydrated
from the server and pushes writes through a reliable mutation queue.
Detailed design docs: [AGENT.md](AGENT.md), [INSPECTOR.md](INSPECTOR.md),
[PROACTIVE.md](PROACTIVE.md), [VOICE.md](VOICE.md), [MEMORY.md](MEMORY.md),
[IDENTITY.md](IDENTITY.md), [SERVER-DATA.md](SERVER-DATA.md),
[VOICE-IDENTITY.md](VOICE-IDENTITY.md), [AGENT-ENV.md](AGENT-ENV.md).

## Requirements

- **Node.js ≥ 24** (`node:sqlite` is built in; `.nvmrc` and `engines` say 24).
- Windows / macOS / Linux; developed on Windows 10.
- Chrome or Edge for the app (mic + camera permissions).
- A microphone (transcription), optionally a webcam (Inspector).
- API keys: [Deepgram](https://console.deepgram.com) (STT + TTS, free credit)
  and [Groq](https://console.groq.com) (agent + vision).
- `ffmpeg` on PATH is optional — only the voice-identity simulation and the
  streaming test harness use it (the simulation falls back to cached
  fixtures without it).

## Setup

```bash
npm install
cp .env.example .env     # then fill in the two keys
npm run preflight        # verifies node/db/keys/config — states only, no secrets
npm run dev              # open the printed URL in Chrome/Edge
```

`.env` is gitignored and read only by the server process. **No key is ever
`VITE_`-prefixed** — the test suite fails if client code can see one.
Legacy `VITE_GROQ_API_KEY`/`VITE_DEEPGRAM_API_KEY` entries still work but
log a rename warning at startup.

First startup notes:

- The SQLite database is created automatically at `data/roma.db` (gitignored)
  and migrations run on every start (idempotent).
- Click **Start** to begin listening — the click also unlocks browser audio
  so Roma's replies can actually play.
- The camera button starts the Inspector; the first start downloads TF.js +
  COCO-SSD (~6 MB) from a CDN.
- Voice identity requires `BIOMETRIC_ENCRYPTION_KEY` (32-byte base64) in the
  server environment — without it, that one subsystem fails closed and
  everything else still works. See [VOICE-IDENTITY.md](VOICE-IDENTITY.md).

## Authentication warning

`AUTH_MODE` defaults to **development**: a fixed deterministic principal,
clearly labeled in the UI, that is **NOT** production authentication.
`AUTH_MODE=production` fails closed (401 on every data request) until a real
token verifier is wired into `server/auth.mjs`. Do not expose this app to
untrusted users as-is.

## Tests, simulations, build

```bash
npm test                  # full offline suite (757 tests, ~3s, no network/keys)
npm run build             # production bundle (dist/)
npm run preflight         # server-side startup health check

# Deterministic end-to-end simulations (no credentials needed):
npm run simulate                    # Inspector + scene → agent snapshot
npm run simulate:agent              # reactive agent decision loop
npm run simulate:vision-agent       # agent + vision pipeline
npm run simulate:proactive-agent    # opportunity → policy → delivery (12 checks)
npm run simulate:selective-voice    # speech gate → TTS → playback (12 checks)
npm run simulate:live-conversation  # full conversation flow (12 checks)
npm run simulate:memory             # remember/recall/correct/forget (24 checks)
npm run simulate:identity           # people/evidence/merge/split (41 checks)
npm run simulate:server-state       # persistence/policy/consent (28 checks)
npm run simulate:voice-identity     # real WavLM enrollment/matching (33 checks)
npm run simulate:recovery           # sync outage/retry/recovery (20 checks)

# Live checks that call real APIs (need keys; cost credits):
npm run test:vision-live            # one real Groq vision call
npm run test:tts-live               # one real TTS synthesis
npm run stream:test -- <audio file> # stream a file through real Deepgram
npm run fetch:face-fixtures         # face photos for the live check (gitignored)
npm run verify:embeddings           # local text encoder + retrieval benchmark (20 checks)
npm run verify:face-live            # real video -> virtual camera -> face models (25 checks)
npm run verify:qwen-worker          # real Qwen Code CLI, readonly (10 checks)
npm run verify:qwen-worker -- --write  # …and write mode (15 checks)

# Virtual hardware lab (real providers + isolated headless Chrome; needs keys):
npm run simulate:virtual-hardware   # closed-loop smoke: virtual mic/camera →
                                    #   real Deepgram/Groq/gate/TTS/echo (17 checks)
npm run simulate:virtual-room       # conversation/echo/barge-in/stop scenarios
npm run simulate:virtual-faults     # provider/storage/signal fault scenarios
npm run simulate:virtual-memory     # spoken remember → SQLite → recall
npm run simulate:virtual-identity   # spoken naming/continuity
npm run simulate:virtual-inspector  # rendered scenes → real COCO-SSD
npm run explore:virtual-boundaries  # parameter sweeps (gain/distance/noise)
npm run verify:virtual-lab          # full gauntlet incl. build-exclusion proof
node scripts/run-virtual-scenarios.mjs --family agent_env --real-worker
                                    # spoken dispatch through the REAL Qwen worker
```

## Security boundaries

- All provider keys and the database live in the server process; the browser
  bundle is scanned (tests + manual verification) for key names and values.
- Client-supplied ownership fields are stripped; tenant scoping is enforced
  in SQL; guessing a record ID cross-tenant returns 404.
- Sensitivity policy (`public → secret`) filters what can enter model
  context, search results, exports, and speech — denied records are dropped,
  never "please ignore"-annotated.
- Stored text (memories, names) is always compiled as quoted data; prompt
  injection stays inert (tested).
- Voice templates are AES-256-GCM encrypted at rest; face templates are
  stored in plaintext behind full-disk encryption (a recorded trade — see
  migration 0006). Neither leaves the server or enters a prompt. Voice
  enrollment is gated on explicit revocable consent; face consent enforcement
  is currently OFF.
- Voice and face similarity are probabilistic evidence — never authentication.
  A person's own words outrank both: no biometric can override a manual
  confirmation or a correction.
- A background worker gets an allowlisted environment (no Roma keys, no
  database path), a verified-narrow tool surface with no route back to the
  wearer, and — in write mode — an isolated git worktree entered only after
  explicit approval. The default worker is the deterministic mock; running a
  real coding agent requires setting `AGENT_WORKER=qwen`.

## Current limitations (honest list)

- Development-only authentication; no TLS; single-writer SQLite — local
  single-user deployment only.
- Scene interpretation and detector classes are generic/template-based (see
  [INSPECTOR.md](INSPECTOR.md)). Face accuracy is calibrated on public
  photographs, not on the people who will actually use it, and demographic
  performance is unmeasured here.
- Memory retrieval is semantic but imperfect: 5/7 on the measured question
  set, and it misranks when a distractor shares the subject.
- Voice-identity calibration is tiny and local; replay checking is a
  narrow heuristic, not liveness.
- The complete software integration path is verified through the virtual
  hardware lab ([VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md)); physical
  microphone/camera testing remains recommended for hardware compatibility
  and real-room acoustics, and required before biometric-accuracy claims —
  see [HARDWARE-VERIFICATION.md](HARDWARE-VERIFICATION.md).
- Roma's TTS is synthesized whole (no streaming synthesis); one active task
  at a time; no cancellation of an in-flight turn by a newer one.
- One background engineering task runs at a time, and write-mode work
  auto-approves shell commands *inside its isolated worktree* — the isolation
  is the worktree plus the wearer's approval, not a sandbox
  ([AGENT-ENV.md](AGENT-ENV.md)).
- No liveness check for faces: a photograph or a recording matches, which
  `npm run verify:face-live` demonstrates rather than hides.
- After a hard scene cut, a recognised name lingers on the next face for about
  five seconds before temporal voting drops it (measured). That is the cost of
  not forgetting someone the moment they turn their head.
