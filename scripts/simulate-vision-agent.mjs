// End-to-end VISION-AGENT simulation: proves the previously stubbed deep-
// analysis path now flows a real selected frame through the full pipeline —
//
//   ambiguous fast detection → agent chooses inspect_vision →
//   inspect_current_view picks the frame from the REAL frame buffer →
//   image preparation → vision provider (mock by default) → validated
//   structured result → agent answers with the confirmed position
//
// and that an unrelated ambient remark triggers NO image analysis, and the
// analysis runs exactly once (dedup/coalescing verified by provider call count).
//
//   npm run simulate:vision-agent                       — mock vision provider
//   npm run simulate:vision-agent -- --provider groq    — real Groq vision (needs GROQ_API_KEY)

import { readFileSync } from 'node:fs';
import { loadServerEnv } from '../server/env.mjs';
import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { createInspector } from '../src/inspector/inspector.js';
import { createMockDetector } from '../src/inspector/detector.js';
import { createFaceRecognizer } from '../src/inspector/faces.js';
import { createDeepAnalyzer } from '../src/inspector/deepAnalysis.js';
import { createScriptedSource } from '../src/inspector/video.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createGroqVisionProvider, createMockVisionProvider } from '../src/vision/provider.js';
import { createVisionAnalyzer, createVisionAnalyze } from '../src/vision/analyzer.js';
import { now } from '../src/clock.js';

const box = (x, y, w = 0.12, h = 0.1) => ({ x, y, width: w, height: h });

// The fixture JPEG doubles as the "camera" frame so the real provider path can
// genuinely analyze pixels; the mock provider ignores the pixels either way.
const frameDataUrl = `data:image/jpeg;base64,${readFileSync('test/fixtures/tools.jpg').toString('base64')}`;

// ── Scripted video: the fast detector sees an AMBIGUOUS wrench-like object ────
const toolboxScene = {
  dataUrl: frameDataUrl,
  width: 640,
  height: 480,
  detections: [
    { label: 'person', confidence: 0.95, box: box(0.65, 0.2, 0.25, 0.7) },
    { label: 'wrench', confidence: 0.52, box: box(0.72, 0.72, 0.16, 0.2) },  // generic + uncertain → vision needed
    { label: 'claw hammer', confidence: 0.96, box: box(0.1, 0.1, 0.18, 0.3) },
    { label: 'screwdriver', confidence: 0.88, box: box(0.4, 0.5, 0.15, 0.1) },
  ],
};

const store = createSceneStore();
const buffer = createFrameBuffer();
const inspector = createInspector({
  source: createScriptedSource([toolboxScene, toolboxScene, toolboxScene]),
  detector: createMockDetector(),
  faces: createFaceRecognizer({ lookup: () => ({ identity: 'Jon', confidence: 0.91 }) }),
  store,
  buffer,
  bufferEveryNth: 1,
});
for (let i = 0; i < 3; i += 1) await inspector.tickOnce(now());

// ── Vision provider: counting mock by default, real Groq with --provider groq ──
let visionCalls = 0;
const mockVision = createMockVisionProvider(async ({ question }) => {
  visionCalls += 1;
  return {
    answer: 'The adjustable wrench is the metal open-jaw tool in the lower-right of the bench.',
    description: 'A workbench with a hammer upper-left, a red screwdriver center, and an adjustable wrench lower-right.',
    target: { label: 'adjustable wrench', found: true, confidence: 0.9, position: 'lower-right' },
    observations: [
      { label: 'adjustable wrench', position: 'lower-right', confidence: 0.9 },
      { label: 'claw hammer', position: 'upper-left', confidence: 0.95 },
    ],
    visibleText: [],
    uncertainty: null,
    requiresAnotherFrame: false,
  };
});

const useGroq = process.argv.includes('--provider') && process.argv[process.argv.indexOf('--provider') + 1] === 'groq';
let visionProvider = mockVision;
let realVision = false;
if (useGroq) {
  const env = loadServerEnv();
  if (env.groqApiKey) {
    console.error(`Using the REAL Groq vision provider (${env.visionModel}).\n`);
    const inner = createGroqVisionProvider({ apiKey: env.groqApiKey, model: env.visionModel, baseUrl: env.baseUrl });
    visionProvider = { ...inner, analyze: (request) => { visionCalls += 1; return inner.analyze(request); } };
    realVision = true;
  } else {
    console.error('No GROQ_API_KEY found — falling back to the mock vision provider.\n');
  }
}

// ── Deep analysis wired to the vision analyzer (real dedup/coalesce/prep path) ──
const visionAnalyzer = createVisionAnalyzer({ provider: visionProvider });
const deepAnalyzer = createDeepAnalyzer({ analyze: createVisionAnalyze(visionAnalyzer) });
const tools = createDefaultTools({ frameBuffer: buffer, deepAnalyzer, sceneStore: store });

