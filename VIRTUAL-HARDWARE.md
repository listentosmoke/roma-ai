# Virtual Hardware Lab — Autonomous Audiovisual Simulation

A hardware-in-the-loop test bench for Roma: Claude (or any operator) creates
interactive virtual rooms whose **real audio samples and real rendered video
frames** enter the application through the browser's actual media-device
boundary. Roma's unmodified pipeline — capture, resampling, Deepgram
streaming, segmentation, the Groq agent, the Speech Gate, TTS, playback, echo
suppression, memory, identity, the Inspector, COCO-SSD, SQLite — runs for
real. Only the room is synthetic.

## What "real" means here

| Component | In a lab run |
|---|---|
| Microphone / camera | **Virtual** — real `MediaStreamTrack`s from a WebAudio mixer (`MediaStreamAudioDestinationNode`) and a continuously rendered canvas (`captureStream`) |
| Capture, PCM16, resample, video-element path | **Real, unmodified production code** (`src/audio.js`, `src/inspector/video.js` consume the tracks exactly as physical devices) |
| Speech of simulated people | **Real Deepgram Aura synthesis** (distinct voices, cached), real recorded human speech (`.testdata` fixtures), or a deterministic signal synth (labeled, signal-level only) |
| STT | **Real Deepgram nova-3 streaming** via the real server proxy |
| Agent / vision / extraction | **Real Groq inference** via the real server routes |
| Speech Gate / TTS / playback | **Real** — deterministic gate, real Aura synthesis, real `HTMLAudioElement` playback |
| Echo | **Roma's actual decoded output**, tapped after decode, mixed back into the virtual mic through delay/gain/filter |
| Detection | **Real COCO-SSD inference** on the rendered frames |
| Storage | **Real SQLite** — disposable file, isolated tenant, temp biometric key |
| Room acoustics/lighting | Real signal/pixel transforms (gain, 1/distance attenuation + low-pass, seeded noise, convolver reverb, delay; luminance overlay) — never labels |

Forbidden by design (and enforced): transcript injection, writing scene
state, calling the agent/gate/TTS/playback/repositories directly, or
substituting mock providers while reporting results as real.

## Verification levels

Reports classify every run: `unit_verified` · `deterministic_provider_verified`
· `transcript_harness_verified` · `virtual_microphone_verified` ·
`virtual_camera_verified` · `rendered_environment_verified` ·
`closed_loop_simulation_verified` · `real_cloud_provider_verified` ·
`physical_device_verified` · `unverified`. Virtual-device results are never
described as physical-device results, and synthetic-voice results never claim
human biometric accuracy.

## Architecture

```
Node side (scripts/)                      Browser side (src/simulation/, DEV-only)
 run-virtual-scenarios.mjs                 index.js        activation + banner +
 simulate-virtual-hardware.mjs                             window.__romaSim API +
 explore-simulation-boundaries.mjs                         console-error collector
 verify-virtual-lab.mjs                    audioEngine.js  WebAudio room mixer →
 lib/virtualLab.mjs   Scenario Director                    virtual mic track
 lib/chrome.mjs       CDP launcher/client  videoEngine.js  canvas renderer →
 lib/simServer.mjs    isolated real Vite                   virtual camera track
 lib/voices.mjs       voice resolution     devices.js      getUserMedia interposition
 lib/wav.mjs          seeded signal math   environments.js room profiles (shared)
 lib/reports.mjs      JSON/MD + redaction  schema.js       scenario schema (shared)
 src/simulation/scenarios/*.json           oracle.js       deterministic conditions (shared)
```

