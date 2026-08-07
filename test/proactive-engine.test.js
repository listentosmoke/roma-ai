import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityEngine } from '../src/proactive/engine.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createSuggestionStore } from '../src/proactive/suggestionStore.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { DEFAULT_PREFERENCES } from '../src/proactive/preferences.js';
import { makeOpportunity } from './proactive.test.js';

const prefs = (overrides = {}) => ({ ...DEFAULT_PREFERENCES, ...overrides });

function coachingEvaluation() {
  return { opportunities: [makeOpportunity()] };
}

function buildEngine({ decide, preferences = prefs(), speech, speechGate, onTaskApproved, store } = {}) {
  let providerCalls = 0;
  const provider = createMockProvider(async (context) => { providerCalls += 1; return decide ? decide(context, providerCalls) : { opportunities: [] }; });
  const events = [];
  const engine = createOpportunityEngine({
    provider,
    preferences: () => preferences,
    speechGate: speechGate ?? createSpeechGate(),
    speech,
    store,
    batchWindowMs: 5,
    onTaskApproved,
  });
  engine.subscribe((event) => events.push(event));
  return { engine, events, providerCalls: () => providerCalls };
}

const turn = (text, at = Date.now(), speaker = 'Jon') => ({ speaker, text, at });

test('ordinary ambient conversation produces no suggestion (empty evaluations are normal)', async () => {
  const { engine, events, providerCalls } = buildEngine({ decide: () => ({ opportunities: [] }) });
  engine.observeTurn(turn('I went to the store yesterday and the traffic was terrible.'));
  await engine.flush();
  assert.equal(providerCalls(), 1);
  assert.equal(events.filter((e) => e.type === 'suggestion-displayed').length, 0);
});

test('a missing-detail opportunity produces a concise visual-only coaching suggestion', async () => {
  const { engine, events } = buildEngine({ decide: coachingEvaluation });
  engine.observeTurn(turn('The repair will cost $800.'));
  await engine.flush();
  const displayed = events.find((e) => e.type === 'suggestion-displayed');
  assert.ok(displayed);
  assert.equal(displayed.deliveryMode, 'visual_only');
  const active = engine.suggestions.active();
  assert.equal(active[0].content, 'Ask whether the price includes materials.');
  assert.ok(active[0].suggestedPhrase);
});

test('multiple rapid turns are batched into ONE evaluation', async () => {
  const { engine, providerCalls } = buildEngine({ decide: () => ({ opportunities: [] }) });
  const base = Date.now();
  engine.observeTurn(turn('We should probably', base));
  engine.observeTurn(turn('be able to finish', base + 50));
  engine.observeTurn(turn('sometime next week.', base + 100));
  await engine.flush();
  assert.equal(providerCalls(), 1);
});

test('evaluation fingerprints prevent duplicate model calls for the same state', async () => {
  const { engine, providerCalls } = buildEngine({ decide: () => ({ opportunities: [] }) });
  const t = turn('The repair will cost $800.');
  engine.observeTurn({ ...t, id: 'turn_1' });
  await engine.flush();
  await engine.requestEvaluation(); // same last turn, same task/tool state
  assert.equal(providerCalls(), 1);
  assert.equal(engine.metrics().fingerprintSkips, 1);
});

test('no model call occurs per video frame — only transcript/meaningful events trigger evaluation', async () => {
  const { engine, providerCalls } = buildEngine({ decide: () => ({ opportunities: [] }) });
  for (let i = 0; i < 50; i += 1) engine.observeEvent('inspector-event', { revision: i }); // no transcript yet
  await engine.flush();
  assert.equal(providerCalls(), 0);
});

test('duplicate suggestions across evaluations are suppressed via the store', async () => {
  const { engine, events } = buildEngine({
    decide: (_, call) => ({
      opportunities: [makeOpportunity({
        content: call === 1 ? 'Ask whether materials are included.' : 'Clarify if the price includes materials.',
      })],
    }),
  });
  engine.observeTurn(turn('The repair will cost $800.', Date.now(), 'Bob'));
  await engine.flush();
  engine.observeTurn(turn('And it should be done next week.', Date.now() + 200, 'Bob'));
  await engine.flush();
  assert.equal(events.filter((e) => e.type === 'suggestion-displayed').length, 1);
  assert.equal(engine.metrics().duplicatesSuppressed, 1);
  assert.ok(events.some((e) => e.type === 'policy-suppressed' && e.duplicateOf));
});

