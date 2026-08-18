// End-to-end SELECTIVE VOICE DELIVERY simulation. Drives the real voice-delivery
// layer (Turn Manager + authorization registry + gap detector + echo suppressor
// + playback controller) together with the reactive agent runtime and the
// Opportunity Engine — all sharing ONE speech gate and ONE delivery layer, with
// a mock TTS provider and a controllable fake audio sink (no credentials, no
// real audio). It proves:
//
//   ambient → silence · coaching shown privately · spoken coaching enabled later
//   · speak_when_convenient waits while someone talks · plays after a real gap
//   · user barge-in stops playback · a new direct question supersedes it · the
//   answer is synthesized and played once · an echo of Roma's speech is
//   suppressed · different speech is preserved · an expired authorization never
//   plays · latency + cancellation metrics are printed.
//
//   npm run simulate:selective-voice

import { createVoiceDelivery } from '../src/voice/delivery.js';
import { createMockTtsProvider } from '../src/voice/ttsProvider.js';
import { createAuthorizationRegistry } from '../src/voice/authorization.js';
import { createGapDetector } from '../src/voice/gapDetector.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createOpportunityEngine } from '../src/proactive/engine.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createMockProvider } from '../src/agent/provider.js';
import { DEFAULT_PREFERENCES } from '../src/proactive/preferences.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, { timeout = 1500, step = 10 } = {}) {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeout) return false; await sleep(step); }
  return true;
}

// ── Fake audio sink: playback ends only when we call element.end(). ────────────
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

// ── Controllable voice activity. ───────────────────────────────────────────────
function fakeVA() {
  let speaking = false; let romaSpeaking = false; let lastVoiceAt = 0;
  return {
    setSpeaking(v) { speaking = v; if (v) lastVoiceAt = Date.now(); else lastVoiceAt = Date.now() - 1000; },
    isSpeaking: () => speaking, isRomaSpeaking: () => romaSpeaking, setRomaSpeaking: (v) => { romaSpeaking = v; },
    msSinceVoice: (at = Date.now()) => (speaking ? 0 : Math.max(0, at - lastVoiceAt)),
    pushSegment() {}, pushInterim() {}, dispose() {},
  };
}

// ── Shared pieces. ───────────────────────────────────────────────────────────
const preferences = { ...DEFAULT_PREFERENCES }; // spoken off by default
const speechGate = createSpeechGate();
const audio = fakeAudio();
const va = fakeVA();
const registry = createAuthorizationRegistry();
const ttsCalls = [];
const baseTts = createMockTtsProvider({ latencyMs: 5 });
const ttsProvider = { synthesize: (req) => { ttsCalls.push(req); return baseTts.synthesize(req); } };
const gapDetector = createGapDetector({ voiceActivity: va, registry, minGapMs: 40, maxWaitMs: 400, pollMs: 15 });

const events = [];
const delivery = createVoiceDelivery({ ttsProvider, registry, audioFactory: audio.factory, voiceActivity: va, gapDetector, onEvent: (e) => events.push(e) });