One lab run = one isolated **real Vite server** (`ROMA_DB_PATH` → disposable
SQLite in a temp dir, unique tenant, temporary 32-byte biometric key, unique
port) + one isolated **headless Chrome** (temp profile, fake-UI media flags,
CDP over Node's native WebSocket — zero dependencies) with
`window.__ROMA_SIMULATION__` injected pre-load.

### Two media-device modes

- **Mode A — Chromium fake devices**: real `--use-fake-device-for-media-stream`
  (+ `--use-file-for-fake-audio-capture` with generated WAV fixtures) for
  fixed browser-level media tests. Verified: tracks labeled
  "Fake Default Audio Input"/"fake_device_0".
- **Mode B — dynamic virtual devices**: dev-only interposition of
  `navigator.mediaDevices.getUserMedia` returning cloned tracks from the audio
  mixer/canvas renderer. Used for all closed-loop scenarios. The consumers
  (`createMicCapture`, `createCameraSource`) are byte-for-byte the physical
  path.

## Scenario Director

Node-side API (`scripts/lib/virtualLab.mjs`): `createLab()` →
`command('person.add' | 'person.move' | 'object.add' | 'object.move' |
'object.remove' | 'lighting.set' | 'camera.move' | 'echo.configure' |
'microphone.setGain' | 'environment.load' …)`, `speak(person, voiceSource,
text, {gainDb, rate})`, `triggerFault/clearFault`, `ui('start'|'camera')`,
`snapshot()`, `waitFor(condition, {timeoutMs, baseline})`, plus
`runScenario(lab, scenario)` for declarative files and `writeReports(result)`.

Declarative scenarios (`src/simulation/scenarios/*.json`) are validated
against `src/simulation/schema.js`: whitelisted verbs with typed bounded
arguments, whitelisted oracle conditions and faults, bounded timeouts
(≤120 s), text (≤500 chars), events (≤200), branch depth (≤3), and explicit
rejection of code-shaped content. `addressedToRoma`/`groundTruth`/`note` are
oracle metadata — never sent to Roma, never able to influence its decisions.

Baseline semantics: condition deltas measure from the last
speak/wait_for/assert checkpoint; `scope: "scenarioStart"` measures across
the whole run (for counters that increment at the same instant as an awaited
event, e.g. barge-in).

## Deterministic oracle

`src/simulation/oracle.js` — every condition is a fact over bounded
observability snapshots (delivery/playback counters, agent event types,
finalized segments, Inspector scene state, queue status, engine signals,
console errors). The snapshot bridge in `main.jsx` is read-only. Model text
may be summarized in reports, but pass/fail comes from these deterministic
facts, with the ground-truth transcript compared against what Deepgram
actually heard.

## Environments (15)

`quiet_office`, `busy_office`, `echoing_room`, `living_room_tv`,
`noisy_workshop`, `vehicle`, `meeting_2p`, `meeting_3p`, `distant_speaker`,
`close_speaker`, `low_light_room`, `moving_camera`, `intermittent_network`,
`database_restart`, `enrollment_booth`, `conflicting_speakers`,
`visual_question_room` — each a bundle of real acoustic parameters (noise
gain/spectrum, reverb length/decay/mix, speech low-pass, default distance)
and visual parameters (lighting level, background, camera drift).

Visual tiers: `deterministic_geometric` (exact shapes, ground-truth
mechanics), `recognition_compatible` (detector-friendly drawn assets — the
rendered stop sign and clock are reliably detected by real COCO-SSD; drawn
chairs/humanoids are hit-or-miss and reported honestly),
`recorded_photorealistic` (asset slot for licensed imagery — no bundled
photographic assets; provenance must be documented per scenario).

## Voices

`aura:<voice>` (real Deepgram Aura, per-(voice,text) cache in `.simcache/`,
magic-byte validated), `fixture:<name>` (recorded Dan/Vanessa clips),
`synth:<profile>` (deterministic, unintelligible — signal tests only). Gain,
rate, distance, pan, and room acoustics all change the actual waveform.

## Closed-loop behavior (verified)

The flagship loop, all through real media: simulated person speaks (real
Aura audio) → virtual mic → real Deepgram transcription → real Groq decision
(including tool calls) → real Speech Gate authorization → real TTS → real
playback → decoded output tapped and mixed back as delayed/filtered echo →
re-transcribed by Deepgram → **really suppressed by the echo suppressor** →
no self-response loop. Interruptions during playback produce real barge-ins;
"Stop." cancels immediately.

## Fault injection (real boundaries)

CDP network control blocks `/api/agent/infer` (Groq outage), `/api/tts/*`
(TTS outage), `/api/data/*` (storage outage → mutation queue visibly pending
→ recovers exactly-once), or goes fully offline; the engines produce real
audio dropouts, camera freezes, and track endings. Severing an established
Deepgram WebSocket mid-stream is not cleanly reachable via CDP — documented
limitation (the HTTP-level equivalents are covered in `simulate:recovery`).

## Parameter exploration

`npm run explore:virtual-boundaries [-- --sweep gain|distance|noise]` —
bounded sweeps (≤8 trials) over real signal parameters with word-recall
scoring against ground truth. Measured 2026-07: in `quiet_office`,
transcription held to −34 dB speech gain and failed at −40 dB. Boundaries are
synthetic-room measurements, never universal claims.

## Isolation & production separation

Per run: temp browser profile, disposable DB, isolated tenant, temp
biometric key, unique port/operation IDs, auto-cleanup. The real
`data/roma.db`, memories, people, profiles, consents, and the user's browser
profile are never touched (tested).

Production: all simulation code is imported only inside `import.meta.env.DEV`
guards → dead-code-eliminated from builds (bundle-scan test); activation
additionally requires the pre-load `window.__ROMA_SIMULATION__` injection —
no query-parameter/localStorage/UI path exists (tested); a purple
"SIMULATED ENVIRONMENT" banner and an in-frame watermark label every session;
the lab never imports Roma subsystems (tested); auth/sensitivity/consent/
Speech Gate are unweakened.

## Reports

Every run writes `.simreports/<scenario>_<timestamp>.json` + `.md`
(gitignored): environment, seed, tier, verification level, real-vs-simulated
component table, assertions with details, Roma's actual transcript vs ground
truth, timeline, latencies, console errors, failure screenshots. Redaction
strips template/embedding/key/audio-payload-shaped fields and truncates long
strings (tested). Raw audio/video is not retained — only the bounded voice
cache in `.simcache/`.

## Commands

```bash
npm run simulate:virtual-hardware    # Mode A + Mode B closed-loop smoke (17 checks)
npm run simulate:virtual-room        # conversation/echo/barge-in/stop/overlap family
npm run simulate:virtual-faults      # fault-injection family
npm run simulate:virtual-memory      # spoken remember→SQLite→recall family
npm run simulate:virtual-identity    # spoken naming/continuity family
npm run simulate:virtual-inspector   # rendered-scene detection/tracking/cross-modal family
npm run explore:virtual-boundaries   # bounded parameter sweeps
npm run verify:virtual-lab           # tests + build + exclusion proof + smoke + full library
# ad hoc: node scripts/run-virtual-scenarios.mjs --scenario <id> | --file <path> [--visible] [--shared]
```

All scenario commands require `DEEPGRAM_API_KEY` + `GROQ_API_KEY` and abort
honestly rather than degrading to mocks.

## Performance (measured, headless Chrome 150, this machine)

Lab startup (server+browser+activation) ~8–12 s; typical conversational
scenario 20–40 s; camera scenarios +30–45 s for the CDN COCO-SSD load; the
13-scenario library ~12–15 min with fresh isolation per scenario. Voice
cache makes reruns cheaper and faster.

## Current limitations

- Voice-identity **enrollment UI** automation (People panel click-through with
  bounded capture) is not yet scripted — the WavLM/encryption/consent path is
  verified by `simulate:voice-identity` (real WavLM on real recorded speech,
  service-level) and the capture tap consumes the same virtual-mic PCM;
  closing the last mile through the panel is the lab's next increment.
- Tier-2 humanoid/chair drawings are not reliably detected by COCO-SSD
  (stop sign/clock are); Tier 3 needs user-supplied licensed imagery.
- Deepgram WS mid-stream severing isn't injectable via CDP (see Faults).
- **Groq rate limits look like behavior bugs.** Back-to-back lab runs exhaust
  the free-tier quota, after which the model answers "I'm currently
  rate-limited and can't start the…" — which reads exactly like a wrong
  decision (a tool not called, a question not answered). Two lab-diagnosis
  sessions were spent chasing this before the reply text was actually read.
  **Read the agent decision trail in the report, including the response text,
  before changing a prompt.** Space runs out, or expect the first run after a
  burst to fail.
- Model/provider behavior is stochastic: scenarios assert pipeline
  invariants, not exact wording; occasional Groq tool-loop caps (e.g. date
  questions against a clock-only tool) surface as visible bounded errors — a
  finding, not a flake to hide. Measured flake profile (2026-07-24, three
  full `verify:virtual-lab` runs): 10/14 → 13/14 → 13/14 scenarios per run,
  a **different** scenario each time, every scenario passing in isolation
  and cumulatively 14/14 — residual variance traced to Groq decision
  stochasticity and intermittent 429 retry backoffs, not to the lab or the
  application pipeline. Treat a single-scenario gauntlet failure as a rerun
  candidate first, a regression second.
- Headless audio output is silent (playback timing/events are real; no
  speaker DAC involved).

## Physical devices, honestly

The lab proves the complete **software integration path** on real provider
traffic. Physical testing remains recommended for hardware compatibility and
real-room acoustic calibration, and **required** before any biometric-accuracy
claim — see [HARDWARE-VERIFICATION.md](HARDWARE-VERIFICATION.md).

## Toward facial recognition

The future face phase can reuse the lab directly: Tier-2/3 rendered or
licensed face assets in the video engine, the same consent/encryption
scenario patterns as voice identity, cross-modal face-plus-voice timing
scenarios, and adversarial cases (photo-of-a-face replay) — all through the
virtual camera with the same oracle discipline.
