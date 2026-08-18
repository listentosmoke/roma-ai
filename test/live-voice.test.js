// Live Voice Verification & Hardening pass — unit tests for the new pure
// modules (addressee classification, deterministic engagement tracker, audio
// readiness, the server-side voice catalog, the diagnostic trace merge, and
// the pending speak_when_convenient reducer) plus the runtime-level wiring
// that makes addressee/engagement observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAddressee, hasWakeWord, ADDRESSEE_OUTCOMES } from '../src/agent/addressee.js';
import { createEngagementTracker } from '../src/agent/engagement.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createAudioReadiness, AUDIO_READY_STATE } from '../src/voice/audioReadiness.js';
import { createVoiceCatalog } from '../src/voice/voiceCatalog.js';
import { buildDiagnosticTrace } from '../src/voice/diagnosticsTrace.js';
import { pendingSpeechReducer } from '../src/voice/pendingSpeechTracker.js';
import { createAuthorizationRegistry } from '../src/voice/authorization.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── addressee classification ──────────────────────────────────────────────────
test('classifyAddressee: wake word + respond is high confidence', () => {
  const r = classifyAddressee({ text: 'Roma, what time is it?', decision: 'respond', engagementActive: false });
  // The record now also carries the wearer-centered turn analysis (schema.js
  // turn_analysis); with none supplied it degrades to unknown/unclear rather
  // than guessing.
  assert.deepEqual(r, {
    decision: 'respond',
    addressedToRoma: true,
    confidence: 0.95,
    reasonCode: 'wake_word_direct_address',
    speakerRole: 'unknown',
    addressedTo: 'unclear',
    wearerExpectedToRespond: false,
    assistOpportunity: null,
  });
});

test('classifyAddressee: engagement continuation without the wake word', () => {
  const r = classifyAddressee({ text: 'and the wrench too', decision: 'respond', engagementActive: true });
  assert.equal(r.addressedToRoma, true);
  assert.equal(r.reasonCode, 'engagement_continuation');
  assert.ok(r.confidence < 0.95 && r.confidence > 0.5);
});

test('classifyAddressee: ambient conversation between other people is ignore, high confidence', () => {
  const r = classifyAddressee({ text: 'yeah traffic was bad today', decision: 'ignore', engagementActive: false });
  assert.deepEqual(r, {
    decision: 'ignore',
    addressedToRoma: false,
    confidence: 0.95,
    reasonCode: 'ambient_conversation',
    speakerRole: 'unknown',
    addressedTo: 'unclear',
    wearerExpectedToRespond: false,
    assistOpportunity: null,
  });
});

// ── wearer-centered classification (glasses reframe) ─────────────────────────
// Roma runs on glasses: most speech it hears is aimed at the WEARER. Staying
// silent must be distinguishable from not understanding — these codes are what
// let the proactive layer tell "nothing was happening" from "that was the
// wearer's conversation, and I could help".

test('classifyAddressee: someone speaking TO the wearer is not ambient — it is addressed_to_wearer', () => {
  const r = classifyAddressee({
    text: 'Did the building five quote ever go out?',
    decision: 'ignore',
    engagementActive: false,
    turnAnalysis: { speakerRole: 'other_person', addressedTo: 'wearer', wearerExpectedToRespond: false, assistOpportunity: null },
  });
  assert.equal(r.reasonCode, 'addressed_to_wearer');
  assert.equal(r.addressedToRoma, false);
  assert.equal(r.addressedTo, 'wearer');
});

test('classifyAddressee: a question the wearer must answer is flagged wearer_reply_expected and carries the assist hint', () => {
  const r = classifyAddressee({
    text: 'What time is our meeting tomorrow?',
    decision: 'ignore',
    engagementActive: false,
    turnAnalysis: { speakerRole: 'other_person', addressedTo: 'wearer', wearerExpectedToRespond: true, assistOpportunity: 'the wearer noted the meeting is at 9am' },
  });
  assert.equal(r.reasonCode, 'wearer_reply_expected');
  assert.equal(r.wearerExpectedToRespond, true);
  assert.equal(r.assistOpportunity, 'the wearer noted the meeting is at 9am');
  assert.equal(r.addressedToRoma, false, 'helping the wearer is never the same as being addressed');
});

