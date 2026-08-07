// Voice-delivery orchestrator scenarios — the heart of Selective Voice Delivery.
// Uses a mock TTS provider and a controllable fake audio sink so the full path
// (authorization → Turn Manager → gap → TTS → playback), plus barge-in, stop
// commands, echo suppression, cancellation, and autoplay handling, is exercised
// deterministically without real audio or credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceDelivery } from '../src/voice/delivery.js';
import { createMockTtsProvider } from '../src/voice/ttsProvider.js';
import { createAuthorizationRegistry } from '../src/voice/authorization.js';
import { createGapDetector } from '../src/voice/gapDetector.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake audio sink: play() resolves immediately; playback ends only when the
// test calls element.end(). Elements record whether they were released.
function fakeAudio({ rejectPlay = false } = {}) {
  const elements = [];
  const factory = () => {
    const el = {
      played: false, released: false, onended: null, onerror: null, durationMs: 800,
      play: () => { el.played = true; return rejectPlay ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve(); },
      pause: () => {},
      release: () => { el.released = true; },
      end: () => el.onended && el.onended(),
    };
    elements.push(el);
    return el;
  };
  return { factory, elements, last: () => elements.at(-1) };
}

function spyTts(opts) {
  const base = createMockTtsProvider(opts);
  const calls = [];
  return { calls, provider: { synthesize: (req) => { calls.push(req); return base.synthesize(req); } } };
}

// Controllable voice activity for gap/barge-in tests.
function fakeVA() {
  let speaking = false; let romaSpeaking = false; let lastVoiceAt = 0;
  return {
    setSpeaking(v, at = Date.now()) { speaking = v; if (v) lastVoiceAt = at; },
    isSpeaking: () => speaking,
    isRomaSpeaking: () => romaSpeaking,
    setRomaSpeaking: (v) => { romaSpeaking = v; },
    msSinceVoice: (at = Date.now()) => (speaking ? 0 : lastVoiceAt ? Math.max(0, at - lastVoiceAt) : Infinity),
    pushSegment() {}, dispose() {},
  };
}

function buildDelivery({ ttsOpts = { latencyMs: 5 }, rejectPlay = false, voiceActivity } = {}) {
  const audio = fakeAudio({ rejectPlay });
  const tts = spyTts(ttsOpts);
  const registry = createAuthorizationRegistry();
  const va = voiceActivity ?? undefined;
  const gapDetector = va ? createGapDetector({ voiceActivity: va, registry, minGapMs: 30, maxWaitMs: 300, pollMs: 15 }) : undefined;
  const events = [];
  const delivery = createVoiceDelivery({
    ttsProvider: tts.provider, registry, audioFactory: audio.factory, voiceActivity: va, gapDetector,
    onEvent: (e) => events.push(e),
  });
  return { delivery, audio, tts, events, registry };
}

const APPROVED = { approved: true, reason: 'user directly addressed Roma' };
function directReq(text = 'The wrench is in the lower-right.', extra = {}) {
  return { gateDecision: APPROVED, sourceType: 'direct_response', sourceId: 'turn_1', text, delivery: 'speak_now', unprompted: false, ...extra };
}

// 1. Direct response approved by the gate reaches TTS and plays.
test('an approved direct response reaches TTS and completes playback', async () => {
  const { delivery, audio, tts } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  assert.equal(r.approved, true);
  await sleep(30);
  assert.equal(tts.calls.length, 1);
  assert.equal(audio.last().played, true);
  audio.last().end();
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'completed');
  assert.equal(audio.last().released, true); // 19. resources released
});

// 2 + 24. Denied speech never reaches TTS; unauthorized cannot synthesize.
test('gate-denied speech never reaches TTS, and fabricated authorizations are blocked', async () => {
  const { delivery, tts, registry, audio } = buildDelivery();
  const r = delivery.authorizeAndDeliver({ ...directReq(), gateDecision: { approved: false, reason: 'spoken answers disabled' } });
  assert.equal(r.approved, false);
  await sleep(20);
  assert.equal(tts.calls.length, 0);
  // A hand-crafted authorization not minted by the gate cannot start playback.
  const blocked = await delivery.playback.play({ authorization: { authorizationId: 'forged_1' }, audio: new Uint8Array([1]), turnId: 'x' });
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(registry.canStart('forged_1'), false);
  assert.equal(audio.elements.length, 0);
});

// 4. speak_when_convenient waits for a gap, then plays.
test('speak_when_convenient waits for a conversational gap before playing', async () => {
  const va = fakeVA();
  va.setSpeaking(true); // someone is talking
  const { delivery, audio, tts } = buildDelivery({ voiceActivity: va });
  const r = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'coaching enabled' }, sourceType: 'conversation_coaching',
    sourceId: 'opp_1', text: 'Ask whether materials are included.', delivery: 'speak_when_convenient', unprompted: true,
  });
  await sleep(50);
  assert.equal(tts.calls.length, 0); // still waiting — nobody may hear it
  va.setSpeaking(false, Date.now() - 100); // conversation opens up
  await sleep(80);
  assert.equal(tts.calls.length, 1);
  audio.last()?.end();
  await r.promise;
});

