# The Inspector — visual perception for Roma AI

Roma AI's goal is an agent that continuously understands what is happening around
the user. The audio side (live transcription + speaker diarization, see
`src/engine/`) already exists and is untouched. This document describes the
**visual perception system** added alongside it: the **Inspector**, the **Live
Scene State**, and the **Context Compiler**. The main agent that consumes this
(decision-making, tools, task state, provider abstraction) is documented
separately in [AGENT.md](AGENT.md) — this file covers the perception side only.

The core principle:

> **The Inspector writes continuously; the main-agent runtime automatically reads
> the latest relevant state whenever the main agent thinks.**

By the time someone says *"Grab the adjustable wrench,"* the agent's very next
inference already carries the wrench's presence and approximate position — with
no voice trigger, no manual fetch, and no scene spam in conversation history.

---

## Architecture & data flow

```
 AUDIO (existing, unchanged)              VIDEO (new)
 ───────────────────────────              ─────────────────────────────────────
 mic → engine/deepgram.js                 camera / scripted source (inspector/video.js)
     → engine/segmenter.js                    │ grabFrame() every ~250 ms
     → speaker-labeled segments               ▼
            │                             INSPECTOR fast path (inspector/inspector.js)
            │                              detect → track → identify → interpret
            │                                 │                        │
            ▼                                 │              frame buffer (rewind,
 agent runtime (agent/runtime.js)             ▼               keyframes, by-timestamp)
  observeTranscript(segment) ──┐          LIVE SCENE STATE (inspector/sceneStore.js)
                               │           structured objects/people/events store,
  respond(input)  ◄────────────┘           OUTSIDE the model's context window
      │  at think time:                        │
      │  1. sceneStore.getState()              │ escalate uncertain frames
      │  2. context/compiler.js  ◄─────────────┘      ▼
      │     → compact text snapshot       deep analysis (inspector/deepAnalysis.js)
      ▼                                    pluggable strong vision model (stubbed)
  infer({ history, visualContext, input })
      snapshot attached EPHEMERALLY — never stored in history
```

Decoupling: the Inspector only ever **writes** to the scene store / frame buffer.
The agent runtime only ever **reads** them (via the compiler). Either side can be
replaced without touching the other; the audio engine doesn't know either exists.

Shared clock (`src/clock.js`): everything — frames, detections, events, scene
revisions, transcript segments — is stamped with epoch milliseconds. Deepgram's
stream-relative seconds are converted in `agentRuntime.observeTranscript()`, so a
transcript line can be aligned with the exact video frames behind it
(`frameBuffer.range(startedAtMs, endedAtMs)`).

## Module map

| Module | Role | Real or placeholder |
|---|---|---|
| `src/clock.js` | Shared epoch-ms clock + audio-seconds conversion | real |
| `src/inspector/video.js` | Video input: webcam (`getUserMedia`) or scripted frames | real |
| `src/inspector/detector.js` | Object-detection interface; `mock` + in-browser **COCO-SSD** (TF.js via CDN) | real (COCO-SSD = 80 generic classes; swap for YOLO/RT-DETR behind same `detect()`) |
| `src/inspector/tracker.js` | Greedy label+IoU tracking, stable ids, `visible/missing`, grid positions | real, deliberately simple (upgrade path: ByteTrack) |
| `src/inspector/faces.js` | Known-person identification interface | **placeholder** — returns `identity: null`; swap in face embeddings behind `identify()` |
| `src/inspector/interpreter.js` | Scene classification + one short grounded summary | **placeholder** for a tiny VLM — template-based today, same signature |
| `src/inspector/sceneStore.js` | Live Scene State: structured source of truth + event promotion (dedup/cooldown) | real |
| `src/inspector/frameBuffer.js` | Rolling recent-video memory: rewind, nearest-by-timestamp, ranges, pinned keyframes | real (long-term visual-memory *search* is future work) |
| `src/inspector/deepAnalysis.js` | Escalation decision (confidence thresholds) + pluggable strong-model interface | interface real; analyzer **stubbed** — wire Claude/vision here. OCR belongs on this path (future) |
| `src/inspector/inspector.js` | Fast-path orchestrator loop + per-stage latency metrics | real |
| `src/inspector/index.js` | `buildInspector()` factory (mirrors `engine/index.js`) | real |
| `src/context/compiler.js` | Context Compiler: full state → compact agent-facing snapshot, staleness flag | real |
| `src/agent/runtime.js` | Main-agent runtime: transcript intake + **automatic ephemeral snapshot injection** | runtime real; `infer` is a **mock** — wire the real reasoning model here |
| `src/useInspector.js` + Live Scene panel in `main.jsx` | Browser wiring + UI (camera toggle, scene chips, the exact snapshot an inference would get) | real |

## Live Scene State schema