test('classifyAddressee: two other people talking is a third-party conversation, and the wearer talking is wearer_speaking', () => {
  const thirdParty = classifyAddressee({
    text: 'I told him it would be Friday',
    decision: 'ignore',
    engagementActive: false,
    turnAnalysis: { speakerRole: 'other_person', addressedTo: 'another_person', wearerExpectedToRespond: false, assistOpportunity: null },
  });
  assert.equal(thirdParty.reasonCode, 'third_party_conversation');

  const wearerTalking = classifyAddressee({
    text: 'sure, I can drop it off later',
    decision: 'ignore',
    engagementActive: false,
    turnAnalysis: { speakerRole: 'wearer', addressedTo: 'another_person', wearerExpectedToRespond: false, assistOpportunity: null },
  });
  assert.equal(wearerTalking.reasonCode, 'wearer_speaking');
});

test('classifyAddressee: analysis never overrides an actual answer — engaging still reads as addressed to Roma', () => {
  const r = classifyAddressee({
    text: 'Roma, what time is it?',
    decision: 'respond',
    engagementActive: false,
    turnAnalysis: { speakerRole: 'wearer', addressedTo: 'roma', wearerExpectedToRespond: false, assistOpportunity: null },
  });
  assert.equal(r.addressedToRoma, true);
  assert.equal(r.reasonCode, 'wake_word_direct_address');
});

test('classifyAddressee: wake word present but the model judged it not a request', () => {
  const r = classifyAddressee({ text: 'Roma is a nice name for a robot', decision: 'ignore', engagementActive: false });
  assert.equal(r.reasonCode, 'wake_word_but_not_a_request');
  assert.equal(r.addressedToRoma, false);
});

test('classifyAddressee: only respond/clarify/ignore ever come out', () => {
  for (const decision of ['respond', 'clarify', 'ignore', 'update_task', 'tool_call']) {
    const r = classifyAddressee({ text: 'x', decision, engagementActive: false });
    assert.ok(ADDRESSEE_OUTCOMES.includes(r.decision));
  }
});

test('hasWakeWord matches "roma" as a whole word only', () => {
  assert.equal(hasWakeWord('Roma, stop'), true);
  assert.equal(hasWakeWord('aroma candle'), false);
});

// ── engagement tracker ────────────────────────────────────────────────────────
test('engagement tracker: entry, continuation within window, then timeout', () => {
  let clock = 1000;
  const eng = createEngagementTracker({ timeoutMs: 5000, now: () => clock });
  assert.equal(eng.isActive(), false);
  eng.markEngaged('turn_1', clock);
  assert.equal(eng.isActive(), true);
  clock += 4000; // still inside the window
  assert.equal(eng.isActive(clock), true);
  assert.ok(eng.remainingMs(clock) > 0 && eng.remainingMs(clock) <= 1000);
  clock += 2000; // now past the 5s window
  assert.equal(eng.isActive(clock), false);
  assert.equal(eng.remainingMs(clock), 0);
});

test('engagement tracker: exit is immediate and deterministic, independent of the timer', () => {
  let clock = 0;
  const eng = createEngagementTracker({ timeoutMs: 30000, now: () => clock });
  eng.markEngaged('turn_1', clock);
  assert.equal(eng.isActive(), true);
  eng.markExited('stop phrase');
  assert.equal(eng.isActive(), false);
  assert.equal(eng.state().lastExitReason, 'stop phrase');
});

// ── runtime wiring: addressee-decision events + engagement continuation ────────
const respondDecision = (response) => ({ decision: 'respond', response, reason_summary: 'ok', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null });
const ignoreDecision = () => ({ decision: 'ignore', response: null, reason_summary: 'ambient', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null });

test('runtime emits an addressee-decision event with the normalized shape for a direct address', async () => {
  const runtime = createAgentRuntime({ provider: createMockProvider(async () => respondDecision('It is 3pm.')) });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, what time is it?', startedAt: 1, endedAt: 1.5 });
  const addressee = events.find((e) => e.type === 'addressee-decision');
  assert.ok(addressee);
  assert.equal(addressee.decision, 'respond');
  assert.equal(addressee.addressedToRoma, true);
  assert.equal(addressee.reasonCode, 'wake_word_direct_address');
  assert.equal(typeof addressee.confidence, 'number');
  assert.equal(addressee.turnId, 1);
  assert.equal(addressee.speaker, 'Jon');
  assert.equal(addressee.text, 'Roma, what time is it?');
});

