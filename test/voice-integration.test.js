// Integration: the reactive agent runtime and the Opportunity Engine both route
// approved speech through the SAME voice-delivery boundary, and nothing reaches
// it without gate/policy approval. Uses a spy delivery to observe exactly what
// each system hands to the voice layer, plus one real-delivery precedence test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../src/agent/runtime.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createOpportunityEngine } from '../src/proactive/engine.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { DEFAULT_PREFERENCES } from '../src/proactive/preferences.js';
import { createVoiceDelivery } from '../src/voice/delivery.js';
import { createMockTtsProvider } from '../src/voice/ttsProvider.js';

function spyDelivery() {
  const calls = [];
  return {
    calls,
    authorizeAndDeliver(req) {
      calls.push(req);
      return { approved: Boolean(req.gateDecision?.approved), synthesizable: true, authorizationId: `spy_${calls.length}`, promise: Promise.resolve({ outcome: 'completed' }) };
    },
    speak() {},
  };
}

const respondDecision = (response) => ({ decision: 'respond', response, reason_summary: 'direct', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null });

// A direct answer, once the gate approves, is handed to the delivery layer as a
// speak_now/direct_response request carrying the gate decision.
test('runtime hands an approved direct answer to the voice delivery layer', async () => {
  const speech = spyDelivery();
  const runtime = createAgentRuntime({
    provider: createMockProvider(async () => respondDecision('The hammer is upper-left.')),
    speechGate: createSpeechGate(),
    preferences: () => ({ ...DEFAULT_PREFERENCES, directAnswersMaySpeak: true }),
    speech,
  });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, where is the hammer?', startedAt: 1, endedAt: 1.5 });

  assert.equal(speech.calls.length, 1);
  const req = speech.calls[0];
  assert.equal(req.sourceType, 'direct_response');
  assert.equal(req.delivery, 'speak_now');
  assert.equal(req.gateDecision.approved, true);
  const response = events.find((e) => e.type === 'response');
  assert.equal(response.spokenApproved, true);
  assert.equal(response.authorizationId, 'spy_1');
});

// If the user disabled spoken answers, the gate denies — the delivery layer is
// still the single boundary and it receives a NON-approved decision (so it never
// synthesizes), while the text response is still emitted for display.
test('runtime routes a gate-denied direct answer through delivery as not-approved', async () => {
  const speech = spyDelivery();
  const runtime = createAgentRuntime({
    provider: createMockProvider(async () => respondDecision('Upper-left.')),
    speechGate: createSpeechGate(),
    preferences: () => ({ ...DEFAULT_PREFERENCES, directAnswersMaySpeak: false }),
    speech,
  });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, where is the hammer?', startedAt: 1, endedAt: 1.5 });

  assert.equal(speech.calls.length, 1);
  assert.equal(speech.calls[0].gateDecision.approved, false);
  const response = events.find((e) => e.type === 'response');
  assert.equal(response.spokenApproved, false);
  assert.ok(response.text.includes('Upper-left')); // text still visible
});

// ── Opportunity Engine → delivery ──────────────────────────────────────────────
const baseOpportunity = {
  suggestedPhrase: null, relatedEntities: [], expiresInMs: 30000,
  requiresPermission: false, backgroundTaskProposal: null,
};

function engineWith(opportunity, preferences) {
  const speech = spyDelivery();
  const gate = createSpeechGate();
  const engine = createOpportunityEngine({
    provider: createMockProvider(async () => ({ opportunities: [opportunity] })),
    preferences: () => preferences,
    speechGate: gate,
    speech,
    batchWindowMs: 5,
  });
  return { engine, speech };
}

// 3. Visual-only coaching (the default) never reaches the delivery/TTS layer.
// Silent posture: a wearer who turns spoken suggestions OFF still gets the
// suggestion visually, and nothing reaches the voice layer. (Spoken assistance
// is the default since the glasses reframe — see the sibling test below.)
test('visual-only coaching is displayed but never handed to the voice layer', async () => {
  const { engine, speech } = engineWith(
    { ...baseOpportunity, type: 'conversation_coaching', content: 'Ask whether materials are included.', confidence: 0.95, usefulness: 0.95, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'price without inclusions', deliveryRecommendation: 'speak_when_convenient' },
    { ...DEFAULT_PREFERENCES, spokenSuggestionsEnabled: false },
  );
  const events = [];
  engine.subscribe((e) => events.push(e));
  engine.observeTurn({ speaker: 'Bob', text: 'It will cost $800.', at: Date.now() });
  await engine.flush();

  assert.equal(speech.calls.length, 0);
  assert.ok(events.some((e) => e.type === 'suggestion-displayed' && e.deliveryMode === 'visual_only'));
});