const HAMMER_ANSWER = 'The hammer is in the upper-left of the toolbox.';
const reactiveAgent = createAgentRuntime({
  provider: createMockProvider(async ({ messages }) => {
    const asksRoma = /Roma,/.test(messages[0].content);
    return asksRoma
      ? { decision: 'respond', response: HAMMER_ANSWER, reason_summary: 'direct question', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null }
      : { decision: 'ignore', response: null, reason_summary: 'ambient', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
  }),
  speech: delivery, speechGate, preferences: () => preferences,
});

// Scripted opportunity model: a coaching idea when a bare price is stated, and a
// distinct missing-information idea when a start date is mentioned without a
// completion date (used for the spoken speak_when_convenient scenario).
function scriptedEvaluate({ messages }) {
  const tail = /RECENT CONVERSATION \(most recent last\):\n([\s\S]*?)\n\nCURRENT SPEAKER/.exec(messages[0].content)?.[1]?.split('\n').at(-1) ?? '';
  const base = { suggestedPhrase: null, relatedEntities: [], expiresInMs: 30000, requiresPermission: false, backgroundTaskProposal: null };
  if (/\$800/.test(tail)) {
    return { opportunities: [{ ...base, type: 'conversation_coaching', content: 'Ask whether the price includes materials.', suggestedPhrase: 'Does that $800 include materials and labor?', confidence: 0.95, usefulness: 0.95, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'price without inclusions', deliveryRecommendation: 'speak_when_convenient' }] };
  }
  if (/next week/.test(tail)) {
    return { opportunities: [{ ...base, type: 'missing_information', content: 'The contractor gave a start date but no completion date.', suggestedPhrase: 'When will the work be finished?', confidence: 0.95, usefulness: 0.95, urgency: 'high', timeSensitivity: 'immediate', reasonSummary: 'start date without an end date', deliveryRecommendation: 'speak_when_convenient' }] };
  }
  return { opportunities: [] };
}
const engine = createOpportunityEngine({ provider: createMockProvider(async (ctx) => scriptedEvaluate(ctx)), preferences: () => preferences, speechGate, speech: delivery, batchWindowMs: 5 });

const spokenEvents = () => events.filter((e) => e.type === 'spoken');
const log = (msg) => console.log(msg);

// ── Scenario ───────────────────────────────────────────────────────────────────
log('── Selective Voice Delivery ──\n');

// 1. Ambient conversation → no speech.
log('  [ambient] Jon: the traffic was terrible earlier');
engine.observeTurn({ speaker: 'Jon', text: 'The traffic was terrible earlier.', at: Date.now() });
await engine.flush();
const ambientSpoke = spokenEvents().length > 0 || ttsCalls.length > 0;

// 2. A coaching opportunity, spoken OFF → shown privately (visual_only), not spoken.
log('  [price]   Bob: the repair will cost $800');
engine.observeTurn({ speaker: 'Bob', text: 'The repair will cost $800.', at: Date.now() });
await engine.flush();
const coachingShownPrivately = engine.suggestions.active().some((s) => s.deliveryMode === 'visual_only' && /materials/.test(s.content));
const noSpeechYet = ttsCalls.length === 0;

// 3. Enable spoken coaching (private earpiece: allow coaching to speak).
preferences.spokenSuggestionsEnabled = true;
preferences.publicConversationSuggestions = 'speak_when_convenient';
log('  [prefs]   spoken coaching enabled (earpiece mode)');
const spokenCoachingEnabled = preferences.spokenSuggestionsEnabled === true;

// 4. Someone is talking → an approved speak_when_convenient authorization waits.
va.setSpeaking(true);
log('  [plan]    Bob: I can start next week (someone keeps talking)');
engine.observeTurn({ speaker: 'Bob', text: 'I can start next week.', at: Date.now() });
await engine.flush();
await sleep(60);
const waitingWhileTalking = events.some((e) => e.type === 'awaiting-gap') && ttsCalls.length === 0;

// 5. The conversation opens up → playback begins after a real gap.
va.setSpeaking(false);
const startedAfterGap = await until(() => events.some((e) => e.type === 'playback-started'));
log(`  [gap]     conversation quiets → Roma begins speaking coaching: ${startedAfterGap}`);

// 6 + 7. The user interrupts Roma → playback stops.
await until(() => delivery.playback.isPlaying());
const barge = delivery.handleUserSpeech({ text: 'hang on a second', durationMs: 320 });
const userInterrupted = barge.bargeIn === true;
const playbackStopped = events.some((e) => e.type === 'playback-stopped') || events.some((e) => e.type === 'barge-in');
log(`  [barge]   user interrupts → playback stopped: ${playbackStopped}`);

// 8 + 9. A new direct question supersedes and is synthesized + played once.
const ttsBefore = ttsCalls.length;
log('  [direct]  Jon: Roma, where is the hammer?');
reactiveAgent.handleTurn({ speaker: 'Jon', text: 'Roma, where is the hammer?', startedAt: 10, endedAt: 10.5 });
const answerStarted = await until(() => delivery.playback.activeAuthorizationId() && delivery.playback.isPlaying());
const directSpokenText = HAMMER_ANSWER;
// 10 + 11. While Roma speaks the answer: an echo is suppressed, different speech kept.
const echoResult = delivery.classifyTranscript({ text: directSpokenText.toLowerCase(), startedAt: Date.now(), endedAt: Date.now() });
const differentResult = delivery.classifyTranscript({ text: 'can you also grab me a coffee', startedAt: Date.now(), endedAt: Date.now() });
audio.last().end(); // finish the answer
await sleep(20);
const answerPlayedOnce = ttsCalls.length === ttsBefore + 1 && events.some((e) => e.type === 'playback-completed');
const echoSuppressed = echoResult.isEcho === true;
const differentPreserved = differentResult.isEcho === false;

// 12. An expired speak_when_convenient authorization never plays.
va.setSpeaking(true); // keep the floor busy so it can't find a gap
const ttsBefore2 = ttsCalls.length;
const expiring = delivery.authorizeAndDeliver({
  gateDecision: { approved: true, reason: 'coaching' }, sourceType: 'conversation_coaching',
  sourceId: 'opp_expired', text: 'This idea is already stale.', delivery: 'speak_when_convenient', unprompted: true, lifetimeMs: 60,
});
const expiredOutcome = await expiring.promise;
const expiredNeverPlayed = ttsCalls.length === ttsBefore2 && expiredOutcome.outcome !== 'completed';
va.setSpeaking(false);

delivery.stopAll('sim complete');

// ── Checks ───────────────────────────────────────────────────────────────────
const checks = [
  ['Ambient conversation produced no speech', !ambientSpoke],
  ['Coaching opportunity displayed privately (visual_only)', coachingShownPrivately && noSpeechYet],
  ['Spoken coaching enabled for the later scenario', spokenCoachingEnabled],
  ['speak_when_convenient waited while someone else talked', waitingWhileTalking],
  ['Playback began after a valid conversational gap', startedAfterGap],
  ['User interrupted Roma', userInterrupted],
  ['Playback stopped on barge-in', playbackStopped],
  ['A new direct question superseded the interrupted output', answerStarted],
  ['The direct answer was synthesized and played once', answerPlayedOnce],
  ['An echo transcript matching Roma’s speech was suppressed', echoSuppressed],
  ['Different speech during playback was preserved', differentPreserved],
  ['An expired speech authorization did not play', expiredNeverPlayed],
];

log('\n── Checks ──');
let failed = 0;
for (const [label, ok] of checks) { log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed += 1; }

// 13. Metrics.
const m = delivery.metrics();
log('\n── Metrics ──');
log(`  speech authorized / denied     ${m.approved} / ${m.denied}`);
log(`  expired before play            ${m.expiredBeforePlay}`);
log(`  tts requests / failures        ${m.ttsRequests} / ${m.ttsFailures}`);
log(`  avg tts latency                ${m.avgTtsLatencyMs} ms`);
log(`  avg gap wait                   ${m.avgGapWaitMs} ms`);
log(`  barge-ins (avg stop)           ${m.bargeIns} (${m.avgBargeInStopMs} ms)`);
log(`  stop commands                  ${m.stopCommands}`);
log(`  echoes suppressed              ${m.echoesSuppressed}`);
log(`  late results discarded         ${m.lateDiscarded}`);
log(`  playback started/completed     ${m.playback.started} / ${m.playback.completed}`);
log(`  playback start latency (avg)   ${m.playback.avgStartLatencyMs} ms`);
log(`  autoplay failures              ${m.playback.autoplayFailures}`);

process.exitCode = failed ? 1 : 0;