// 5. speak_when_convenient does not play while someone keeps speaking.
test('speak_when_convenient is discarded (not played) if the gap never comes', async () => {
  const va = fakeVA();
  va.setSpeaking(true);
  const { delivery, tts } = buildDelivery({ voiceActivity: va });
  const r = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'coaching' }, sourceType: 'conversation_coaching',
    sourceId: 'opp_2', text: 'Mention the deadline.', delivery: 'speak_when_convenient', unprompted: true,
  });
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'timeout');
  assert.equal(tts.calls.length, 0);
});

// 6. Expired coaching is discarded while waiting.
test('a speak_when_convenient authorization that expires while waiting never plays', async () => {
  const va = fakeVA();
  va.setSpeaking(true);
  const { delivery, tts } = buildDelivery({ voiceActivity: va });
  const r = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'coaching' }, sourceType: 'conversation_coaching',
    sourceId: 'opp_3', text: 'Old idea.', delivery: 'speak_when_convenient', unprompted: true, lifetimeMs: 60,
  });
  const outcome = await r.promise;
  assert.ok(outcome.outcome === 'expired' || outcome.outcome === 'timeout');
  assert.equal(tts.calls.length, 0);
});

// 7. Invalidated coaching is discarded while waiting.
test('coaching invalidated by the conversation is dropped while waiting for a gap', async () => {
  const va = fakeVA();
  va.setSpeaking(true);
  const { delivery, tts } = buildDelivery({ voiceActivity: va });
  let valid = true;
  const r = delivery.authorizeAndDeliver({
    gateDecision: { approved: true, reason: 'coaching' }, sourceType: 'conversation_coaching',
    sourceId: 'opp_4', text: 'Ask about price.', delivery: 'speak_when_convenient', unprompted: true,
    isStillValid: () => valid,
  });
  setTimeout(() => { valid = false; }, 40);
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'invalidated');
  assert.equal(tts.calls.length, 0);
});

// 9 + 12. Only one response plays; a newer one replaces the pending/active one.
test('only one response plays at a time; a newer direct answer replaces it', async () => {
  const { delivery, audio, tts } = buildDelivery();
  const a = delivery.authorizeAndDeliver(directReq('First answer.', { sourceId: 'turn_1' }));
  await sleep(20);
  assert.equal(delivery.playback.isPlaying(), true);
  const b = delivery.authorizeAndDeliver(directReq('Second, newer answer.', { sourceId: 'turn_2' }));
  const aOutcome = await a.promise;
  assert.equal(aOutcome.outcome, 'stopped'); // superseded
  assert.equal(audio.elements[0].released, true);
  await sleep(20);
  audio.last().end();
  await b.promise;
  assert.equal(tts.calls.length, 2);
  assert.equal(audio.elements.filter((e) => !e.released).length, 0);
});

// 11 + 16. New input cancels in-flight TTS; late results from the old turn discarded.
test('a newer turn cancels in-flight synthesis and the late result is discarded', async () => {
  const { delivery, tts } = buildDelivery({ ttsOpts: { latencyMs: 120 } });
  const a = delivery.authorizeAndDeliver(directReq('Slow first answer.', { sourceId: 'turn_1' }));
  await sleep(20); // A is synthesizing
  const b = delivery.authorizeAndDeliver(directReq('Interrupting answer.', { sourceId: 'turn_2' }));
  const aOutcome = await a.promise;
  assert.ok(['timeout', 'discarded'].includes(aOutcome.outcome), `A outcome was ${aOutcome.outcome}`);
  assert.ok(delivery.turnManager.lateDiscardedCount() >= 0);
  await sleep(140);
  assert.equal(tts.calls.length, 2);
  b.promise.catch(() => {});
});

// 13. User barge-in stops playback quickly.
test('genuine user speech during playback triggers a barge-in that stops playback', async () => {
  const { delivery, audio } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  await sleep(20);
  assert.equal(delivery.playback.isPlaying(), true);
  const handling = delivery.handleUserSpeech({ text: 'actually hold on', durationMs: 300 });
  assert.equal(handling.bargeIn, true);
  assert.equal(handling.stopped, true);
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'stopped');
  assert.equal(audio.last().released, true);
  assert.equal(delivery.metrics().bargeIns, 1);
});