```jsonc
{
  "revision": 9,                    // bumps on every write
  "updatedAt": 1782942280295,       // epoch ms, shared clock
  "scene": { "label": "workshop / tools", "summary": "Jon is present … toolbox … in view." },
  "objects": [{
    "id": "obj_4",                  // stable track id
    "label": "adjustable wrench",
    "confidence": 0.94,
    "position": "lower-right",      // 3×3 grid from normalized box center
    "visibility": "visible",        // 'visible' | 'missing' (recently lost)
    "firstSeenAt": 1782942280035, "lastSeenAt": 1782942280295
  }],
  "people": [{ "id": "person_2", "identity": "Jon", "confidence": 0.91, "lastSeenAt": … }],
  "recentEvents": [{ "at": …, "type": "person-entered", "message": "Jon entered the scene" }],
  "keyframes": [{ "at": …, "reason": "low-confidence screwdriver (48%)" }]  // frames live in the buffer
}
```

Notable-event types today: `person-entered`, `object-appeared`, `object-lost`,
`deep-analysis`. Normal churn just updates state; events are deduped per
`(type, subject)` within a cooldown and the queue is bounded. Immediate agent
interruption is intentionally NOT implemented — subscribe via
`store.subscribe(listener)` when that capability is wanted.

## Interfaces (contracts to swap implementations behind)

```js
source.grabFrame() -> frame | null                  // video.js
detector.detect(frame) -> [{ label, confidence, box? {x,y,width,height} }]  // normalized 0..1
tracker.update(detections, atMs) -> tracks          // stable ids
faces.identify(frame, personTracks) -> [{ id, identity|null, confidence }]
store.update({ objects, people, sceneLabel, summary }, atMs); store.getState(); store.subscribe(fn)
buffer.push(frame, atMs); buffer.frameAt(atMs); buffer.range(from, to); buffer.saveKeyframe(atMs, reason)
deepAnalyzer.maybeAnalyze({ frame, sceneState, at }) -> { requested, reason?, description? }
compileSceneSnapshot(state, { at }) -> string        // '' when nothing useful
agent = createAgentRuntime({ sceneStore, infer })
agent.beginSession(atMs); agent.observeTranscript(segment); await agent.respond(input)
```

The agent-facing snapshot looks like:

```
Current visual context:
- Scene: workshop / tools — Jon is present in a workshop setting, with …
- Visible objects: claw hammer (upper-left), adjustable wrench (lower-right), …
- People present: Jon (91%)
- Recent events: Frame escalated for deeper analysis: low-confidence screwdriver (48%) (292 ms ago)
- Scene state updated 92 ms ago
```

Older than 10 s → the last line gains `(STALE — treat as possibly outdated)`.

## Running it

```bash
npm run dev        # app: Start = mic (existing); camera button = Inspector.
                   # The Live Scene panel shows state + the exact per-inference snapshot.
npm run simulate   # end-to-end proof, no camera/keys: scripted video + transcript →
                   # agent inference carries the wrench + position; 8 PASS checks + latency table
npm test           # full offline suite (562 tests as of the 2026-07 stabilization
                   # pass) — the Inspector's own coverage lives in test/inspector.test.js
                   # and test/compiler.test.js
```

The first camera start downloads TF.js + COCO-SSD (~6 MB) from a CDN; if that
fails it degrades to the mock detector and says so in the status.

**Virtual-camera verification (2026-07):** the virtual hardware lab renders
rooms onto a canvas whose `captureStream()` track enters `createCameraSource`
exactly like a webcam — real COCO-SSD reliably detects the rendered stop
sign/clock assets, tracking follows movement, removal goes `missing`, and
lighting changes real pixels (`npm run simulate:virtual-inspector`, see
[VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md)). Drawn humanoid figures are NOT
reliably detected as `person` — person-detection scenarios need Tier-3
licensed imagery or a physical camera.

## Measured latency (v1)

Node simulation (mock detector, real pipeline): full fast-path cycle **~1 ms**
avg — grab/buffer/detect/track/identify/interpret/store/escalate each ≤0.3 ms;
snapshot compile **<1 ms**; so pipeline overhead is negligible. In the browser
the budget is dominated by real detection: COCO-SSD (lite_mobilenet_v2) is
typically **~20–60 ms/frame** on WebGL, well inside the 250 ms cadence; the
per-stage numbers show live in the Live Scene panel (`metrics()`), e.g.
`X ms/cycle` in the header.

## Deliberate v1 simplifications (upgrade paths)

1. **Detector**: COCO-SSD's 80 generic classes can't tell an adjustable wrench
   from pliers — that's precisely what the deep-analysis escalation is for.
2. **Faces**: placeholder (everyone unidentified) → triggers "unidentified person"
   escalations by design.
3. **Interpreter**: templates, not a model. Same signature as a future tiny VLM.
4. **Deep analysis**: decision path + keyframe pinning + events are real; the
   analyzer returns a canned string until a vision model is wired in
   (`createDeepAnalyzer({ analyze })`).
5. **Main agent**: `infer` is a mock; wire Claude by putting `visualContext` in
   the system prompt. History trimming is a simple cap.
6. **Tracking**: greedy IoU; no re-identification after long occlusion.
7. **Frame buffer**: 30 s rolling window; no long-term visual-memory search yet.
8. **No agent interruption**: events queue only; `store.subscribe()` is the hook.
