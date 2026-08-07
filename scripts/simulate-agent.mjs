// End-to-end MAIN-AGENT simulation (no camera, no credentials needed by default):
//
//   scripted video → Inspector fast path → Live Scene State (reused from simulate.mjs)
//   scripted transcript → agent runtime → structured decision per turn
//
// Proves the full agent operating model: a bounded transcript window + the
// latest visual snapshot are automatically assembled into context; the agent
// decides ignore / respond / clarify / tool_call / inspect_vision / update_task;
// an ambiguous/low-confidence tool label triggers ONE bounded vision follow-up
// (via the real inspect_current_view tool against the real frame buffer); an
// unrelated ambient remark is ignored with no user-facing output.
//
//   npm run simulate:agent                 — scripted mock provider (default)
//   npm run simulate:agent -- --provider groq   — real Groq call if GROQ_API_KEY is set

import { existsSync, readFileSync } from 'node:fs';
import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { createInspector } from '../src/inspector/inspector.js';
import { createMockDetector } from '../src/inspector/detector.js';
import { createFaceRecognizer } from '../src/inspector/faces.js';
import { createDeepAnalyzer } from '../src/inspector/deepAnalysis.js';
import { createScriptedSource } from '../src/inspector/video.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createMockProvider, createGroqProvider } from '../src/agent/provider.js';
import { now } from '../src/clock.js';

const box = (x, y, w = 0.12, h = 0.1) => ({ x, y, width: w, height: h });

// ── Scripted video: the same toolbox scene as scripts/simulate.mjs ─────────────
const emptyBench = { detections: [{ label: 'workbench', confidence: 0.9, box: box(0.2, 0.55, 0.6, 0.3) }] };
const jonArrives = { detections: [...emptyBench.detections, { label: 'person', confidence: 0.95, box: box(0.65, 0.2, 0.25, 0.7) }] };
const toolboxOpen = {
  detections: [
    ...jonArrives.detections,
    { label: 'toolbox', confidence: 0.92, box: box(0.3, 0.45, 0.4, 0.35) },
    { label: 'adjustable wrench', confidence: 0.94, box: box(0.72, 0.78, 0.15, 0.08) }, // lower-right
    { label: 'claw hammer', confidence: 0.97, box: box(0.08, 0.12, 0.14, 0.1) },        // upper-left
    { label: 'pliers', confidence: 0.88, box: box(0.45, 0.5, 0.1, 0.08) },               // center
  ],
};
const frames = [emptyBench, jonArrives, toolboxOpen, toolboxOpen];

// ── Assemble the Inspector exactly like the browser does, with scripted parts ──
const store = createSceneStore({ eventCooldownMs: 5000 });
const buffer = createFrameBuffer();
const inspector = createInspector({
  source: createScriptedSource(frames),
  detector: createMockDetector(),
  faces: createFaceRecognizer({ lookup: () => ({ identity: 'Jon', confidence: 0.91 }) }),
  store,
  buffer,
  bufferEveryNth: 1,
});
for (let i = 0; i < frames.length; i += 1) await inspector.tickOnce(now()); // let the scene settle before speech starts

// ── Vision-escalation tools wired to the REAL frame buffer + a stubbed deep-analysis model ──
const deepAnalyzer = { analyzeFrame: async () => ({ description: 'a red-handled adjustable wrench, lower-right of the toolbox' }) };
const tools = createDefaultTools({ frameBuffer: buffer, deepAnalyzer, sceneStore: store });

// ── Provider: scripted mock by default, real Groq with --provider groq (+ a key) ──
function loadGroqKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  if (process.env.VITE_GROQ_API_KEY) return process.env.VITE_GROQ_API_KEY;
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:VITE_)?GROQ_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function extractRevision(content) {
  const m = /Scene revision: (\d+)/.exec(content);
  return m ? Number(m[1]) : null;
}

// Only the CURRENT TURN line (not the whole rolling transcript window, which
// still contains earlier turns' text) decides which script branch applies.
function extractCurrentTurn(content) {
  const m = /^\[[\d:]+\] .*: (.*?) {2}<- CURRENT TURN$/m.exec(content);
  return m ? m[1] : '';
}

// A small scripted "model": keyword-matches the current turn, and checks whether
// a prior tool result is already present in the assembled context to decide
// whether this is the initial call or the bounded follow-up.
function scriptedDecide({ messages }) {
  const content = messages[0].content;
  const currentTurnText = extractCurrentTurn(content);
  const hasToolResults = /RECENT TOOL RESULTS:\n(?!\(none\))/.test(content);
  const sceneRevision = extractRevision(content);

  if (/traffic was terrible/.test(currentTurnText)) {
    return {
      decision: 'ignore', response: null, task_update: null, tool_calls: [], visual_analysis_request: null,
      reason_summary: 'Ordinary conversation between other people, not directed at the agent.', scene_revision_used: sceneRevision,
    };
  }
  if (/adjustable wrench/.test(currentTurnText) && !hasToolResults) {
    return {
      decision: 'inspect_vision', response: null, tool_calls: [], scene_revision_used: sceneRevision,
      reason_summary: 'The fast detector only gives a generic tool label; confirming before answering.',
      visual_analysis_request: { question: 'Which visible tool is most likely the adjustable wrench?', timestampMs: null },
      task_update: { active: true, taskId: 'task_wrench', goal: 'Help Jon locate the adjustable wrench', status: 'confirming-object', entities: { requestedObject: 'adjustable wrench' } },
    };
  }
  if (/adjustable wrench/.test(currentTurnText) && hasToolResults) {
    return {
      decision: 'respond', response: 'It looks like the adjustable wrench is in the lower-right of the toolbox.',
      tool_calls: [], visual_analysis_request: null, scene_revision_used: sceneRevision,
      reason_summary: 'Deep analysis confirmed the tool and its location.',
      task_update: { active: false, taskId: 'task_wrench', goal: 'Help Jon locate the adjustable wrench', status: 'done', entities: { requestedObject: 'adjustable wrench' } },
    };
  }
  if (/hammer/.test(currentTurnText)) {
    return {
      decision: 'respond', response: 'It is in the upper-left section of the toolbox.', task_update: null,
      tool_calls: [], visual_analysis_request: null, scene_revision_used: sceneRevision,
      reason_summary: 'The hammer is visible with high confidence in a fresh scene; no escalation needed.',
    };
  }
  return { decision: 'ignore', response: null, reason_summary: 'No clear request directed at the agent.', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: sceneRevision };
}

