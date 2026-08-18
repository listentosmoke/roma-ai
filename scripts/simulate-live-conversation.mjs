// LIVE CONVERSATION simulation for the Voice Verification & Hardening pass.
// Injects finalized transcript events through the exact same per-segment
// pipeline the browser uses (echo classification -> barge-in/stop handling ->
// the agent runtime's public handleSegment entry point -> the Opportunity
// Engine) — mirroring App.processSegment in src/main.jsx. Mock TTS + a
// controllable fake audio sink stand in for the browser; no credentials
// needed. Proves, in one continuous conversation:
//
//   1. Ambient speech between two other speakers -> ignored
//   2. "Roma, where did I put the wrench?" -> agent responds
//   3. A speech authorization is minted
//   4. TTS and playback run (mock providers)
//   5. Roma's own reply, heard back as mic echo -> suppressed
//   6. A follow-up without saying "Roma" -> accepted (engagement continuation)
//   7. A proactive suggestion waits while someone else is talking
//   8. A gap opens -> the eligible suggestion plays
//   9. The user interrupts a later direct answer -> playback cancelled
//  10. A stop phrase cancels immediately, without waiting for the model
//  11. The interaction times out -> later ambient speech is ignored again
//  12. No response ever plays twice
//
//   npm run simulate:live-conversation

import { createVoiceDelivery } from '../src/voice/delivery.js';
import { createMockTtsProvider } from '../src/voice/ttsProvider.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createEngagementTracker } from '../src/agent/engagement.js';
import { createOpportunityEngine } from '../src/proactive/engine.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createMockProvider } from '../src/agent/provider.js';
import { DEFAULT_PREFERENCES } from '../src/proactive/preferences.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, { timeout = 2000, step = 10 } = {}) {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeout) return false; await sleep(step); }
  return true;
}

// ── Fake audio sink + controllable voice activity (same pattern as the
// selective-voice simulation) — playback ends only when the script calls
// element.end(); voice activity is driven explicitly, not by a real mic. ──────
function fakeAudio() {
  const elements = [];
  const factory = () => {
    const el = { played: false, released: false, onended: null, onerror: null, durationMs: 600,
      play() { el.played = true; return Promise.resolve(); }, pause() {}, release() { el.released = true; },
      end() { el.onended && el.onended(); } };
    elements.push(el); return el;
  };
  return { factory, elements, last: () => elements.at(-1) };
}
function fakeVA() {
  let speaking = false; let romaSpeaking = false; let lastVoiceAt = 0;
  return {
    setSpeaking(v) { speaking = v; lastVoiceAt = v ? Date.now() : Date.now() - 1000; },
    isSpeaking: () => speaking, isRomaSpeaking: () => romaSpeaking, setRomaSpeaking: (v) => { romaSpeaking = v; },
    msSinceVoice: (at = Date.now()) => (speaking ? 0 : Math.max(0, at - lastVoiceAt)),
    pushSegment() {}, pushInterim() {}, dispose() {},
  };
}

// ── Shared pieces: ONE speech gate, ONE voice-delivery layer, ONE reactive
// agent (with a real engagement tracker), ONE Opportunity Engine — exactly the
// architecture the browser wires up (useVoiceDelivery shared by useAgent and
// useProactive). ──────────────────────────────────────────────────────────────
const preferences = { ...DEFAULT_PREFERENCES, spokenSuggestionsEnabled: true, publicConversationSuggestions: 'speak_when_convenient' };
// The real Speech Gate enforces a 20s cooldown between ANY spoken output
// (direct or unsolicited) by default — correct in production, but this script
// deliberately packs several direct answers and a proactive suggestion into a
// few seconds, so the cooldown is shortened for the scenario. The gate's
// actual deterministic logic (budgets, someone-speaking, urgency) still runs.
const speechGate = createSpeechGate({ minMsBetweenSpoken: 5 });
const audio = fakeAudio();
const va = fakeVA();
const ttsCalls = [];
const baseTts = createMockTtsProvider({ latencyMs: 5 });
const ttsProvider = { synthesize: (req) => { ttsCalls.push(req); return baseTts.synthesize(req); } };

const events = [];
const delivery = createVoiceDelivery({ ttsProvider, audioFactory: audio.factory, voiceActivity: va, onEvent: (e) => events.push(e) });

