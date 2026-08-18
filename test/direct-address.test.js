// Direct-address guard — the deterministic backstop that stops Roma from
// staying silent when it was plainly asked something. It may only trigger a
// single re-inference; it must never fabricate an answer or override a
// considered second refusal.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDirectAddress, buildCorrectionNote, correctionSucceeded, DIRECT_ADDRESS_REASONS } from '../src/agent/directAddress.js';
import { createAgentRuntime } from '../src/agent/runtime.js';

const ignoreDecision = (turnAnalysis = null) => ({ decision: 'ignore', turnAnalysis });

test('an ignore with the wake word present is inconsistent', () => {
  const result = checkDirectAddress({ decision: ignoreDecision(), hasWakeWord: true, engagementActive: false });
  assert.equal(result.inconsistent, true);
  assert.equal(result.reasonCode, 'wake_word_ignored');
  assert.ok(DIRECT_ADDRESS_REASONS.includes(result.reasonCode));
});

test('an ignore during an open interaction window is inconsistent (wake-word-free follow-up)', () => {
  const result = checkDirectAddress({ decision: ignoreDecision(), hasWakeWord: false, engagementActive: true });
  assert.equal(result.inconsistent, true);
  assert.equal(result.reasonCode, 'engagement_follow_up_ignored');
});

test('an ignore that contradicts the model\'s own addressed_to="roma" is inconsistent', () => {
  const result = checkDirectAddress({ decision: ignoreDecision({ addressedTo: 'roma' }), hasWakeWord: false, engagementActive: false });
  assert.equal(result.inconsistent, true);
  assert.equal(result.reasonCode, 'analysis_contradicts_decision');
});

test('ordinary ambient speech is never flagged', () => {
  const result = checkDirectAddress({ decision: ignoreDecision({ addressedTo: 'another_person' }), hasWakeWord: false, engagementActive: false });
  assert.equal(result.inconsistent, false);
  assert.equal(result.reasonCode, null);
});

test('engaged decisions and silent task updates are never flagged', () => {
  for (const decision of ['respond', 'clarify', 'tool_call', 'inspect_vision', 'update_task']) {
    const result = checkDirectAddress({ decision: { decision }, hasWakeWord: true, engagementActive: true });
    assert.equal(result.inconsistent, false, `${decision} must not be rechecked`);
  }
});

test('the correction note states the contradiction and explicitly preserves the right to ignore again', () => {
  const note = buildCorrectionNote('the wearer said your name in this turn');
  assert.match(note, /the wearer said your name/);
  assert.match(note, /ignore.*again/i, 'the model must be allowed to refuse a second time');
  assert.match(note, /Do not invent a response/i, 'must never pressure the model into fabricating an answer');
});

test('only an engaged decision counts as a successful correction', () => {
  assert.equal(correctionSucceeded({ decision: 'respond' }), true);
  assert.equal(correctionSucceeded({ decision: 'tool_call' }), true);
  assert.equal(correctionSucceeded({ decision: 'ignore' }), false);
  assert.equal(correctionSucceeded({ decision: 'update_task' }), false, 'a silent task update does not answer a direct question');
});

// ── runtime integration ─────────────────────────────────────────────────────

function decisionProvider(sequence) {
  const calls = [];
  let index = 0;
  return {
    calls,
    provider: {
      infer: async (request) => {
        calls.push(request);
        const raw = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        return { decisionRaw: raw, latencyMs: 1 };
      },
    },
  };
}

const RAW = {
  ignore: { decision: 'ignore', response: null, reason_summary: 'not for me', task_update: null, tool_calls: [], visual_analysis_request: null, turn_analysis: { speaker_role: 'other_person', addressed_to: 'unclear', wearer_expected_to_respond: false, assist_opportunity: null }, scene_revision_used: null },
  respond: { decision: 'respond', response: 'It is 3pm.', reason_summary: 'answered the wearer', task_update: null, tool_calls: [], visual_analysis_request: null, turn_analysis: { speaker_role: 'wearer', addressed_to: 'roma', wearer_expected_to_respond: false, assist_opportunity: null }, scene_revision_used: null },
};

test('a wake-word turn the model ignored is rechecked once and answered', async () => {
  const { provider, calls } = decisionProvider([RAW.ignore, RAW.respond]);
  const runtime = createAgentRuntime({ provider, sceneStore: { getState: () => null } });
  const events = [];
  runtime.subscribeOutput((event) => events.push(event));
  runtime.beginSession(0);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'Roma, what time is it?', startedAt: 0, endedAt: 1 });

  assert.equal(calls.length, 2, 'exactly one re-inference');
  assert.ok(calls[1].messages[0].content.includes('DIRECT-ADDRESS CHECK'), 'the retry states the contradiction');
  assert.ok(events.some((e) => e.type === 'direct-address-recheck' && e.reasonCode === 'wake_word_ignored'));
  assert.ok(events.some((e) => e.type === 'direct-address-resolved' && e.corrected === true));
  assert.ok(events.some((e) => e.type === 'response' && e.text === 'It is 3pm.'), 'the wearer actually gets an answer');
});

test('a second refusal stands — the guard never forces or fabricates a response', async () => {
  const { provider, calls } = decisionProvider([RAW.ignore, RAW.ignore]);
  const runtime = createAgentRuntime({ provider, sceneStore: { getState: () => null } });
  const events = [];
  runtime.subscribeOutput((event) => events.push(event));
  runtime.beginSession(0);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'Roma is a nice name for a robot', startedAt: 0, endedAt: 1 });

  assert.equal(calls.length, 2, 'rechecked once, not repeatedly');
  assert.ok(events.some((e) => e.type === 'direct-address-resolved' && e.corrected === false));
  assert.ok(events.some((e) => e.type === 'ignored-turn'), 'the considered second refusal is honoured');
  assert.ok(!events.some((e) => e.type === 'response'), 'nothing was invented');
});

test('ambient speech is not rechecked at all — no extra model call', async () => {
  const { provider, calls } = decisionProvider([RAW.ignore]);
  const runtime = createAgentRuntime({ provider, sceneStore: { getState: () => null } });
  runtime.beginSession(0);
  await runtime.handleTurn({ speaker: 'Speaker 1', text: 'yeah traffic was bad today', startedAt: 0, endedAt: 1 });
  assert.equal(calls.length, 1, 'the common case must stay single-inference');
});
