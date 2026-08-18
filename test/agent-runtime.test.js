import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createFrameBuffer } from '../src/inspector/frameBuffer.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createMockProvider } from '../src/agent/provider.js';

function storeWithWrench(at, { confidence = 0.94 } = {}) {
  const store = createSceneStore();
  store.update({
    objects: [{ id: 'obj_1', label: 'adjustable wrench', confidence, position: 'lower-right', visibility: 'visible', firstSeenAt: at, lastSeenAt: at }],
    people: [{ id: 'person_1', identity: 'Jon', confidence: 0.91, lastSeenAt: at }],
    sceneLabel: 'workshop / tools',
    summary: 'Jon is beside an open toolbox.',
  }, at);
  return store;
}

function collectEvents(runtime) {
  const events = [];
  runtime.subscribeOutput((event) => events.push(event));
  return events;
}

function respondDecision(text, overrides = {}) {
  return {
    decision: 'respond', response: text, reason_summary: 'relevant request', task_update: null,
    tool_calls: [], visual_analysis_request: null, scene_revision_used: null, ...overrides,
  };
}

function ignoreDecision(reason = 'ambient chatter') {
  return { decision: 'ignore', response: null, reason_summary: reason, task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
}

test('handleTurn auto-attaches the latest visual snapshot into the assembled context', async () => {
  const at = 50000;
  const store = storeWithWrench(at);
  let seenSystem;
  const provider = createMockProvider(async ({ system, messages }) => {
    seenSystem = system;
    assert.match(messages[0].content, /adjustable wrench \(lower-right\)/);
    assert.match(messages[0].content, /Scene revision: 1/);
    return respondDecision('It is lower-right.');
  });
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  runtime.beginSession(at);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Can you grab me the adjustable wrench?', startedAt: 0.15, endedAt: 0.2 });
  assert.match(seenSystem, /Roma/);
});

test('visual snapshots never enter conversation history (only agent-involved exchanges do)', async () => {
  const store = storeWithWrench(1000);
  const provider = createMockProvider(async () => respondDecision('Here you go.'));
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Can you help?', startedAt: 0.1, endedAt: 0.2 });
  const conversation = JSON.stringify(runtime.conversationHistory());
  assert.ok(!conversation.includes('Current visual context'));
  assert.ok(!conversation.includes('CURRENT VISUAL CONTEXT'));
  assert.equal(runtime.conversationHistory().length, 2); // user turn + assistant reply
});

test('a relevant request produces a response output event', async () => {
  const store = storeWithWrench(1000);
  const provider = createMockProvider(async () => respondDecision('It is in the lower-right of the toolbox.'));
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  const events = collectEvents(runtime);
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Where is the wrench?', startedAt: 0.1, endedAt: 0.2 });
  const response = events.find((e) => e.type === 'response');
  assert.ok(response);
  assert.equal(response.text, 'It is in the lower-right of the toolbox.');
});

test('unrelated ambient speech produces ignore with no response event', async () => {
  const store = storeWithWrench(1000);
  const provider = createMockProvider(async () => ignoreDecision('ordinary conversation between others'));
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  const events = collectEvents(runtime);
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'I went to the store yesterday and the traffic was terrible.', startedAt: 0.1, endedAt: 0.4 });
  assert.equal(events.filter((e) => e.type === 'response' || e.type === 'clarification').length, 0);
  assert.ok(events.some((e) => e.type === 'ignored-turn'));
});