const WRENCH_ANSWER = "It's in the garage, on the workbench.";
const PLIERS_ANSWER = 'The pliers are in the top drawer.';
const LOCKED_ANSWER = 'Yes, the toolbox is locked.';

// The reactive agent (agent/prompt.js) and the Opportunity Engine
// (proactive/prompt.js) assemble their context in different shapes, so each
// needs its own "what did they just say" extraction.
function currentTail(messages) {
  return messages[0].content.split('\n').find((l) => l.includes('<- CURRENT TURN'))?.replace('  <- CURRENT TURN', '') ?? '';
}
function opportunityTail(messages) {
  const conversation = /RECENT CONVERSATION \(most recent last\):\n([\s\S]*?)\n\nCURRENT SPEAKER/.exec(messages[0].content)?.[1] ?? '';
  return conversation.split('\n').at(-1) ?? '';
}
function respond(text, reason) {
  return { decision: 'respond', response: text, reason_summary: reason, task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
}
function ignore(reason) {
  return { decision: 'ignore', response: null, reason_summary: reason, task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
}

const engagement = createEngagementTracker({ timeoutMs: 300 });
const reactiveAgent = createAgentRuntime({
  provider: createMockProvider(async ({ messages }) => {
    const tail = currentTail(messages);
    const engaged = /ACTIVE INTERACTION: yes/.test(messages[0].content);
    if (/wrench/.test(tail) && /Roma,/.test(tail)) return respond(WRENCH_ANSWER, 'direct question about the wrench');
    if (/pliers/.test(tail) && engaged) return respond(PLIERS_ANSWER, 'follow-up during the active interaction');
    if (/toolbox locked/.test(tail) && /Roma,/.test(tail)) return respond(LOCKED_ANSWER, 'direct question about the toolbox');
    return ignore('not addressed to Roma');
  }),
  speech: delivery, speechGate, preferences: () => preferences, engagement,
});
const agentEvents = [];
reactiveAgent.subscribeOutput((e) => agentEvents.push(e));

function scriptedOpportunity({ messages }) {
  const tail = opportunityTail(messages);
  const base = { suggestedPhrase: null, relatedEntities: [], expiresInMs: 30000, requiresPermission: false, backgroundTaskProposal: null };
  if (/before Friday/.test(tail)) {
    return { opportunities: [{ ...base, type: 'planning', content: 'Consider listing what still needs to be done before Friday.', suggestedPhrase: "Don't forget you wanted this done before Friday.", confidence: 0.95, usefulness: 0.9, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'deadline mentioned', deliveryRecommendation: 'speak_when_convenient' }] };
  }
  return { opportunities: [] };
}
const engine = createOpportunityEngine({ provider: createMockProvider(async (ctx) => scriptedOpportunity(ctx)), preferences: () => preferences, speechGate, speech: delivery, batchWindowMs: 5 });
const engineEvents = [];
engine.subscribe((e) => engineEvents.push(e));

// ── The shared per-segment pipeline (mirrors src/main.jsx's processSegment):
// echo classify -> barge-in/stop handling -> engagement exit -> the runtime's
// public handleSegment entry point -> the Opportunity Engine. Never calls the
// Speech Gate, TTS provider, or playback controller directly. ─────────────────
let seq = 0;
async function processSegment({ speaker, text, at = Date.now(), durationMs = 400 }) {
  seq += 1;
  const startedAt = at; const endedAt = at + durationMs;
  const echo = delivery.classifyTranscript({ text, startedAt, endedAt });
  const handling = echo.isEcho ? { forward: false, echo: true } : delivery.handleUserSpeech({ text, durationMs, at: endedAt, speaker, startedAt, endedAt });
  if (handling.forward === false) return { ...handling, forwarded: false };
  if (handling.stopCommand) reactiveAgent.exitEngagement('stop phrase');
  await reactiveAgent.handleTurn({ speaker, text, startedAt: startedAt / 1000, endedAt: endedAt / 1000 });
  engine.observeTurn({ speaker, text, at: startedAt });
  return { ...handling, forwarded: true };
}

const log = (msg) => console.log(msg);
const results = {};

log('── Live conversation simulation ──\n');

// 1. Ambient speech between two other speakers -> ignored.
log('  [ambient] Bob: nice weather today. Alice: yeah, finally.');
await processSegment({ speaker: 'Bob', text: 'Nice weather today.' });
await processSegment({ speaker: 'Alice', text: 'Yeah, finally.' });
results.ambientIgnored = agentEvents.filter((e) => e.type === 'addressee-decision').every((e) => e.decision === 'ignore');
const ambientReasonCodes = agentEvents.filter((e) => e.type === 'addressee-decision').map((e) => e.reasonCode);

// 2 + 3 + 4. Direct question -> respond -> authorization minted -> TTS+playback.
log('  [direct]  Jon: Roma, where did I put the wrench?');
await processSegment({ speaker: 'Jon', text: 'Roma, where did I put the wrench?' });
const wrenchTurn = agentEvents.find((e) => e.type === 'response' && e.text === WRENCH_ANSWER);
results.respondedToWrench = Boolean(wrenchTurn);
results.authorizationMinted = Boolean(wrenchTurn?.authorizationId);
await until(() => events.some((e) => e.type === 'playback-started' && e.authorizationId === wrenchTurn?.authorizationId));
audio.last().end(); // finish the reply
await until(() => events.some((e) => e.type === 'spoken' && e.authorizationId === wrenchTurn?.authorizationId));
results.ttsAndPlaybackRan = ttsCalls.some((c) => c.text === WRENCH_ANSWER) && events.some((e) => e.type === 'playback-completed');

// 5. Roma's own reply, heard back as mic echo -> suppressed (no new agent turn).
log('  [echo]    (mic hears Roma\'s own reply back)');
const turnsBeforeEcho = agentEvents.filter((e) => e.type === 'addressee-decision').length;
const echoResult = await processSegment({ speaker: 'Jon', text: WRENCH_ANSWER, at: Date.now(), durationMs: 300 });
const turnsAfterEcho = agentEvents.filter((e) => e.type === 'addressee-decision').length;
results.echoSuppressed = echoResult.forwarded === false && turnsAfterEcho === turnsBeforeEcho;

// 6. Follow-up without saying "Roma" -> accepted (engagement continuation).
log('  [followup] Jon: What about the pliers?');
await processSegment({ speaker: 'Jon', text: 'What about the pliers?' });
const pliersTurn = agentEvents.find((e) => e.type === 'response' && e.text === PLIERS_ANSWER);
const pliersAddressee = agentEvents.find((e) => e.type === 'addressee-decision' && e.text === 'What about the pliers?');
results.followUpAccepted = Boolean(pliersTurn) && pliersAddressee?.reasonCode === 'engagement_continuation';
await until(() => events.some((e) => e.type === 'playback-started' && e.authorizationId === pliersTurn?.authorizationId));
audio.last().end();
await until(() => events.some((e) => e.type === 'spoken' && e.authorizationId === pliersTurn?.authorizationId));

// 7 + 8. A proactive suggestion waits while someone else talks, then plays on a gap.
log('  [plan]    Jon: I need to finish this before Friday. (Bob keeps talking)');
await sleep(20); // clear the shared speech-gate cooldown from the pliers reply
va.setSpeaking(true);
await processSegment({ speaker: 'Jon', text: 'I need to finish this before Friday.' });
await engine.flush();
await sleep(30);
results.suggestionWaitedForGap = engineEvents.some((e) => e.type === 'suggestion-spoken-approved') && !events.some((e) => e.type === 'playback-started' && e.authorizationId !== wrenchTurn?.authorizationId && e.authorizationId !== pliersTurn?.authorizationId);
va.setSpeaking(false); // the gap opens
const suggestionPlayed = await until(() => events.some((e) => e.type === 'playback-started' && ![wrenchTurn?.authorizationId, pliersTurn?.authorizationId].includes(e.authorizationId)));
results.suggestionPlayedAfterGap = suggestionPlayed;
if (suggestionPlayed) audio.last().end();
await sleep(30);

// 9. A later direct answer, interrupted mid-playback by the user.
log('  [direct2] Jon: Roma, is the toolbox locked? ... then interrupts.');
await processSegment({ speaker: 'Jon', text: 'Roma, is the toolbox locked?' });
const lockedTurn = agentEvents.find((e) => e.type === 'response' && e.text === LOCKED_ANSWER);
await until(() => events.some((e) => e.type === 'playback-started' && e.authorizationId === lockedTurn?.authorizationId));
const bargeResult = await processSegment({ speaker: 'Jon', text: 'actually hold on a second', durationMs: 350 });
results.userInterrupted = bargeResult.bargeIn === true;

// 10. A NEW direct answer, cancelled by a stop phrase (not waiting for the model).
log('  [direct3] Jon: Roma, is the toolbox locked? ... then says stop.');
await processSegment({ speaker: 'Jon', text: 'Roma, is the toolbox locked?' });
const lockedTurn2 = agentEvents.filter((e) => e.type === 'response' && e.text === LOCKED_ANSWER).at(-1);
await until(() => events.some((e) => e.type === 'playback-started' && e.authorizationId === lockedTurn2?.authorizationId));
const stopMetricsBefore = delivery.metrics().stopCommands;
const stopResult = await processSegment({ speaker: 'Jon', text: 'stop', durationMs: 200 });
results.stopPhraseCancelledImmediately = stopResult.stopCommand === true && delivery.metrics().stopCommands === stopMetricsBefore + 1;

// 11. Interaction timeout -> later ambient speech is ignored again.
log('  [timeout] (waiting past the engagement window)');
await sleep(400); // engagement.timeoutMs = 300
const beforeTimeoutCheck = agentEvents.filter((e) => e.type === 'addressee-decision').length;
await processSegment({ speaker: 'Jon', text: 'anyway the weather is nice' }); // no wake word
const timeoutDecision = agentEvents.filter((e) => e.type === 'addressee-decision').slice(beforeTimeoutCheck)[0];
results.timeoutRevertedToAmbient = timeoutDecision?.decision === 'ignore' && timeoutDecision?.reasonCode === 'ambient_conversation';

// 12. No response ever played twice (each authorizationId spoken at most once).
const spokenAuthIds = events.filter((e) => e.type === 'spoken').map((e) => e.authorizationId);
results.neverPlaysTwice = new Set(spokenAuthIds).size === spokenAuthIds.length;

// ── Checks ───────────────────────────────────────────────────────────────────
const checks = [
  ['Ambient speech between two other speakers is ignored', results.ambientIgnored],
  ['"Roma, where did I put the wrench?" gets a real agent response', results.respondedToWrench],
  ['A speech authorization was minted for that response', results.authorizationMinted],
  ['TTS and playback ran (mock providers)', results.ttsAndPlaybackRan],
  ["Roma's own reply, heard as mic echo, is suppressed", results.echoSuppressed],
  ['A follow-up without saying "Roma" is accepted (engagement continuation)', results.followUpAccepted],
  ['A proactive suggestion waited while someone else was talking', results.suggestionWaitedForGap],
  ['The suggestion played once a real gap opened', results.suggestionPlayedAfterGap],
  ['The user interrupting a later direct answer stops it (barge-in)', results.userInterrupted],
  ['A stop phrase cancels immediately, without waiting for the model', results.stopPhraseCancelledImmediately],
  ['After the interaction times out, ambient speech is ignored again', results.timeoutRevertedToAmbient],
  ['No response ever played twice', results.neverPlaysTwice],
];

log('\n── Decision reason codes (addressee) ──');
for (const e of agentEvents.filter((e) => e.type === 'addressee-decision')) {
  log(`  turn ${e.turnId}  "${e.speaker}: ${e.text}"  ->  ${e.decision} (addressedToRoma=${e.addressedToRoma}, confidence=${e.confidence}, reasonCode=${e.reasonCode}, engagementActive=${e.engagementActive})`);
}

log('\n── Turn Manager state transitions ──');
for (const e of events.filter((e) => e.type === 'turn-started' || e.type === 'turn-state' || e.type === 'turn-completed' || e.type === 'turn-cancelled')) {
  log(`  ${e.type}  voiceTurnId=${e.turnId ?? e.voiceTurnId ?? '?'}${e.state ? ` state=${e.state}` : ''}${e.reason ? ` reason="${e.reason}"` : ''}`);
}

log('\n── Checks ──');
let failed = 0;
for (const [label, ok] of checks) { log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed += 1; }

const m = delivery.metrics();
log('\n── Metrics ──');
log(`  speech authorized / denied     ${m.approved} / ${m.denied}`);
log(`  echoes suppressed              ${m.echoesSuppressed}`);
log(`  barge-ins                      ${m.bargeIns}`);
log(`  stop commands                  ${m.stopCommands}`);
log(`  gap waits (avg)                ${m.gapWaits} (${m.avgGapWaitMs} ms)`);
log(`  playback started/completed     ${m.playback.started} / ${m.playback.completed}`);
log(`  late results discarded         ${m.lateDiscarded}`);

process.exitCode = failed ? 1 : 0;