test('a follow-up during an active interaction is accepted without repeating the wake word', async () => {
  // Scripted model: engages on the wake word, then on a bare follow-up ONLY if
  // told (via engagementActive in the prompt) that it's a continuation —
  // proving the deterministic engagement signal actually reaches the model.
  const provider = createMockProvider(async ({ messages }) => {
    const body = messages[0].content;
    const engaged = /ACTIVE INTERACTION: yes/.test(body);
    const asksDirectly = /Roma,/.test(body.split('<- CURRENT TURN')[0].split('\n').at(-1) ?? '');
    if (asksDirectly || engaged) return respondDecision('ok');
    return ignoreDecision();
  });
  const runtime = createAgentRuntime({ provider, engagement: createEngagementTracker({ timeoutMs: 20000 }) });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));

  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, can you check the toolbox?', startedAt: 1, endedAt: 1.5 });
  await runtime.handleTurn({ speaker: 'Jon', text: 'and the wrench too', startedAt: 2, endedAt: 2.5 }); // no wake word

  const decisions = events.filter((e) => e.type === 'addressee-decision');
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].reasonCode, 'wake_word_direct_address');
  assert.equal(decisions[1].decision, 'respond'); // accepted as a continuation
  assert.equal(decisions[1].reasonCode, 'engagement_continuation');
  assert.equal(runtime.engagementState().active, true);
});

test('interaction timeout returns the system to ambient listening (wake word required again)', async () => {
  // Real (short) timeout + a real delay between turns — the runtime stamps
  // engagement using its own wall clock (session start + relative segment
  // seconds), so the test must stay on that same real time base rather than
  // injecting an unrelated fake clock into the tracker alone.
  const provider = createMockProvider(async ({ messages }) => {
    const body = messages[0].content;
    const engaged = /ACTIVE INTERACTION: yes/.test(body);
    const asksDirectly = /Roma,/.test(body.split('<- CURRENT TURN')[0].split('\n').at(-1) ?? '');
    return (asksDirectly || engaged) ? respondDecision('ok') : ignoreDecision();
  });
  const engagement = createEngagementTracker({ timeoutMs: 50 });
  const runtime = createAgentRuntime({ provider, engagement });

  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, hello', startedAt: 0, endedAt: 0.1 });
  assert.equal(runtime.engagementState().active, true);

  await sleep(150); // well past the 50ms timeout
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  await runtime.handleTurn({ speaker: 'Jon', text: 'still there?', startedAt: 1, endedAt: 1.1 });
  const decision = events.find((e) => e.type === 'addressee-decision');
  assert.equal(decision.decision, 'ignore'); // timed out — needs the wake word again
  assert.equal(decision.reasonCode, 'ambient_conversation');
});

test('exitEngagement is immediate and deterministic (used for a detected stop phrase)', async () => {
  const runtime = createAgentRuntime({ provider: createMockProvider(async () => respondDecision('ok')) });
  await runtime.handleTurn({ speaker: 'Jon', text: 'Roma, hello', startedAt: 0, endedAt: 0.1 });
  assert.equal(runtime.engagementState().active, true);
  runtime.exitEngagement('stop phrase');
  assert.equal(runtime.engagementState().active, false);
  assert.equal(runtime.engagementState().lastExitReason, 'stop phrase');
});

// ── audio readiness ────────────────────────────────────────────────────────────
function fakeAudioEl({ rejectPlay = false } = {}) {
  return { play: () => (rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()), pause() {}, currentTime: 0 };
}

test('audio readiness: unlock() succeeds -> ready', async () => {
  const ar = createAudioReadiness({ audioFactory: () => fakeAudioEl() });
  assert.equal(ar.state(), AUDIO_READY_STATE.LOCKED);
  const result = await ar.unlock();
  assert.equal(result, AUDIO_READY_STATE.READY);
  assert.equal(ar.state(), AUDIO_READY_STATE.READY);
});

