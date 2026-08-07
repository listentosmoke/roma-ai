import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSceneSnapshot, isStale } from '../src/context/compiler.js';
import { emptySceneState } from '../src/inspector/sceneStore.js';

function sampleState(at = 100000) {
  return {
    ...emptySceneState(),
    revision: 12,
    updatedAt: at,
    scene: { label: 'workshop / tools', summary: 'Jon is present with several tools in view.' },
    objects: [
      { id: 'obj_1', label: 'adjustable wrench', confidence: 0.94, position: 'lower-right', visibility: 'visible', lastSeenAt: at },
      { id: 'obj_2', label: 'claw hammer', confidence: 0.97, position: 'upper-left', visibility: 'visible', lastSeenAt: at },
      { id: 'obj_3', label: 'pliers', confidence: 0.88, position: 'center', visibility: 'missing', lastSeenAt: at - 4000 },
    ],
    people: [{ id: 'person_1', identity: 'Jon', confidence: 0.91, lastSeenAt: at }],
    recentEvents: [{ at: at - 2000, type: 'person-entered', message: 'Jon entered the scene' }],
  };
}

test('compiler renders a compact agent-facing snapshot from scene state', () => {
  const snapshot = compileSceneSnapshot(sampleState(), { at: 100120 });
  assert.match(snapshot, /^Current visual context:/);
  assert.match(snapshot, /Scene: workshop \/ tools — Jon is present/);
  assert.match(snapshot, /adjustable wrench \(lower-right\)/);
  assert.match(snapshot, /claw hammer \(upper-left\)/);
  assert.match(snapshot, /Recently out of view: pliers/);
  assert.match(snapshot, /People present: Jon \(91%\)/);
  assert.match(snapshot, /Recent events: Jon entered the scene/);
  assert.match(snapshot, /Scene state updated 120 ms ago/);
  assert.ok(!snapshot.includes('STALE'));
});

test('compiler returns empty for a never-updated state and flags stale data', () => {
  assert.equal(compileSceneSnapshot(emptySceneState(), { at: 5000 }), '');
  assert.equal(compileSceneSnapshot(null), '');
  const old = compileSceneSnapshot(sampleState(100000), { at: 200000 });
  assert.match(old, /STALE/);
  assert.equal(isStale(sampleState(100000), 200000), true);
  assert.equal(isStale(sampleState(100000), 100100), false);
});

test('compiler caps the object list and orders by confidence', () => {
  const state = sampleState();
  state.objects = Array.from({ length: 12 }, (_, i) => ({
    id: `obj_${i}`, label: `tool-${i}`, confidence: i / 12, position: 'center', visibility: 'visible', lastSeenAt: state.updatedAt,
  }));
  const snapshot = compileSceneSnapshot(state, { at: state.updatedAt, maxObjects: 4 });
  const line = snapshot.split('\n').find((l) => l.startsWith('- Visible objects:'));
  assert.match(line, /\(\+8 more\)/);
  assert.ok(line.includes('tool-11'), 'highest confidence first');
  assert.ok(!line.includes('tool-0,'), 'lowest confidence dropped');
});
