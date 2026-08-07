// End-to-end perception simulation (no camera, no API keys needed):
//
//   scripted video → Inspector fast path → Live Scene State
//   scripted transcript → agent runtime → inference with auto-attached snapshot
//
// Proves the target behaviour: by the time someone says "Can you grab me the
// adjustable wrench?", the main agent's inference already carries the wrench and
// its position — without the agent asking, and without scene spam in history.
// Also reports per-stage latency. Run with:  npm run simulate

import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { createInspector } from '../src/inspector/inspector.js';
import { createMockDetector } from '../src/inspector/detector.js';
import { createFaceRecognizer } from '../src/inspector/faces.js';
import { createDeepAnalyzer } from '../src/inspector/deepAnalysis.js';
import { createScriptedSource } from '../src/inspector/video.js';
import { compileSceneSnapshot } from '../src/context/compiler.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { now } from '../src/clock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const box = (x, y, w = 0.12, h = 0.1) => ({ x, y, width: w, height: h });

// ── Scripted video: camera approaches a workbench, Jon arrives, toolbox opens ──
const emptyBench = { detections: [{ label: 'workbench', confidence: 0.9, box: box(0.2, 0.55, 0.6, 0.3) }] };
const jonArrives = { detections: [...emptyBench.detections, { label: 'person', confidence: 0.95, box: box(0.65, 0.2, 0.25, 0.7) }] };
const toolboxOpen = {
  detections: [
    ...jonArrives.detections,
    { label: 'toolbox', confidence: 0.92, box: box(0.3, 0.45, 0.4, 0.35) },
    { label: 'adjustable wrench', confidence: 0.94, box: box(0.72, 0.78, 0.15, 0.08) }, // lower-right
    { label: 'claw hammer', confidence: 0.97, box: box(0.08, 0.12, 0.14, 0.1) },        // upper-left
    { label: 'pliers', confidence: 0.88, box: box(0.45, 0.5, 0.1, 0.08) },               // center
    { label: 'tape measure', confidence: 0.82, box: box(0.1, 0.8, 0.08, 0.08) },         // lower-left
    { label: 'screwdriver', confidence: 0.48, box: box(0.78, 0.1, 0.06, 0.12) },         // low confidence → deep-analysis trigger
  ],
};
const frames = [emptyBench, emptyBench, jonArrives, jonArrives, toolboxOpen, toolboxOpen, toolboxOpen, toolboxOpen];

// ── Assemble the Inspector exactly like the browser does, with scripted parts ──
const store = createSceneStore({ eventCooldownMs: 5000 });
const buffer = createFrameBuffer({ maxDurationMs: 30000, maxFrames: 120 });
const escalations = [];
const inspector = createInspector({
  source: createScriptedSource(frames),
  detector: createMockDetector(),
  faces: createFaceRecognizer({ lookup: () => ({ identity: 'Jon', confidence: 0.91 }) }),
  store,
  buffer,
  deepAnalyzer: createDeepAnalyzer({
    minConfidence: 0.55,
    cooldownMs: 5000,
    analyze: async ({ reason }) => { escalations.push(reason); return `deep look requested: ${reason}`; },
  }),
  bufferEveryNth: 1,
  minDetectionConfidence: 0.35,
});

// ── Main agent: pluggable infer that answers FROM the attached visual context ──
let capturedRequest = null;
const agent = createAgentRuntime({
  sceneStore: store,
  infer: async (request) => {
    capturedRequest = request;
    const match = /adjustable wrench \(([^)]+)\)/.exec(request.visualContext ?? '');
    return match
      ? `Yes — the adjustable wrench is visible in the ${match[1]} of the scene.`
      : 'I do not currently see an adjustable wrench.';
  },
});

const sessionStart = now();
agent.beginSession(sessionStart);

// ── Run: Inspector watches continuously while the conversation happens ─────────
const INTERVAL_MS = 60;
console.log('── Inspector watching (scripted feed) ──');
let lastSummary = '';
for (let i = 0; i < frames.length; i += 1) {
  const state = await inspector.tickOnce(now());
  if (state && state.scene.summary !== lastSummary) {
    lastSummary = state.scene.summary;
    console.log(`  t+${((now() - sessionStart) / 1000).toFixed(2)}s  ${lastSummary}`);
  }
  await sleep(INTERVAL_MS);
}

// Transcript arrives from the audio side (stream-relative seconds, like Deepgram).
const asked = agent.observeTranscript({
  speaker: 'Speaker 1',
  text: 'Can you grab me the adjustable wrench?',
  startedAt: (now() - sessionStart) / 1000 - 0.2,
  endedAt: (now() - sessionStart) / 1000,
});

console.log('\n── Live Scene State (structured, outside the model) ──');
const scene = store.getState();
console.log(JSON.stringify({
  revision: scene.revision,
  scene: scene.scene,
  objects: scene.objects.map(({ id, label, confidence, position, visibility }) => ({ id, label, confidence, position, visibility })),
  people: scene.people,
  recentEvents: scene.recentEvents.map((e) => e.message),
  keyframes: scene.keyframes,
}, null, 2));

console.log('\n── Inference: runtime auto-attaches the compiled snapshot ──');
const inferStart = now();
const { reply, visualContext } = await agent.respond(asked.content);
const inferMs = now() - inferStart;
console.log(visualContext);
console.log(`\nAgent reply: ${reply}`);

// ── Verify the architecture claims ────────────────────────────────────────────
const historyText = JSON.stringify(agent.history());
const frameForAsk = buffer.frameAt(asked.at);
const checks = [
  ['Snapshot names the wrench + position', /adjustable wrench \(lower-right\)/.test(visualContext)],
  ['Snapshot identifies Jon', /Jon \(91%\)/.test(visualContext)],
  ['Inference request carried the snapshot', Boolean(capturedRequest?.visualContext)],
  ['History contains the transcript', historyText.includes('adjustable wrench?')],
  ['History does NOT accumulate scene snapshots', !historyText.includes('Current visual context')],
  ['Frame retrievable at the transcript timestamp', Boolean(frameForAsk) && Math.abs(frameForAsk.at - asked.at) < 1000],
  ['Low-confidence object escalated to deep analysis', escalations.some((r) => r.includes('screwdriver'))],
  ['Notable events promoted (person entered)', scene.recentEvents.some((e) => e.type === 'person-entered')],
];
console.log('\n── Checks ──');
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

// ── Latency report ─────────────────────────────────────────────────────────────
const { cycles, averageMs } = inspector.metrics();
console.log(`\n── Latency (avg over ${cycles} fast-path cycles) ──`);
for (const [stage, ms] of Object.entries(averageMs)) {
  console.log(`  ${stage.padEnd(10)} ${String(ms).padStart(6)} ms${stage === 'cycle' ? '  (full fast path)' : ''}`);
}
const compileStart = now();
compileSceneSnapshot(store.getState());
console.log(`  compile    ${String(now() - compileStart).padStart(6)} ms  (snapshot compilation)`);
console.log(`  inference  ${String(inferMs).padStart(6)} ms  (compile + mock infer)`);
console.log(`\nBuffered frames: ${buffer.size()}, keyframes: ${buffer.keyframes().length}`);

process.exit(failed ? 1 : 0);
