import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, describePosition } from '../src/inspector/tracker.js';
import { classifyScene, interpretScene } from '../src/inspector/interpreter.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { shouldEscalate, createDeepAnalyzer } from '../src/inspector/deepAnalysis.js';
import { createInspector } from '../src/inspector/inspector.js';
import { createMockDetector } from '../src/inspector/detector.js';
import { createFaceRecognizer } from '../src/inspector/faces.js';
import { createScriptedSource } from '../src/inspector/video.js';

const box = (x, y, w = 0.1, h = 0.1) => ({ x, y, width: w, height: h });

test('describePosition names grid positions from normalized boxes', () => {
  assert.equal(describePosition(box(0.05, 0.05)), 'upper-left');
  assert.equal(describePosition(box(0.8, 0.8)), 'lower-right');
  assert.equal(describePosition(box(0.45, 0.45)), 'center');
  assert.equal(describePosition(undefined), 'unknown');
});

test('tracker keeps stable ids across overlapping frames and marks missing objects', () => {
  const tracker = createTracker({ missAfterMs: 100, dropAfterMs: 1000 });
  const t0 = 1000;
  const [first] = tracker.update([{ label: 'adjustable wrench', confidence: 0.9, box: box(0.7, 0.8) }], t0);
  // Slightly moved → same track id.
  const [second] = tracker.update([{ label: 'adjustable wrench', confidence: 0.92, box: box(0.72, 0.81) }], t0 + 50);
  assert.equal(second.id, first.id);
  assert.equal(second.visibility, 'visible');
  // Gone past the grace period → missing (but not dropped).
  const after = tracker.update([], t0 + 300);
  assert.equal(after.length, 1);
  assert.equal(after[0].visibility, 'missing');
  // Gone long enough → dropped.
  assert.equal(tracker.update([], t0 + 2000).length, 0);
});

test('tracker separates a person track from object tracks', () => {
  const tracker = createTracker();
  const tracks = tracker.update(
    [{ label: 'person', confidence: 0.95, box: box(0.1, 0.1) }, { label: 'toolbox', confidence: 0.9, box: box(0.5, 0.5) }],
    1000,
  );
  assert.ok(tracks.find((t) => t.label === 'person').id.startsWith('person_'));
  assert.ok(tracks.find((t) => t.label === 'toolbox').id.startsWith('obj_'));
});

test('interpreter classifies a workshop and produces a short grounded summary', () => {
  const objects = [
    { label: 'toolbox', visibility: 'visible' },
    { label: 'adjustable wrench', visibility: 'visible' },
    { label: 'claw hammer', visibility: 'visible' },
  ];
  assert.equal(classifyScene(objects), 'workshop / tools');
  const summary = interpretScene({ objects, people: [{ id: 'person_1', identity: 'Jon' }], sceneLabel: 'workshop / tools' });
  assert.match(summary, /Jon is present/);
  assert.match(summary, /toolbox/);
  assert.ok(summary.length < 200, 'summary stays short');
});

test('scene store promotes notable events with dedup and keeps state structured', () => {
  const store = createSceneStore({ eventCooldownMs: 10000 });
  const person = { id: 'person_1', identity: 'Jon', confidence: 0.9, lastSeenAt: 1000 };
  const wrench = { id: 'obj_1', label: 'wrench', confidence: 0.9, position: 'center', visibility: 'visible', firstSeenAt: 1000, lastSeenAt: 1000 };

  store.update({ objects: [wrench], people: [person], sceneLabel: 'workshop / tools', summary: 's' }, 1000);
  // Same person + object again within cooldown → no duplicate events.
  store.update({ objects: [wrench], people: [person], sceneLabel: 'workshop / tools', summary: 's' }, 1500);
  let state = store.getState();
  assert.equal(state.recentEvents.filter((e) => e.type === 'person-entered').length, 1);
  assert.equal(state.recentEvents.filter((e) => e.type === 'object-appeared').length, 1);

  // Object goes missing → object-lost event.
  store.update({ objects: [{ ...wrench, visibility: 'missing' }], people: [person] }, 3000);
  state = store.getState();
  assert.ok(state.recentEvents.some((e) => e.type === 'object-lost'));
  assert.equal(state.revision, 3);
});

test('frame buffer supports rewind by timestamp, range, and pinned keyframes', () => {
  const buffer = createFrameBuffer({ maxDurationMs: 1000, maxFrames: 5 });
  for (let i = 0; i < 8; i += 1) buffer.push({ n: i }, 1000 + i * 100);
  assert.ok(buffer.size() <= 5, 'rolling window evicts old frames');
  assert.equal(buffer.frameAt(1620).frame.n, 6, 'nearest-frame lookup');
  assert.equal(buffer.range(1500, 1700).length, 3);
  const keyframe = buffer.saveKeyframe(1700, 'test');
  assert.equal(keyframe.frame.n, 7);
  assert.equal(buffer.keyframes().length, 1);
});

test('deep analysis escalates low confidence and unidentified people, rate-limited', async () => {
  assert.match(
    shouldEscalate({ objects: [{ label: 'screwdriver', visibility: 'visible', confidence: 0.4 }], people: [] }) ?? '',
    /low-confidence screwdriver/,
  );
  assert.match(
    shouldEscalate({ objects: [], people: [{ id: 'person_1', identity: null }] }) ?? '',
    /unidentified person/,
  );
  assert.equal(shouldEscalate({ objects: [{ label: 'hammer', visibility: 'visible', confidence: 0.9 }], people: [] }), null);

  let calls = 0;
  const analyzer = createDeepAnalyzer({ cooldownMs: 10000, analyze: async () => { calls += 1; return 'ok'; } });
  const sceneState = { objects: [{ label: 'screwdriver', visibility: 'visible', confidence: 0.4 }], people: [] };
  const first = await analyzer.maybeAnalyze({ frame: {}, sceneState, at: 1000 });
  const second = await analyzer.maybeAnalyze({ frame: {}, sceneState, at: 2000 });
  assert.equal(first.requested, true);
  assert.equal(second.requested, false, 'cooldown suppresses repeat escalation');
  assert.equal(calls, 1);
});

test('inspector pipeline: scripted frames end up as live scene state with metrics', async () => {
  const store = createSceneStore();
  const buffer = createFrameBuffer();
  const source = createScriptedSource([
    { detections: [{ label: 'person', confidence: 0.95, box: box(0.1, 0.1) }] },
    { detections: [
      { label: 'person', confidence: 0.95, box: box(0.1, 0.1) },
      { label: 'adjustable wrench', confidence: 0.94, box: box(0.75, 0.8) },
    ] },
  ]);
  const inspector = createInspector({
    source,
    detector: createMockDetector(),
    faces: createFaceRecognizer({ lookup: () => ({ identity: 'Jon', confidence: 0.91 }) }),
    store,
    buffer,
    bufferEveryNth: 1,
  });

  await inspector.tickOnce(1000);
  const state = await inspector.tickOnce(1200);

  assert.equal(state.people.length, 1);
  assert.equal(state.people[0].identity, 'Jon');
  const wrench = state.objects.find((o) => o.label === 'adjustable wrench');
  assert.equal(wrench.position, 'lower-right');
  assert.equal(wrench.visibility, 'visible');
  assert.equal(buffer.size(), 2);
  assert.equal(inspector.metrics().cycles, 2);
  assert.ok(inspector.metrics().averageMs.cycle >= 0);
});