test('a later transcript that resolves the issue invalidates the open suggestion', async () => {
  const { engine } = buildEngine({
    decide: (_, call) => (call === 1 ? coachingEvaluation() : { opportunities: [] }),
  });
  engine.observeTurn(turn('The repair will cost $800.'));
  await engine.flush();
  assert.equal(engine.suggestions.active().length, 1);
  engine.observeTurn(turn('Yes, the $800 price includes all materials and labor.', Date.now() + 500, 'Bob'));
  await engine.flush();
  assert.equal(engine.suggestions.active().length, 0);
  assert.equal(engine.suggestions.all()[0].expiredReason, 'resolved by the conversation');
});

test('reactive coordination: coaching about a turn the agent is answering is discarded', async () => {
  const { engine, events } = buildEngine({ decide: coachingEvaluation });
  engine.observeTurn(turn('Roma, what should I ask about the price?'), { reactiveHandled: true });
  await engine.flush();
  assert.equal(events.filter((e) => e.type === 'suggestion-displayed').length, 0);
  const discarded = events.find((e) => e.type === 'opportunity-discarded');
  assert.match(discarded.policyReason, /already answering/);
});

test('the speech adapter is called ONLY after deterministic policy approval', async () => {
  const spoken = [];
  const speech = { speak: (text) => spoken.push(text) };

  // Model demands speech, but spoken suggestions are disabled → no speak call.
  const blocked = buildEngine({
    decide: () => ({ opportunities: [makeOpportunity({ deliveryRecommendation: 'speak_now', urgency: 'high' })] }),
    preferences: prefs({ spokenSuggestionsEnabled: false }),
    speech,
  });
  blocked.engine.observeTurn(turn('The repair will cost $800.'));
  await blocked.engine.flush();
  assert.equal(spoken.length, 0);
  assert.equal(blocked.events.filter((e) => e.type === 'suggestion-spoken-approved').length, 0);
  // …the useful idea still surfaced privately.
  assert.equal(blocked.events.find((e) => e.type === 'suggestion-displayed').deliveryMode, 'visual_only');

  // Enabled + urgent/immediate + within budget → exactly one approved speak.
  const allowed = buildEngine({
    decide: () => ({ opportunities: [makeOpportunity({ type: 'risk_or_concern', deliveryRecommendation: 'speak_now', urgency: 'high', timeSensitivity: 'immediate', usefulness: 0.95, confidence: 0.95 })] }),
    preferences: prefs({ spokenSuggestionsEnabled: true }),
    speech,
  });
  allowed.engine.observeTurn(turn('Watch out, that ladder is not locked.'));
  await allowed.engine.flush();
  assert.equal(spoken.length, 1);
  assert.equal(allowed.events.filter((e) => e.type === 'suggestion-spoken-approved').length, 1);
});

test('a planning opportunity creates a proposal that waits for approval and never auto-starts', async () => {
  const approvedTasks = [];
  const { engine, events } = buildEngine({
    decide: () => ({
      opportunities: [makeOpportunity({
        type: 'planning',
        content: 'I can help create a checklist and timeline for finishing this before Friday.',
        relatedEntities: [{ name: 'deadline', value: 'Friday' }],
        backgroundTaskProposal: {
          goal: 'Create a checklist and timeline for completing the repair before Friday.',
          category: 'planning',
          reason: 'The user mentioned a deadline but has no visible plan.',
          estimatedSteps: ['Identify required work', 'Create timeline', 'Present plan'],
          requiredCapabilities: ['create_internal_plan'],
        },
      })],
    }),
    onTaskApproved: (task) => approvedTasks.push(task),
  });
  engine.observeTurn(turn('I need to finish this before Friday.'));
  await engine.flush();

  const proposal = engine.proposals()[0];
  assert.equal(proposal.status, 'awaiting_approval');
  assert.ok(events.some((e) => e.type === 'task-proposed'));
  assert.ok(events.some((e) => e.type === 'permission-required'));
  assert.equal(approvedTasks.length, 0, 'nothing runs before approval');

  const result = engine.approveProposal(proposal.proposalId);
  assert.equal(result.ok, true);
  assert.equal(approvedTasks.length, 1);
  assert.equal(approvedTasks[0].goal, proposal.goal);
  assert.ok(events.some((e) => e.type === 'task-approved'));
});

test('proposals needing unavailable/external capabilities cannot be executed even when approved', async () => {
  const approvedTasks = [];
  const { engine, events } = buildEngine({
    decide: () => ({
      opportunities: [makeOpportunity({
        type: 'task_proposal',
        content: 'I could text Bob the confirmation.',
        backgroundTaskProposal: { goal: 'Send Bob a confirmation message', category: 'communication', reason: 'commitment made', estimatedSteps: [], requiredCapabilities: ['send_message'] },
      })],
    }),
    onTaskApproved: (task) => approvedTasks.push(task),
  });
  engine.observeTurn(turn('I will confirm with Bob later.'));
  await engine.flush();
  const proposal = engine.proposals()[0];
  const result = engine.approveProposal(proposal.proposalId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no implementation|not available/);
  assert.equal(approvedTasks.length, 0);
  assert.ok(events.some((e) => e.type === 'task-rejected'));
});

