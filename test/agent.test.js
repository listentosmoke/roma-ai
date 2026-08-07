import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';

function storeWithWrench(at) {
  const store = createSceneStore();
  store.update({
    objects: [{ id: 'obj_1', label: 'adjustable wrench', confidence: 0.94, position: 'lower-right', visibility: 'visible', firstSeenAt: at, lastSeenAt: at }],
    people: [{ id: 'person_1', identity: 'Jon', confidence: 0.91, lastSeenAt: at }],
    sceneLabel: 'workshop / tools',
    summary: 'Jon is beside an open toolbox.',
  }, at);
  return store;
}

test('runtime auto-attaches the LATEST scene snapshot at inference time', async () => {
  const at = 50000;
  const store = storeWithWrench(at);
  let seen = null;
  const agent = createAgentRuntime({ sceneStore: store, infer: async (request) => { seen = request; return 'ok'; } });

  await agent.respond('Can you grab me the adjustable wrench?', at + 150);
  assert.match(seen.visualContext, /adjustable wrench \(lower-right\)/);
  assert.match(seen.visualContext, /updated 150 ms ago/);

  // Scene changes between inferences → next inference sees the NEW state.
  store.update({ objects: [], people: [], sceneLabel: 'no scene detected', summary: 'Nobody is visible; no objects detected.' }, at + 5000);
  await agent.respond('And now?', at + 5100);
  assert.match(seen.visualContext, /Visible objects: none detected/);
});

test('scene snapshots never enter conversation history', async () => {
  const store = storeWithWrench(1000);
  const agent = createAgentRuntime({ sceneStore: store, infer: async () => 'reply' });
  await agent.respond('hello', 1100);
  await agent.respond('again', 1200);
  const history = JSON.stringify(agent.history());
  assert.ok(!history.includes('Current visual context'), 'no snapshot text in history');
  assert.equal(agent.history().filter((h) => h.role === 'assistant').length, 2);
});

test('transcripts are recorded on the shared epoch clock for audio/video alignment', () => {
  const agent = createAgentRuntime();
  agent.beginSession(1_000_000);
  const entry = agent.observeTranscript({ speaker: 'Speaker 2', text: 'Tell me about your family history.', startedAt: 12.5, endedAt: 14.2 });
  assert.equal(entry.at, 1_012_500);
  assert.equal(entry.endedAtMs, 1_014_200);
  assert.equal(agent.history()[0].speaker, 'Speaker 2');
});

test('runtime works with no scene store (audio-only mode)', async () => {
  const agent = createAgentRuntime();
  const { reply, visualContext } = await agent.respond('hi');
  assert.equal(visualContext, '');
  assert.match(reply, /Visual context attached: no/);
});