test('audio readiness: autoplay rejection -> blocked, and does not throw', async () => {
  const ar = createAudioReadiness({ audioFactory: () => fakeAudioEl({ rejectPlay: true }) });
  const result = await ar.unlock();
  assert.equal(result, AUDIO_READY_STATE.BLOCKED);
});

test('audio readiness: manual re-unlock recovers from blocked to ready', async () => {
  let reject = true;
  const ar = createAudioReadiness({ audioFactory: () => fakeAudioEl({ rejectPlay: reject }) });
  await ar.unlock();
  assert.equal(ar.state(), AUDIO_READY_STATE.BLOCKED);
  reject = false; // user clicks "Enable Audio" after granting/retrying
  await ar.unlock();
  assert.equal(ar.state(), AUDIO_READY_STATE.READY);
});

test('audio readiness: no Audio API available -> error, not a thrown exception', async () => {
  const ar = createAudioReadiness({ audioFactory: () => null });
  const result = await ar.unlock();
  assert.equal(result, AUDIO_READY_STATE.ERROR);
});

test('audio readiness: markBlocked/markReady reflect real playback outcomes', () => {
  const ar = createAudioReadiness({ audioFactory: () => fakeAudioEl() });
  ar.markBlocked();
  assert.equal(ar.state(), AUDIO_READY_STATE.BLOCKED);
  ar.markReady();
  assert.equal(ar.state(), AUDIO_READY_STATE.READY);
});

// ── voice catalog (server-side; mocked fetch — no real network) ────────────────
test('voice catalog: fetches and normalizes the Deepgram model list, disambiguating collisions', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      tts: [
        { canonical_name: 'aura-2-thalia-en', name: 'thalia', architecture: 'aura-2', languages: ['en'], metadata: { display_name: 'Thalia' } },
        { canonical_name: 'aura-arcas-en', name: 'arcas', architecture: 'aura', languages: ['en'], metadata: { display_name: 'Arcas' } },
        { canonical_name: 'aura-2-arcas-en', name: 'arcas', architecture: 'aura-2', languages: ['en'], metadata: { display_name: 'Arcas' } },
        { canonical_name: 'aura-2-agathe-fr', name: 'agathe', architecture: 'aura-2', languages: ['fr'], metadata: { display_name: 'Agathe' } }, // filtered out (not English)
      ],
    }),
  });
  const catalog = createVoiceCatalog({ fetchImpl });
  const { voices, fallback } = await catalog.listVoices({ provider: 'deepgram', apiKey: 'k', defaultVoice: 'aura-2-thalia-en' });
  assert.equal(fallback, false);
  assert.equal(voices.some((v) => v.id === 'aura-2-agathe-fr'), false); // non-English excluded
  const arcasEntries = voices.filter((v) => /arcas/i.test(v.displayName));
  assert.equal(arcasEntries.length, 2);
  assert.notEqual(arcasEntries[0].displayName, arcasEntries[1].displayName); // disambiguated
});

test('voice catalog: falls back to just the configured default when the live fetch fails', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const catalog = createVoiceCatalog({ fetchImpl });
  const { voices, fallback } = await catalog.listVoices({ provider: 'deepgram', apiKey: 'k', defaultVoice: 'aura-2-thalia-en' });
  assert.equal(fallback, true);
  assert.deepEqual(voices.map((v) => v.id), ['aura-2-thalia-en']);
});

test('voice catalog: guarantees the configured default is present even if absent from the live list', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tts: [{ canonical_name: 'aura-2-luna-en', architecture: 'aura-2', languages: ['en'], metadata: { display_name: 'Luna' } }] }) });
  const catalog = createVoiceCatalog({ fetchImpl });
  const { voices } = await catalog.listVoices({ provider: 'deepgram', apiKey: 'k', defaultVoice: 'aura-2-retired-voice' });
  assert.ok(voices.some((v) => v.id === 'aura-2-retired-voice'));
});