test('rejecting a proposal records it without creating any task', async () => {
  const { engine } = buildEngine({
    decide: () => ({
      opportunities: [makeOpportunity({
        type: 'planning',
        backgroundTaskProposal: { goal: 'Plan the repair', category: 'planning', reason: 'r', estimatedSteps: [], requiredCapabilities: ['create_internal_plan'] },
      })],
    }),
  });
  engine.observeTurn(turn('I need to finish this before Friday.'));
  await engine.flush();
  const proposal = engine.proposals()[0];
  assert.equal(engine.rejectProposal(proposal.proposalId).ok, true);
  assert.equal(engine.proposals()[0].status, 'rejected');
});

test('invalid Opportunity Engine output fails safely: error event, nothing surfaced', async () => {
  const { engine, events } = buildEngine({ decide: () => ({ totally: 'wrong' }) });
  engine.observeTurn(turn('The repair will cost $800.'));
  await engine.flush();
  assert.ok(events.some((e) => e.type === 'error' && e.stage === 'opportunity-validate'));
  assert.equal(engine.suggestions.active().length, 0);
});

test('quiet mode: the same opportunity that balanced mode shows is suppressed', async () => {
  const quiet = buildEngine({ decide: coachingEvaluation, preferences: prefs({ assistanceMode: 'quiet' }) });
  quiet.engine.observeTurn(turn('The repair will cost $800.'));
  await quiet.engine.flush();
  assert.equal(quiet.events.filter((e) => e.type === 'suggestion-displayed').length, 0);

  const balanced = buildEngine({ decide: coachingEvaluation, preferences: prefs({ assistanceMode: 'balanced' }) });
  balanced.engine.observeTurn(turn('The repair will cost $800.'));
  await balanced.engine.flush();
  assert.equal(balanced.events.filter((e) => e.type === 'suggestion-displayed').length, 1);
});

test('disabling proactive assistance entirely stops evaluations', async () => {
  const { engine, providerCalls } = buildEngine({ decide: coachingEvaluation, preferences: prefs({ proactiveAssistanceEnabled: false }) });
  engine.observeTurn(turn('The repair will cost $800.'));
  await engine.flush();
  assert.equal(providerCalls(), 0);
});

test('reactive agent + shared speech gate: direct answers pass, and the adapter is gated', async () => {
  let t = 1_000_000;
  const gate = createSpeechGate({ now: () => t });
  const spoken = [];
  const speech = { speak: (text) => spoken.push(text) };

  const respond = { decision: 'respond', response: 'It is lower-right.', reason_summary: 'x', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
  const runtime = createAgentRuntime({
    provider: createMockProvider(async () => respond),
    speech,
    speechGate: gate,
    preferences: () => prefs({ directAnswersMaySpeak: true }),
  });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, where is the wrench?', startedAt: 0, endedAt: 0.1 });
  assert.equal(spoken.length, 1, 'prompted direct answer speaks');
  assert.equal(events.find((e) => e.type === 'response').spokenApproved, true);

  // Direct spoken answers disabled → same pipeline, no speech, event says why.
  const muted = createAgentRuntime({
    provider: createMockProvider(async () => respond),
    speech,
    speechGate: gate,
    preferences: () => prefs({ directAnswersMaySpeak: false }),
  });
  const mutedEvents = [];
  muted.subscribeOutput((e) => mutedEvents.push(e));
  await muted.handleTurn({ speaker: 'Jon', text: 'Roma, where is the wrench?', startedAt: 0, endedAt: 0.1 });
  assert.equal(spoken.length, 1, 'no additional speech');
  const response = mutedEvents.find((e) => e.type === 'response');
  assert.equal(response.spokenApproved, false);
  assert.match(response.speechReason, /disabled/);
});

test('runtime.setTaskState validates external task updates (approved proposals)', () => {
  const runtime = createAgentRuntime({ provider: createMockProvider(async () => ({})) });
  const ok = runtime.setTaskState({ active: true, taskId: 'task_9', goal: 'Plan the repair', status: 'planned', entities: { source: 'proactive-proposal' } });
  assert.equal(ok.ok, true);
  assert.equal(runtime.taskState().goal, 'Plan the repair');
  const bad = runtime.setTaskState({ active: true });
  assert.equal(bad.ok, false);
});