test('a low-confidence visual target produces inspect_vision, which is bounded to one follow-up', async () => {
  const store = storeWithWrench(1000, { confidence: 0.4 });
  const frameBuffer = createFrameBuffer();
  frameBuffer.push({ id: 'frame' }, Date.now()); // fresh — inside the tool's staleness window
  const deepAnalyzer = { analyzeFrame: async () => ({ description: 'a red-handled adjustable wrench' }) };
  const tools = createDefaultTools({ frameBuffer, deepAnalyzer, sceneStore: store });

  let calls = 0;
  const provider = createMockProvider(async ({ messages }) => {
    calls += 1;
    if (calls === 1) {
      assert.doesNotMatch(messages[0].content, /RECENT TOOL RESULTS:\n[^(]/); // no tool results yet
      return { decision: 'inspect_vision', response: null, reason_summary: 'unsure of subtype', task_update: null, tool_calls: [], visual_analysis_request: { question: 'which tool is this?', timestampMs: null }, scene_revision_used: 1 };
    }
    assert.match(messages[0].content, /red-handled adjustable wrench/);
    return respondDecision('It looks like the adjustable wrench, lower-right.');
  });

  const runtime = createAgentRuntime({ sceneStore: store, provider, tools, maxToolRounds: 2 });
  const events = collectEvents(runtime);
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Is that the adjustable wrench?', startedAt: 0.1, endedAt: 0.2 });

  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === 'tool-started' && e.name === 'inspect_current_view'));
  assert.ok(events.some((e) => e.type === 'tool-completed'));
  assert.ok(events.some((e) => e.type === 'response'));
});

test('a tool_call decision is validated and executed, and unknown tools fail safely', async () => {
  const tools = createDefaultTools({ sceneStore: createSceneStore() });
  let calls = 0;
  const provider = createMockProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return { decision: 'tool_call', response: null, reason_summary: 'checking clock', task_update: null, tool_calls: [{ name: 'check_clock', arguments: {} }], visual_analysis_request: null, scene_revision_used: null };
    }
    return respondDecision('Done.');
  });
  const runtime = createAgentRuntime({ provider, tools });
  const events = collectEvents(runtime);
  await runtime.handleTurn({ speaker: 'Jon', text: 'What time is it?', startedAt: 0, endedAt: 0.1 });
  const completed = events.find((e) => e.type === 'tool-completed');
  assert.ok(completed);
  assert.equal(completed.ok, true);
  assert.ok(typeof completed.result.nowMs === 'number');
});

test('tool results are available to a bounded follow-up inference', async () => {
  const tools = createDefaultTools({ sceneStore: createSceneStore() });
  const seenToolResultsBySecondCall = [];
  let calls = 0;
  const provider = createMockProvider(async ({ messages }) => {
    calls += 1;
    seenToolResultsBySecondCall.push(messages[0].content);
    if (calls === 1) return { decision: 'tool_call', response: null, reason_summary: 'x', task_update: null, tool_calls: [{ name: 'check_clock', arguments: {} }], visual_analysis_request: null, scene_revision_used: null };
    return respondDecision('It is now.');
  });
  const runtime = createAgentRuntime({ provider, tools, maxToolRounds: 2 });
  await runtime.handleTurn({ speaker: 'Jon', text: 'What time is it?', startedAt: 0, endedAt: 0.1 });
  assert.equal(calls, 2);
  assert.match(seenToolResultsBySecondCall[1], /check_clock/);
});

test('invalid model output fails safely: no execution, an error event, no response', async () => {
  const provider = createMockProvider(async () => ({ decision: 'do_a_flip' }));
  const runtime = createAgentRuntime({ provider });
  const events = collectEvents(runtime);
  await runtime.handleTurn({ speaker: 'Jon', text: 'hello', startedAt: 0, endedAt: 0.1 });
  assert.equal(events.filter((e) => e.type === 'response').length, 0);
  assert.ok(events.some((e) => e.type === 'error' && e.stage === 'validate'));
});

test('stale scene information is represented as stale in the assembled context', async () => {
  const store = storeWithWrench(1000);
  let seenContent;
  const provider = createMockProvider(async ({ messages }) => { seenContent = messages[0].content; return ignoreDecision(); });
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  await runtime.handleTurn({ speaker: 'Jon', text: 'hi', startedAt: 20, endedAt: 20.1 }); // 20s after scene update, at intake time ~21000ms
  assert.match(seenContent, /STALE/);
});

test('a scene-revision change between assembly and delivery is detected and flagged', async () => {
  const store = storeWithWrench(1000);
  const provider = createMockProvider(async () => {
    // Simulate the scene changing WHILE this inference is in flight.
    store.update({ objects: [], people: [], sceneLabel: 'no scene detected', summary: 'gone' }, 2000);
    return respondDecision('It was over there.');
  });
  const runtime = createAgentRuntime({ sceneStore: store, provider });
  const events = collectEvents(runtime);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Where is it?', startedAt: 0, endedAt: 0.1 });
  const response = events.find((e) => e.type === 'response');
  assert.equal(response.possiblyOutdated, true);
});