const useGroq = process.argv.includes('--provider') && process.argv[process.argv.indexOf('--provider') + 1] === 'groq';
let provider = createMockProvider(async (ctx) => scriptedDecide(ctx));
if (useGroq) {
  const apiKey = loadGroqKey();
  if (apiKey) {
    console.error('Using the real Groq provider (GROQ_API_KEY found).\n');
    provider = createGroqProvider({ apiKey });
  } else {
    console.error('No GROQ_API_KEY found (env or .env) — falling back to the scripted mock provider.\n');
  }
}

// ── Agent runtime, wired to the real tools + real scene store ──────────────────
const runtime = createAgentRuntime({ sceneStore: store, provider, tools, maxToolRounds: 2 });
runtime.beginSession(now());

const events = [];
runtime.subscribeOutput((event) => events.push(event));

const transcriptTurns = [
  { speaker: 'Jon', text: 'I went to the store yesterday and the traffic was terrible.', startedAt: 0.1, endedAt: 0.4 },
  { speaker: 'Jon', text: 'Can you grab me the adjustable wrench?', startedAt: 1.0, endedAt: 1.6 },
  { speaker: 'Jon', text: 'Where is the hammer?', startedAt: 2.0, endedAt: 2.3 },
];

console.log('── Transcript → Agent ──');
for (const turn of transcriptTurns) {
  console.log(`  ${turn.speaker}: ${turn.text}`);
  // eslint-disable-next-line no-await-in-loop
  await runtime.handleTurn(turn);
}

console.log('\n── Agent decisions ──');
for (const event of events) {
  if (event.type === 'response' || event.type === 'clarification') {
    console.log(`  [${event.type}] "${event.text}"  (rev ${event.sceneRevisionUsed}, visual age ${event.visualAgeMs}ms${event.possiblyOutdated ? ', possibly outdated' : ''})`);
  } else if (event.type === 'ignored-turn') {
    console.log(`  [ignore] ${event.reasonSummary}`);
  } else if (event.type === 'tool-started') {
    console.log(`  → tool: ${event.name}(${JSON.stringify(event.arguments)})`);
  } else if (event.type === 'tool-completed') {
    console.log(`  ${event.ok ? '✓' : '✗'} tool ${event.name} (${event.tookMs}ms)`);
  } else if (event.type === 'task-updated') {
    console.log(`  [task] ${event.taskState.goal} → ${event.taskState.status}`);
  } else if (event.type === 'error') {
    console.log(`  [error/${event.stage}] ${event.message}`);
  }
}

const responses = events.filter((e) => e.type === 'response' || e.type === 'clarification');
const checks = [
  ['Ambient remark about traffic was ignored', events.some((e) => e.type === 'ignored-turn')],
  ['No response was produced for the ambient remark', !responses.some((e) => /traffic/.test(e.text ?? ''))],
  ['Wrench request escalated to inspect_current_view', events.some((e) => e.type === 'tool-started' && e.name === 'inspect_current_view')],
  ['Vision tool executed against the real frame buffer', events.some((e) => e.type === 'tool-completed' && e.name === 'inspect_current_view' && e.ok)],
  ['Wrench response uses the tool-confirmed location', responses.some((e) => /lower-right/.test(e.text ?? ''))],
  ['Hammer answered directly with no escalation', responses.some((e) => /upper-left/.test(e.text ?? ''))],
  ['Task state was created and then marked done', events.some((e) => e.type === 'task-updated' && e.taskState.status === 'confirming-object') && events.some((e) => e.type === 'task-updated' && e.taskState.status === 'done')],
  ['No validation/model errors occurred', !events.some((e) => e.type === 'error')],
];

console.log('\n── Checks ──');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

const metrics = runtime.metrics();
console.log(`\n── Latency (avg over ${metrics.turns} turns) ──`);
console.log(`  intake -> inference-start   ${metrics.averageMs.intake} ms`);
console.log(`  context assembly            ${metrics.averageMs.assemble} ms`);
console.log(`  model                       ${metrics.averageMs.model} ms  (${useGroq && provider.name === 'groq' ? 'real Groq call' : 'mock provider'})`);
console.log(`  tool execution               ${metrics.averageMs.tool} ms`);
console.log(`  total per turn               ${metrics.averageMs.total} ms`);

// No hard process.exit(): with --provider groq it races undici socket teardown
// on Windows and trips a libuv assertion. exitCode drains cleanly.
process.exitCode = failed ? 1 : 0;