// 4. An approved speak_when_convenient suggestion is handed to the delivery layer
//    with that delivery mode (which will make it wait for a gap).
test('an approved speak_when_convenient suggestion is handed to delivery with that mode', async () => {
  const { engine, speech } = engineWith(
    { ...baseOpportunity, type: 'missing_information', content: 'The contractor never gave a completion date.', suggestedPhrase: 'When will it be finished?', confidence: 0.95, usefulness: 0.95, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'no completion date', deliveryRecommendation: 'speak_when_convenient' },
    { ...DEFAULT_PREFERENCES, spokenSuggestionsEnabled: true },
  );
  engine.observeTurn({ speaker: 'Bob', text: 'It will cost $800.', at: Date.now() });
  await engine.flush();

  assert.equal(speech.calls.length, 1);
  assert.equal(speech.calls[0].delivery, 'speak_when_convenient');
  assert.equal(speech.calls[0].unprompted, true);
});

// Glasses reframe: assistance the wearer never hears is assistance that did not
// happen. With the shipped defaults, a useful coaching suggestion the model
// only recommended showing is SPOKEN when a conversational gap allows — the
// escalation is the deterministic policy's, never the model's, and it still
// passes the Speech Gate.
test('by default a useful coaching suggestion is spoken to the wearer, not just displayed', async () => {
  const { engine, speech } = engineWith(
    { ...baseOpportunity, type: 'conversation_coaching', content: 'Ask whether materials are included.', confidence: 0.95, usefulness: 0.95, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'price without inclusions', deliveryRecommendation: 'visual_only' },
    { ...DEFAULT_PREFERENCES },
  );
  engine.observeTurn({ speaker: 'Bob', text: 'It will cost $800.', at: Date.now() });
  await engine.flush();

  assert.equal(speech.calls.length, 1, 'the wearer should hear it');
  assert.equal(speech.calls[0].delivery, 'speak_when_convenient', 'waits for a real gap rather than interrupting');
});

test('an urgent risk warning is never downgraded to waiting for a gap', async () => {
  const { engine, speech } = engineWith(
    { ...baseOpportunity, type: 'risk_or_concern', content: 'That pipe is still pressurised.', confidence: 0.97, usefulness: 0.97, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'safety risk', deliveryRecommendation: 'speak_now' },
    { ...DEFAULT_PREFERENCES },
  );
  engine.observeTurn({ speaker: 'Bob', text: 'I will just crack that valve open.', at: Date.now() });
  await engine.flush();

  assert.equal(speech.calls.length, 1);
  assert.equal(speech.calls[0].delivery, 'speak_now', 'urgency must survive the glasses delivery target');
});

// 8 + 12. A direct answer takes precedence over pending proactive coaching:
//         delivered through one real voice layer, the direct answer supersedes.
test('a direct answer supersedes a pending speak_when_convenient coaching authorization', async () => {
  const delivery = createVoiceDelivery({ ttsProvider: createMockTtsProvider({ latencyMs: 5 }), audioFactory: () => ({ play: () => Promise.resolve(), pause() {}, release() {}, set onended(f) { this._e = f; }, get onended() { return this._e; }, durationMs: 500 }) });
  // Force the coaching to wait: pretend someone is speaking.
  delivery.voiceActivity.pushInterim('someone talking');

  const coaching = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'coaching' }, sourceType: 'conversation_coaching',
    sourceId: 'opp_1', text: 'Ask about the timeline.', delivery: 'speak_when_convenient', unprompted: true, lifetimeMs: 5000,
  });
  const direct = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'user asked' }, sourceType: 'direct_response',
    sourceId: 'turn_9', text: 'The hammer is upper-left.', delivery: 'speak_now', unprompted: false,
  });

  const coachingOutcome = await coaching.promise;
  assert.notEqual(coachingOutcome.outcome, 'completed'); // superseded / discarded, never spoken over the answer
  assert.ok(direct.approved);
  delivery.stopAll();
});
