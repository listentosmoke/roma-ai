# Roma's Selective Voice Delivery & Turn Management

This layer decides **how and when Roma actually makes sound**. Roma generates many
internal observations and private suggestions, but the central rule is absolute:

> **Audio playback occurs only after deterministic Speech Gate approval.**
> No component reaches the TTS provider or the speaker without a valid
> authorization minted from a gate-approved decision.

The model *recommends* speech; the deterministic Speech Gate *approves* it; the
Turn Manager *schedules* it; only then does TTS synthesize and the playback
controller play. These four roles are kept strictly separate.

## When Roma speaks vs. stays silent

**Speaks (by default, out of the box):**
- A direct answer to a question addressed to her (`directAnswersMaySpeak` is
  **true** by default) — spoken as `speak_now`, immediately, once the Speech Gate
  approves.

**Stays silent (by default):**
- Ambient conversation between other people — the reactive agent's own decision
  is `ignore`; nothing is ever authorized for that turn.
- Proactive suggestions (conversation coaching, planning, reminders) —
  `spokenSuggestionsEnabled` is **false** by default, so these are always
  `visual_only` regardless of how useful or urgent the model judges them, until
  the user opts in.
- Anything the Speech Gate denies (budget/cooldown/preference), even if a model
  recommended speech — falls back to visible text, never silently disappears.
- Anything whose text fails preparation (empty, or looks like JSON/debug output).

## Addressee / conversation-engagement behavior

Whether a turn is "addressed to Roma" is still the **model's** semantic call
(`ignore | respond | clarify`, from the same schema as before) — this pass does
not change that decision-making. What's new is a small **deterministic overlay**
around it, in [src/agent/addressee.js](src/agent/addressee.js) and
[src/agent/engagement.js](src/agent/engagement.js):

- **addressee.js** normalizes every turn into an observable, testable record:
  ```jsonc
  { "decision": "respond", "addressedToRoma": true, "confidence": 0.95,
    "reasonCode": "wake_word_direct_address", "turnId": 42 }
  ```
  `confidence` and `reasonCode` are deterministic heuristics computed from
  observable features (was the wake word present? was there an active
  engagement window?) — never the model's own probability (the decision schema
  has none) and never hidden reasoning. Reason codes: `wake_word_direct_address`,
  `engagement_continuation`, `direct_address_inferred`, `ambient_conversation`,
  `ambient_during_engagement`, `wake_word_but_not_a_request`.