// ── Scripted MAIN-agent model: inspect_vision for the wrench, ignore ambient ──
function extractCurrentTurn(content) {
  const m = /^\[[\d:]+\] .*: (.*?) {2}<- CURRENT TURN$/m.exec(content);
  return m ? m[1] : '';
}
const agentProvider = createMockProvider(async ({ messages }) => {
  const content = messages[0].content;
  const turn = extractCurrentTurn(content);
  const hasToolResults = /RECENT TOOL RESULTS:\n(?!\(none\))/.test(content);
  const base = { response: null, task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };

  if (/wrench/.test(turn) && !hasToolResults) {
    return { ...base, decision: 'inspect_vision', reason_summary: 'The fast detector is only 52% sure about a generic "wrench" label — confirming visually.', visual_analysis_request: { question: 'Which visible tool is most likely the adjustable wrench, and where is it?', timestampMs: null } };
  }
  if (/wrench/.test(turn) && hasToolResults) {
    const position = /"position":"([^"]+)"/.exec(content)?.[1] ?? /lower-right/.test(content) ? 'lower-right' : 'unknown';
    return { ...base, decision: 'respond', response: `The adjustable wrench looks to be in the ${position} area.`, reason_summary: 'Vision analysis confirmed the target and its position.' };
  }
  return { ...base, decision: 'ignore', reason_summary: 'Ambient conversation not directed at the agent.' };
});

const runtime = createAgentRuntime({ sceneStore: store, provider: agentProvider, tools, maxToolRounds: 2 });
runtime.beginSession(now());
const events = [];
runtime.subscribeOutput((event) => events.push(event));

// ── Run the conversation ───────────────────────────────────────────────────────
const turns = [
  { speaker: 'Jon', text: 'The weather has been so gloomy this whole week.', startedAt: 0.1, endedAt: 0.5 },
  { speaker: 'Jon', text: 'Hey, can you grab me the adjustable wrench?', startedAt: 1.0, endedAt: 1.6 },
];
console.log('── Transcript → Agent ──');
for (const turn of turns) {
  console.log(`  ${turn.speaker}: ${turn.text}`);
  // eslint-disable-next-line no-await-in-loop
  await runtime.handleTurn(turn);
}

console.log('\n── Agent activity ──');
let toolEvent = null;
for (const event of events) {
  if (event.type === 'ignored-turn') console.log(`  [ignore] ${event.reasonSummary}`);
  if (event.type === 'tool-started') console.log(`  → ${event.name}(${JSON.stringify(event.arguments)})`);
  if (event.type === 'tool-completed') {
    toolEvent = event;
    const r = event.result;
    console.log(`  ${event.ok ? '✓' : '✗'} ${event.name} (${event.tookMs}ms · frame ${r?.frameAgeMs}ms old · ${r?.prepared?.bytes ?? '?'} bytes · vision ${r?.providerMs}ms · ${r?.cacheHit ? 'cache hit' : 'cache miss'})`);
    if (r?.result) console.log(`    answer: "${r.result.answer}" (confidence ${r.result.target?.confidence ?? '?'})`);
  }
  if (event.type === 'response') console.log(`  [response] "${event.text}"`);
  if (event.type === 'error') console.log(`  [error/${event.stage}] ${event.message}`);
}

// ── Checks ─────────────────────────────────────────────────────────────────────
const responses = events.filter((e) => e.type === 'response');
const result = toolEvent?.result;
const checks = [
  ['Ambient remark was ignored', events.some((e) => e.type === 'ignored-turn')],
  ['Ambient remark triggered NO image analysis', events.filter((e) => e.type === 'tool-started').every((e) => !/gloomy/.test(JSON.stringify(e.arguments)))],
  ['Agent chose inspect_vision for the ambiguous wrench', events.some((e) => e.type === 'tool-started' && e.name === 'inspect_current_view')],
  ['Tool retrieved a real buffered frame', Boolean(result?.frameAt) && buffer.frameAt(result.frameAt) !== null],
  ['Vision returned a validated structured result', Boolean(result?.result?.answer) && typeof result.result.target?.confidence === 'number'],
  ['Image was prepared and its size recorded', (result?.prepared?.bytes ?? 0) > 0],
  ['Agent response uses the vision-confirmed position', responses.some((e) => /lower-right/.test(e.text))],
  ['Image analysis was performed exactly once', visionCalls === 1],
  ['Frame pinned as a keyframe', buffer.keyframes().some((k) => /agent:/.test(k.reason))],
  ['No errors occurred', !events.some((e) => e.type === 'error')],
];
console.log('\n── Checks ──');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

// ── Latency table ──────────────────────────────────────────────────────────────
const metrics = runtime.metrics();
console.log(`\n── Latency (avg over ${metrics.turns} turns, ${realVision ? 'REAL Groq vision' : 'mock vision'}) ──`);
console.log(`  intake -> inference   ${metrics.averageMs.intake} ms`);
console.log(`  context assembly      ${metrics.averageMs.assemble} ms`);
console.log(`  main model            ${metrics.averageMs.model} ms`);
console.log(`  tool (incl. vision)   ${metrics.averageMs.tool} ms`);
console.log(`  total per turn        ${metrics.averageMs.total} ms`);
if (result) {
  console.log(`  image preparation     ${result.prepMs ?? '?'} ms`);
  console.log(`  vision provider       ${result.providerMs ?? '?'} ms`);
}

// No hard process.exit(): with the real provider it races undici socket
// teardown on Windows and trips a libuv assertion. exitCode drains cleanly.
process.exitCode = failed ? 1 : 0;
