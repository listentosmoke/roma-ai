import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createDefaultTools } from '../src/agent/tools.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';

test('registry validates required args and types before executing', async () => {
  const registry = createToolRegistry();
  let received = null;
  registry.register({
    name: 'echo',
    description: 'echoes a number',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    async execute(args) { received = args; return args.n * 2; },
  });

  const missing = await registry.execute('echo', {}, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing required argument "n"/);
  assert.equal(received, null);

  const wrongType = await registry.execute('echo', { n: 'not a number' }, {});
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /must be of type number/);

  const ok = await registry.execute('echo', { n: 5 }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 10);
});

test('unknown tool names fail safely instead of throwing', async () => {
  const registry = createToolRegistry();
  const result = await registry.execute('nonexistent', {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('a throwing tool execute() is caught and reported, not propagated', async () => {
  const registry = createToolRegistry();
  registry.register({ name: 'boom', description: '', inputSchema: {}, execute: async () => { throw new Error('kaboom'); } });
  const result = await registry.execute('boom', {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kaboom');
});

test('registration requires a name and an execute function', () => {
  const registry = createToolRegistry();
  assert.throws(() => registry.register({ description: 'no name', execute: async () => {} }));
  assert.throws(() => registry.register({ name: 'no-exec' }));
});

test('inspect_current_view analyzes the latest buffered frame and reports its age', async () => {
  const frameBuffer = createFrameBuffer();
  const frameAt = Date.now() - 500;
  frameBuffer.push({ id: 'frame-1' }, frameAt);
  const sceneStore = createSceneStore();
  let seenArgs;
  const deepAnalyzer = { analyzeFrame: async (frame, question, state, meta) => { seenArgs = { frame, question, state, meta }; return { description: 'a red-handled wrench' }; } };
  const tools = createDefaultTools({ frameBuffer, deepAnalyzer, sceneStore });

  const result = await tools.execute('inspect_current_view', { question: 'which tool is the wrench?' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.frameAt, frameAt);
  assert.equal(result.result.analysis, 'a red-handled wrench');
  assert.ok(result.result.frameAgeMs >= 0);
  assert.equal(seenArgs.frame.id, 'frame-1');
  assert.equal(seenArgs.question, 'which tool is the wrench?');
  assert.equal(seenArgs.meta.frameAt, frameAt);
});

test('inspect_current_view rejects a stale frame unless allow_stale is passed', async () => {
  const frameBuffer = createFrameBuffer({ maxDurationMs: 600000 });
  const frameAt = Date.now() - 60000; // a minute old — camera likely stopped
  frameBuffer.push({ id: 'old-frame' }, frameAt);
  const deepAnalyzer = { analyzeFrame: async () => ({ description: 'should not run un-forced' }) };
  const tools = createDefaultTools({ frameBuffer, deepAnalyzer, sceneStore: createSceneStore() });

  const rejected = await tools.execute('inspect_current_view', { question: 'what is this?' }, {});
  assert.equal(rejected.result.ok, false);
  assert.match(rejected.result.note, /old/);

  const forced = await tools.execute('inspect_current_view', { question: 'what is this?', allow_stale: true }, {});
  assert.equal(forced.result.analysis, 'should not run un-forced');
});

test('inspect_current_view fails clearly when the frame buffer is empty', async () => {
  const tools = createDefaultTools({ frameBuffer: createFrameBuffer(), deepAnalyzer: { analyzeFrame: async () => ({}) }, sceneStore: createSceneStore() });
  const result = await tools.execute('inspect_current_view', { question: 'what is this?' }, {});
  assert.equal(result.ok, true); // tool itself ran fine
  assert.equal(result.result.ok, false);
  assert.match(result.result.note, /No camera frame/);
});

test('inspect_view_at_time retrieves the frame nearest a timestamp and rejects far-off timestamps', async () => {
  const frameBuffer = createFrameBuffer();
  frameBuffer.push({ id: 'early' }, 1000);
  frameBuffer.push({ id: 'late' }, 5000);
  const deepAnalyzer = { analyzeFrame: async (frame) => ({ description: `analysis of ${frame.id}` }) };
  const tools = createDefaultTools({ frameBuffer, deepAnalyzer, sceneStore: createSceneStore() });

  const near = await tools.execute('inspect_view_at_time', { question: 'what was that?', timestampMs: 4800 }, {});
  assert.equal(near.result.analysis, 'analysis of late');
  assert.equal(near.result.frameAt, 5000);

  const farOff = await tools.execute('inspect_view_at_time', { question: 'what was that?', timestampMs: 999999 }, {});
  assert.equal(farOff.result.ok, false);
  assert.match(farOff.result.note, /No buffered frame/);
});

test('check_clock is deterministic and needs no credentials', async () => {
  const sceneStore = createSceneStore();
  sceneStore.update({ objects: [], people: [] }, 1234);
  const tools = createDefaultTools({ sceneStore });
  const result = await tools.execute('check_clock', {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.sceneRevision, 1);
  assert.ok(typeof result.result.nowMs === 'number');
});