// ── diagnostics trace ──────────────────────────────────────────────────────────
test('buildDiagnosticTrace merges and time-orders agent + delivery events, redacting nothing sensitive', () => {
  const agentEvents = [
    { type: 'addressee-decision', at: 100, turnId: 1, transcriptId: 't1', speaker: 'Jon', text: 'Roma, hi', decision: 'respond', addressedToRoma: true, confidence: 0.95, reasonCode: 'wake_word_direct_address' },
    { type: 'response', at: 105, turnId: 1, text: 'Hello!', spokenApproved: true, authorizationId: 'a1' },
  ];
  const deliveryEvents = [
    { type: 'authorized', at: 102, authorizationId: 'a1', turnId: 'turn_1', sourceType: 'direct_response', delivery: 'speak_now', text: 'Hello!' },
    { type: 'spoken', at: 110, authorizationId: 'a1', turnId: 'turn_1', provider: 'deepgram-tts', voice: 'aura-2-thalia-en' },
  ];
  const trace = buildDiagnosticTrace(agentEvents, deliveryEvents);
  assert.equal(trace.length, 4);
  assert.deepEqual(trace.map((r) => r.at), [100, 102, 105, 110]); // time-ordered
  assert.ok(trace.every((r) => JSON.stringify(r).length < 500)); // no huge dumps (no full prompts)
  assert.ok(!JSON.stringify(trace).includes('apiKey'));
});

test('buildDiagnosticTrace is bounded by limit', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ type: 'ignored-turn', at: i, turnId: i }));
  const trace = buildDiagnosticTrace(many, [], { limit: 50 });
  assert.equal(trace.length, 50);
  assert.equal(trace[0].agentTurnId, 150); // kept the most recent 50
});

// ── pending speak_when_convenient reducer ──────────────────────────────────────
test('pendingSpeechReducer: authorized (speak_when_convenient) creates a pending record with registry details', () => {
  const registry = createAuthorizationRegistry();
  const auth = registry.mint({ approved: true, reason: 'coaching' }, { sourceType: 'conversation_coaching', sourceId: 'opp_1', text: 'Ask about materials.', delivery: 'speak_when_convenient', priority: 'low', lifetimeMs: 15000 });
  const next = pendingSpeechReducer(null, { type: 'authorized', authorizationId: auth.authorizationId, turnId: 'turn_1', delivery: 'speak_when_convenient', sourceType: 'conversation_coaching', text: 'Ask about materials.', policyReason: 'ok', at: Date.now() }, registry);
  assert.equal(next.authorizationId, auth.authorizationId);
  assert.equal(next.priority, 'low');
  assert.ok(next.expiresAt > Date.now());
});

test('pendingSpeechReducer: speak_now authorizations never become pending', () => {
  const next = pendingSpeechReducer(null, { type: 'authorized', authorizationId: 'a1', turnId: 't1', delivery: 'speak_now', sourceType: 'direct_response', text: 'hi' }, createAuthorizationRegistry());
  assert.equal(next, null);
});

test('pendingSpeechReducer: awaiting-gap and synthesizing update the waiting reason without clearing', () => {
  let state = { authorizationId: 'a1', turnId: 't1', waitingReason: 'authorized...' };
  state = pendingSpeechReducer(state, { type: 'awaiting-gap', authorizationId: 'a1' });
  assert.match(state.waitingReason, /quiet moment/);
  state = pendingSpeechReducer(state, { type: 'turn-state', turnId: 't1', state: 'synthesizing' });
  assert.match(state.waitingReason, /synthesizing/);
});

test('pendingSpeechReducer: resolution events (spoken/discarded/cancelled/completed/stopped-all) clear immediately', () => {
  const base = { authorizationId: 'a1', turnId: 't1' };
  assert.equal(pendingSpeechReducer(base, { type: 'spoken', authorizationId: 'a1' }), null);
  assert.equal(pendingSpeechReducer(base, { type: 'speech-discarded', authorizationId: 'a1' }), null);
  assert.equal(pendingSpeechReducer(base, { type: 'turn-cancelled', authorizationId: 'a1' }), null);
  assert.equal(pendingSpeechReducer(base, { type: 'turn-completed', turnId: 't1' }), null); // no authorizationId on this event
  assert.equal(pendingSpeechReducer(base, { type: 'stopped-all' }), null);
});

test('pendingSpeechReducer: an unrelated turn resolution event never clears a different pending item', () => {
  const base = { authorizationId: 'a1', turnId: 't1' };
  const unchanged = pendingSpeechReducer(base, { type: 'turn-completed', turnId: 't2' }, null);
  assert.equal(unchanged, base);
});