- **engagement.js** tracks a bounded **entry → continuation → timeout → exit**
  window (`engagementTimeoutMs`, default 20s):
  - **Entry**: the model responds, clarifies, or silently updates task state —
    Roma just engaged.
  - **Continuation**: for the rest of that window, the assembled prompt tells
    the model `ACTIVE INTERACTION: yes` — a follow-up ("and check the garage
    too") doesn't need the wake word repeated. The model still judges each turn
    on meaning; ordinary side conversation during the window is still ignored
    (`ambient_during_engagement`).
  - **Timeout**: once the window elapses, the signal reverts to
    `ACTIVE INTERACTION: no` and the wake word (or a clearly direct question) is
    needed again.
  - **Exit**: immediate and deterministic — a detected stop phrase calls
    `runtime.exitEngagement(reason)` before the turn even reaches the model, no
    waiting for the timeout.

This is additive: `prompt.js` gained one context line and one system-prompt
sentence; `runtime.js` gained an `engagement` param (a real tracker by default)
and emits one new `addressee-decision` event per turn — the decision schema,
validation, and execution pipeline are unchanged.

## Flow

```
 reactive response (runtime.js)        proactive opportunity (engine.js)
            │                                     │
            ▼                                     ▼
        existing INTERVENTION POLICY (policy.js) — proactive only
            │                                     │
            └──────────────┬──────────────────────┘
                           ▼
                 existing SPEECH GATE (proactive/speechGate.js)
                    approves? (budgets · cooldowns · preferences)
                 denied ────┴──── approved
                   │                 │
             visual fallback   mint AUTHORIZATION (voice/authorization.js)
             (never speaks)          │   {authorizationId, sourceType, sourceId,
                                     │    text, delivery, priority, authorizedAt,
                                     │    expiresAt, interruptible, unprompted}
                                     ▼
                             TURN MANAGER (voice/turnManager.js)
                             begins/attaches a turn; a newer direct
                             turn SUPERSEDES a pending proactive one
                                     │
                     speak_now ──────┴────── speak_when_convenient
                        │                          │
                        │                 GAP DETECTOR (voice/gapDetector.js)
                        │                 waits for a real conversational gap;
                        │                 drops if expired / invalidated / timeout
                        ▼                          ▼
                 speech text PREP (voice/speechPrep.js): strip Markdown, refuse
                 JSON/debug/empty, normalize punctuation, enforce max length
                                     ▼
                          TTS PROVIDER (voice/ttsProvider.js)  [abortable]
                          verify authorization still valid → synthesize
                                     ▼
                    PLAYBACK CONTROLLER (voice/playbackController.js)
                    one response at a time · rejects expired/superseded audio ·
                    releases resources · handles autoplay rejection
                                     ▼
                                  🔊 audio
```

## Modules (`src/voice/`)

| Module | Role |
|---|---|
| [authorization.js](src/voice/authorization.js) | The normalized speech-authorization object + registry. `mint()` refuses any un-approved gate decision. Tracks lifecycle: authorized → playing → consumed / expired / revoked. TTS + playback verify validity here. |
| [turnManager.js](src/voice/turnManager.js) | Single owner of turn state (`listening…speaking…interrupted…completed`). Holds the turn id, authorization id, agent/tool/TTS AbortControllers, playback handle, timestamps, cancellation reason. `isCurrent(turnId)` gates every async result; a newer turn supersedes and aborts the old one. |
| [ttsProvider.js](src/voice/ttsProvider.js) | Provider-independent TTS: **Deepgram Aura** (default), Groq PlayAI, a browser **proxy**, and a **mock**. Typed `TtsProviderError`; timeout + AbortSignal; max text length; one bounded retry for transient failures only; latency metrics. Key never logged. |
| [speechPrep.js](src/voice/speechPrep.js) | Last transform before synthesis — strips Markdown, refuses JSON/debug/empty text, normalizes punctuation, enforces a length cap (direct answers brief, coaching briefer). |
| [voiceActivity.js](src/voice/voiceActivity.js) | Lightweight VAD interface derived from signals already present (mic level, Deepgram interim, finalized segments) — emits speech-start/continue/end/silence and tracks whether Roma is playing. |
| [gapDetector.js](src/voice/gapDetector.js) | Conversational-gap detection for `speak_when_convenient`: needs real quiet (`SPEECH_GAP_MIN_MS`), no pending partial, authorization still valid, suggestion still useful; abandons after `SPEECH_GAP_MAX_WAIT_MS`. |
| [echoSuppressor.js](src/voice/echoSuppressor.js) | Self-transcription suppression via timing overlap + text similarity — Roma's own playback picked up by the mic is dropped before it reaches the agent/engine; genuinely different speech is preserved. |
| [playbackController.js](src/voice/playbackController.js) | The only place with audio-sink logic (injected, so it is testable in Node). One response at a time, releases object URLs, measures start latency, handles browser autoplay rejection without freezing. |
| [delivery.js](src/voice/delivery.js) | The orchestrator/guardian tying gate-approval → Turn Manager → gap → prep → TTS → playback, plus barge-in, deterministic stop, and direct-vs-proactive precedence. This is the object handed to the runtime and engine as `speech`. |
| [config.js](src/voice/config.js) | Timings + the deterministic stop-phrase list. Non-secret tuning may come from `VITE_`-safe vars. |

Browser wiring: [useVoiceDelivery.js](src/useVoiceDelivery.js) builds ONE delivery
instance (browser proxy TTS provider), shared by [useAgent.js](src/useAgent.js)
and [useProactive.js](src/useProactive.js) so direct answers and proactive
coaching pass the same Turn Manager / playback / authorization path. The Voice
panel in [main.jsx](src/main.jsx) shows Turn Manager state, active authorization,
TTS provider/voice, waiting-for-gap + voice-activity status, latest spoken text,
latencies, and controls (spoken answers, spoken coaching, barge-in, Test TTS,
Stop Roma, Clear pending). App feeds mic level + interim into voice activity and
runs each finalized segment through echo/barge-in/stop handling before the agent.

## Speech authorization object

```jsonc
{
  "authorizationId": "speech_auth_42",
  "sourceType": "direct_response",        // or conversation_coaching / planning …
  "sourceId": "turn_18",
  "text": "The hammer is in the upper-left section.",
  "delivery": "speak_now",                // or speak_when_convenient
  "priority": "normal",
  "authorizedAt": 1782942280295,
  "expiresAt": 1782942290295,
  "interruptible": true,
  "policyReason": "Direct answer requested by the user.",
  "unprompted": false,
  "status": "authorized"                  // → playing → consumed / expired / revoked
}
```

`mint()` returns `null` for an un-approved gate decision, so **no authorization
exists without gate approval**. Expired, revoked, superseded, or already-consumed
authorizations are rejected before synthesis and again before playback.

## Who decides what (the four clearly-separated stages)

| Stage | Component | Authority |
|---|---|---|
| Model recommendation | agent runtime / Opportunity Engine | advisory only |
| Speech approval | **Speech Gate** (unchanged) | the sole authorizer; budgets/cooldowns/preferences no model can bypass |
| Scheduling | **Turn Manager** + Gap Detector | when/whether an approved authorization plays; supersession |
| Playback | **Playback controller** | one-at-a-time audio, resource release, autoplay handling |

## Speech behavior by source

- **Direct answers** — may `speak_now` when spoken answers are enabled, the user
  addressed Roma, the gate approves, and the answer is not stale.
- **Conversation coaching** — default remains **visual_only**. Speaks only when
  spoken coaching is enabled, the policy approved it, it is strongly
  time-sensitive, and the Gap Detector finds an opening (else it expires).
- **Planning** — visual/notification; lengthy proposals are never auto-spoken.
- **Urgent alerts** — the interface leaves room for higher-priority speech; no new
  urgency categories were added in this phase.

**Direct vs proactive coordination:** an approved direct answer supersedes a
pending low-priority proactive suggestion (the Turn Manager cancels it and revokes
its authorization); they never play back-to-back unless policy permits. A
proactive suggestion about a turn the reactive agent already answered is
suppressed upstream (engine `reactiveHandled`).

## Barge-in, stop, cancellation, echo

- **Barge-in** — genuine user speech during playback lasting ≥ `BARGE_IN_MIN_MS`
  stops playback fast, revokes the authorization, marks the turn interrupted, and
  lets the new transcript form a fresh turn. A single short noise spike does not
  interrupt.
- **Deterministic stop** — "stop / cancel / be quiet / never mind / wait / stop
  talking" (configurable) cancel the active turn and stop playback **immediately,
  without an LLM round-trip**; the phrase may still be forwarded to the agent.
- **Cancellation** — AbortControllers propagate through agent / tool / TTS / (and
  are available for opportunity/vision) work; a newer relevant turn supersedes an
  active inference, tool call, waiting-for-gap speech, synthesis, and playback.
  Late results from cancelled turns are discarded and counted.
- **Echo suppression** — the mic requests `echoCancellation/noiseSuppression/
  autoGainControl`; on top of that, a transcript overlapping Roma's playback
  window whose text matches what Roma said is marked as echo and dropped before
  the agent/engine. Different speech during playback is preserved (it becomes a
  barge-in). The identity phase's voice-identity provider applies the same
  exclusion independently, at the sample level (`isPlayback` rejected before
  enrollment/matching) — see
  [IDENTITY.md](IDENTITY.md#voice-enrollment). Roma's own TTS can never be
  enrolled or matched as a human voice.

## Audio readiness and autoplay recovery

Browsers can silently block audio playback unless it is unlocked by a genuine
user gesture. [src/voice/audioReadiness.js](src/voice/audioReadiness.js) makes
this an explicit, observable state instead of a silent failure:

`locked` (never attempted) → `ready` | `blocked` → `error` (no Audio API at all).

- Clicking **Start** calls `unlock()` synchronously within that click's user
  gesture (plays and immediately pauses a tiny silent clip) — this is what lets
  a real reply later in the session actually play.
- A real `playback-blocked` event (autoplay rejected) also flips the state to
  `blocked`, and a real `playback-started` flips it to `ready` — the indicator
  reflects genuine outcomes, not just the initial guess.
- The Voice panel shows a warning banner with a single **Enable Audio** button
  when blocked/error — clicking it retries `unlock()` once; nothing retries
  automatically in a loop.
- Visual delivery (the response text, the transcript) is unaffected either way —
  blocked audio never hides or delays the text.
- No duplicate speech after recovery: a blocked/discarded utterance is not
  replayed; only the *next* authorized response uses the now-unlocked audio path.

## Voice selection

The Voice panel's voice selector is never a hardcoded client list. The browser
calls `GET /api/tts/voices` ([server/groqApi.js](server/groqApi.js) +
[src/voice/voiceCatalog.js](src/voice/voiceCatalog.js)), which — for Deepgram —
asks Deepgram's own `GET /v1/models` endpoint live (server-side key), so the
list can never drift from what the account actually supports. Voices with the
same name across generations (Deepgram's older "aura" and newer "aura-2" voices
reuse character names, e.g. two "Arcas") are disambiguated with an
`(aura)`/`(aura-2)` suffix so the dropdown is never ambiguous.

- The selection persists to `localStorage` and is reconciled against the live
  catalog on load — an unknown/stale saved voice falls back to the
  server-configured default rather than being sent as-is.
- The server **also** validates: `POST /api/tts/synthesize` checks a
  client-supplied voice against the real catalog and silently falls back to the
  configured default (flagging `voiceFallback: true`) if it's not recognized —
  defense in depth even if a stale client sends garbage.
- Changing the voice never affects in-flight speech: `delivery.js`'s `voice`
  option can be a getter function, resolved fresh right before each synthesis —
  a change made mid-playback only ever applies to the *next* authorization.
- Every `spoken` event (and the Voice panel's "last spoken" line) reports the
  actual `provider`, `model`, and `voice` used for that specific synthesis.

## Pending `speak_when_convenient` details

While an approved suggestion waits for a conversational gap, the Voice panel
shows a card with its authorization id, source type, the concise pending text,
priority, creation time, an expiry countdown, why it's waiting (e.g. "waiting
for a quiet moment", "gap found — synthesizing now"), whether someone else is
currently speaking, and a **Cancel** control. No internal policy prompts or
hidden reasoning are shown — only these operational fields. The derivation is a
pure reducer, [src/voice/pendingSpeechTracker.js](src/voice/pendingSpeechTracker.js),
so "what counts as pending and when it clears" is unit-tested independent of
React. It disappears immediately the moment the authorization is played,
expires, is revoked, is superseded, or the user cancels it.

## Live voice diagnostic trace (dev only)

[src/voice/diagnosticsTrace.js](src/voice/diagnosticsTrace.js) merges the agent
runtime's output events and the voice-delivery layer's events (both already
exposed, bounded arrays — no new subscriptions) into one time-ordered,
size-capped trace: transcript finalized → addressee decision → agent decision +
turn id → Speech Gate result → authorization id → Turn Manager state changes →
TTS request/provider → playback started/completed/stopped/blocked/failed → echo
suppression → cancellation/supersession reason. It proves a response can never
silently disappear between stages. No API keys, no full prompts, no hidden
reasoning, and no unrestricted transcript history are ever included — only the
current turn's short text and these operational fields. Shown as a collapsible
dev-only panel in [main.jsx](src/main.jsx).

## Dev-only live-loop harness

This sandboxed environment has no real microphone (`getUserMedia` resolves the
API but throws `NotAllowedError` — confirmed, not assumed). A **development-only
harness** panel injects a finalized transcript through the exact same per-segment
pipeline a real Deepgram segment traverses — echo classification, barge-in/stop
handling, engagement exit, the agent runtime's public `handleSegment` entry
point, and the Opportunity Engine (`App.processSegment` in
[main.jsx](src/main.jsx)). It never calls the Speech Gate, TTS provider, or
playback controller directly — those only run because the runtime/engine invoke
them internally, exactly as they would for real microphone input. A second
button re-injects Roma's own last reply as a simulated mic echo.

## Security

- The **TTS key** lives only on the server. Synthesis goes through
  `POST /api/tts/synthesize`; the browser uses the proxy provider and receives
  base64 audio — never the key.
- The **Deepgram key** is now server-side too. The browser opens its streaming
  WebSocket to a local proxy (`/api/deepgram/stream`, `server/deepgramProxy.mjs`)
  which pipes audio to Deepgram authenticated with the server key. This works with
  any Deepgram key (unlike temporary-token grants, which require an
  admin-scoped key). `engine/config.js` no longer reads a `VITE_` Deepgram key.
- `test/voice-security.test.js` proves no client source references the legacy
  `VITE_DEEPGRAM_API_KEY` / `VITE_GROQ_API_KEY` / `VITE_TTS_API_KEY`, and (when a
  `dist/` exists) that the built bundle contains none of them.

## Environment variables

```bash
# Deepgram — STT + (default) TTS, server-side only
DEEPGRAM_API_KEY=...
# Text-to-speech (defaults to Deepgram Aura on DEEPGRAM_API_KEY)
# TTS_PROVIDER=deepgram          # or: groq
# TTS_API_KEY=                   # defaults to DEEPGRAM_API_KEY (or GROQ_API_KEY for groq)
# TTS_BASE_URL=https://api.deepgram.com/v1
# TTS_MODEL=aura-2-thalia-en
# TTS_VOICE=aura-2-thalia-en
# Non-secret tuning (VITE_-safe)
# VITE_SPEECH_GAP_MIN_MS=700
# VITE_SPEECH_GAP_MAX_WAIT_MS=5000
# VITE_BARGE_IN_MIN_MS=200
```

## Metrics

Delivery records: transcript→audio latency, TTS provider latency, gap-wait time,
playback-start latency, barge-in stop latency; counts of authorizations approved /
denied / expired, TTS failures & timeouts, echo transcripts suppressed, late
results discarded, autoplay failures, stop commands, and barge-ins. Visible in the
Voice panel and printed by `simulate:selective-voice` / `simulate:live-conversation`.

## Running / verifying

```bash
npm test                              # full offline suite (562 tests as of the
                                      #   2026-07 stabilization pass) — voice units +
                                      #   delivery scenarios + integration + addressee/
                                      #   engagement + audio readiness + voice
                                      #   catalog + pending-speech + security
npm run simulate:selective-voice      # 12 scripted checks: ambient → silence,
                                      #   private coaching, speak_when_convenient
                                      #   waits then plays on a gap, barge-in,
                                      #   supersession, echo, expiry
npm run simulate:live-conversation    # 12 scripted checks (this pass): ambient
                                      #   ignored, direct answer + authorization +
                                      #   TTS + playback, echo suppressed, wake-
                                      #   word-free follow-up accepted, proactive
                                      #   suggestion waits for a gap then plays,
                                      #   barge-in, stop phrase, engagement
                                      #   timeout, no response plays twice —
                                      #   prints every reason code + state change
npm run test:tts-live                 # ONE real synthesis (needs a TTS key);
                                      #   prints provider/model/voice/bytes/latency
                                      #   and saves the audio
```

Real-provider note (2026-07): Groq's PlayAI TTS was decommissioned, so the default
TTS provider is **Deepgram Aura** (`aura-2-thalia-en`), which reuses the Deepgram
key already provisioned for STT. A live check produced a 21 KB MP3 in ~555 ms.

## Live verification method and result (this pass)

**Method:** physical-microphone verification was attempted first and confirmed
unavailable — `navigator.mediaDevices.getUserMedia({audio:true})` in the actual
browser preview returns `NotAllowedError: Permission denied` (the API exists,
there is no real mic/permission channel in this sandbox). The **dev-only harness**
described above was used instead, per the documented fallback.

**Result, through the live running app (real Groq + real Deepgram Aura + real
in-browser playback, not the Test TTS button):** injecting "Roma, what time is
it?" produced an `addressee-decision` (`respond`, `addressedToRoma: true`,
`confidence: 0.95`, `reasonCode: wake_word_direct_address`) → a real Groq
response → Speech Gate approval (`spokenApproved: true`,
`"user directly addressed Roma"`) → a minted authorization → Turn Manager
`transcript_pending → synthesizing → speaking → completed` → a real
`deepgram-tts` request/response (~280–340 ms) → real playback start (~45–48 ms
after audio arrived) → completion — all visible in the diagnostic trace, zero
console errors. **A real bug was found and fixed this way**: clearing an
`<audio>` element's `src` during cleanup fires a delayed browser `error` event,
which was being reported as a spurious `playback-failed` *after* a successful
completion; `playbackController.js`'s `onerror` now has the same "still the
active authorization?" guard `onended` already had (regression test added).
Echo suppression and gap-timing scenarios (which need sub-second precision) are
proven deterministically instead, via `npm run simulate:live-conversation` and
the Node test suite — real-time races through remote browser automation are not
a meaningful substitute for a scripted, reproducible clock.

## Known limitations (this phase)

- Echo/duplicate detection is lexical (timing overlap + token similarity), not
  acoustic DSP or semantic embeddings.
- Voice activity is derived from the mic level + Deepgram interim/segments — there
  is no separate neural VAD, and "another person vs the user" relies on Deepgram
  diarization labels, not verified identity.
- TTS is synthesized whole (no sentence-by-sentence streaming).
- No permanent memory, external messaging/calendar/device access, or autonomous
  background execution were added.
- Gap detection is a first version (quiet-gap heuristic); it does not model turn
  intention or predicted interruption cost.
- The engagement window's timestamp source (session-relative segment time) and
  the visual-context freshness check's timestamp source (wall-clock `now()`) are
  two different but normally-equivalent clocks in `runtime.js` — they only
  diverge if processing lags far behind real time, which would already be a
  pre-existing perf issue elsewhere; discovered while writing deterministic
  tests, not something that misbehaves in real usage.
- The voice selector's "applies to the next authorization" guarantee is proven
  at the delivery layer; the UI does not additionally disable the `<select>`
  during playback (an intentional simplification — the underlying mechanism
  already makes an accidental mid-playback change harmless).
- Physical-microphone verification was not possible in this environment (no real
  mic permission channel); the dev-only harness and deterministic simulations
  were the verified substitute at the time. **Update (2026-07): the virtual
  hardware lab now closed-loop-verifies this whole layer through real
  `MediaStream` audio — real Aura-synthesized speech through the virtual mic,
  real Deepgram, real gate/TTS/playback, Roma's own decoded output mixed back
  as echo and really suppressed, plus barge-in and stop-phrase cancellation
  (`npm run simulate:virtual-room`, see
  [VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md)). Physical-mic testing remains
  for hardware/room calibration.**