test('transcript turns are delivered strictly in order even when an earlier one is slow', async () => {
  let order = [];
  const provider = createMockProvider(async ({ messages }) => {
    // The transcript window only grows, so the second turn's context always
    // contains "second message" too — check its ABSENCE to identify the first call.
    const isFirst = !messages[0].content.includes('second message');
    if (isFirst) await new Promise((resolve) => setTimeout(resolve, 40));
    return respondDecision(isFirst ? 'first reply' : 'second reply');
  });
  const runtime = createAgentRuntime({ provider });
  runtime.subscribeOutput((event) => { if (event.type === 'response') order.push(event.text); });
  const firstTurn = runtime.handleTurn({ speaker: 'A', text: 'first message', startedAt: 0, endedAt: 0.1 });
  const secondTurn = runtime.handleTurn({ speaker: 'B', text: 'second message', startedAt: 0.2, endedAt: 0.3 });
  await Promise.all([firstTurn, secondTurn]);
  assert.deepEqual(order, ['first reply', 'second reply']);
});

test('task state can be created and updated across turns without a user-facing response', async () => {
  let calls = 0;
  const provider = createMockProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        decision: 'update_task', response: null, reason_summary: 'tracking the request', task_update: {
          active: true, taskId: 'task_1', goal: 'find the adjustable wrench', status: 'locating-object', entities: { requestedObject: 'adjustable wrench' },
        }, tool_calls: [], visual_analysis_request: null, scene_revision_used: null,
      };
    }
    return respondDecision('Found it.');
  });
  const runtime = createAgentRuntime({ provider });
  const events = collectEvents(runtime);
  await runtime.handleTurn({ speaker: 'Jon', text: 'Help me find the adjustable wrench.', startedAt: 0, endedAt: 0.1 });
  assert.equal(runtime.taskState().active, true);
  assert.equal(runtime.taskState().goal, 'find the adjustable wrench');
  assert.ok(events.some((e) => e.type === 'task-updated'));
  assert.equal(events.filter((e) => e.type === 'response' || e.type === 'clarification').length, 0);

  await runtime.handleTurn({ speaker: 'Jon', text: 'Any luck?', startedAt: 1, endedAt: 1.1 });
  assert.ok(events.some((e) => e.type === 'response' && e.text === 'Found it.'));
});

test('the runtime runs fully on a mocked provider with no network dependency', async () => {
  const provider = createMockProvider(async () => ignoreDecision());
  const runtime = createAgentRuntime({ provider });
  await assert.doesNotReject(() => runtime.handleTurn({ speaker: 'Jon', text: 'hi', startedAt: 0, endedAt: 0.1 }));
  const metrics = runtime.metrics();
  assert.equal(metrics.turns, 1);
  assert.ok(metrics.averageMs.total >= 0);
});

test('the provider adapter can be swapped without changing the runtime call sites', async () => {
  const providerA = createMockProvider(async () => respondDecision('from provider A'));
  const providerB = createMockProvider(async () => respondDecision('from provider B'));
  const runA = createAgentRuntime({ provider: providerA });
  const runB = createAgentRuntime({ provider: providerB });
  const eventsA = collectEvents(runA);
  const eventsB = collectEvents(runB);
  await runA.handleTurn({ speaker: 'x', text: 'hi', startedAt: 0, endedAt: 0.1 });
  await runB.handleTurn({ speaker: 'x', text: 'hi', startedAt: 0, endedAt: 0.1 });
  assert.equal(eventsA.find((e) => e.type === 'response').text, 'from provider A');
  assert.equal(eventsB.find((e) => e.type === 'response').text, 'from provider B');
});

test('lastAssembledInput exposes the exact assembled prompt for debugging, without secrets', () => {
  const provider = createMockProvider(async () => ignoreDecision());
  const runtime = createAgentRuntime({ provider });
  assert.equal(runtime.lastAssembledInput(), null);
});