// 14. A short noise below the threshold does NOT interrupt.
test('a short sub-threshold noise does not trigger barge-in', async () => {
  const { delivery } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  await sleep(20);
  const handling = delivery.handleUserSpeech({ text: 'uh', durationMs: 50 });
  assert.notEqual(handling.bargeIn, true);
  assert.equal(delivery.playback.isPlaying(), true);
  assert.equal(delivery.metrics().bargeIns, 0);
  delivery.stopAll();
  await r.promise;
});

// 15. A deterministic stop phrase stops playback immediately.
test('a deterministic stop phrase stops playback without an LLM round-trip', async () => {
  const { delivery, audio } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  await sleep(20);
  const handling = delivery.handleUserSpeech({ text: 'stop', durationMs: 120 });
  assert.equal(handling.stopCommand, true);
  assert.equal(handling.forward, true); // still forwarded to the agent afterward
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'stopped');
  assert.equal(audio.last().released, true);
  assert.equal(delivery.metrics().stopCommands, 1);
});

// 17 + 18. Echo of Roma's speech is suppressed; different speech is preserved.
test('a transcript matching Roma’s playback is suppressed; different speech is kept', async () => {
  const { delivery } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq('The hammer is in the upper-left.'));
  await sleep(20);
  const echo = delivery.handleUserSpeech({ text: 'the hammer is in the upper left', durationMs: 300, startedAt: Date.now(), endedAt: Date.now() });
  assert.equal(echo.echo, true);
  assert.equal(echo.forward, false);
  const real = delivery.handleUserSpeech({ text: 'can you pass me a coffee', durationMs: 300, startedAt: Date.now(), endedAt: Date.now() });
  assert.notEqual(real.echo, true);
  assert.equal(real.forward, true); // preserved (and it barged in)
  assert.ok(delivery.metrics().echoesSuppressed >= 1);
  await r.promise.catch(() => {});
});

// Regression: clearing an <audio> element's src during release() fires a
// delayed 'error' event on some browsers. That must not be reported as a
// playback failure once the response already completed successfully.
test('a delayed error event after release (from clearing src) is not reported as a failure', async () => {
  const { delivery, audio, events } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  await sleep(20);
  audio.last().end(); // onended -> playback-completed, release() called
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'completed');
  // Simulate the browser's delayed error firing on the now-released element.
  audio.last().onerror?.();
  assert.equal(events.filter((e) => e.type === 'playback-failed').length, 0);
  assert.equal(delivery.metrics().playback.failed, 0);
});

// 20. Browser autoplay rejection is handled without freezing.
test('an autoplay rejection is handled gracefully (blocked, not frozen)', async () => {
  const { delivery, tts } = buildDelivery({ rejectPlay: true });
  const r = delivery.authorizeAndDeliver(directReq());
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'blocked');
  assert.equal(tts.calls.length, 1);
  assert.ok(delivery.metrics().playback.autoplayFailures >= 1);
});

// 21. A TTS timeout returns the system to listening.
test('a TTS timeout fails cleanly and returns to listening', async () => {
  const { delivery } = buildDelivery({ ttsOpts: { failWith: { code: 'timeout', message: 'timed out' } } });
  const r = delivery.authorizeAndDeliver(directReq());
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'timeout');
  assert.ok(delivery.metrics().ttsTimeouts >= 1);
});

// 22. A TTS failure leaves the (already-emitted) text response intact.
test('a TTS failure does not throw and the text was accepted for display', async () => {
  const { delivery } = buildDelivery({ ttsOpts: { failWith: { code: 'server', message: 'boom' } } });
  const r = delivery.authorizeAndDeliver(directReq());
  assert.equal(r.synthesizable, true); // the text passed prep and was authorized/displayable
  const outcome = await r.promise;
  assert.equal(outcome.outcome, 'failed');
  assert.ok(delivery.metrics().ttsFailures >= 1);
});

// 23. Authorization IDs remain consistent from gate through playback.
test('the authorization id is consistent across authorize → spoken → playback events', async () => {
  const { delivery, audio, events } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq());
  await sleep(20);
  audio.last().end();
  await r.promise;
  const authId = r.authorizationId;
  const authorized = events.find((e) => e.type === 'authorized');
  const spoken = events.find((e) => e.type === 'spoken');
  const playbackStarted = events.find((e) => e.type === 'playback-started');
  assert.equal(authorized.authorizationId, authId);
  assert.equal(spoken.authorizationId, authId);
  assert.equal(playbackStarted.authorizationId, authId);
});

// Structured/empty text is never synthesized even when the gate approves.
test('approved-but-unsynthesizable text (JSON/empty) never calls TTS', async () => {
  const { delivery, tts } = buildDelivery();
  const r = delivery.authorizeAndDeliver(directReq('{"decision":"respond"}'));
  assert.equal(r.approved, true);
  assert.equal(r.synthesizable, false);
  await sleep(20);
  assert.equal(tts.calls.length, 0);
});
