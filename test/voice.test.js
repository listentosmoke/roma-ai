// Unit tests for the voice-delivery building blocks: speech-text preparation,
// deterministic stop phrases, the authorization registry, the Turn Manager, the
// echo suppressor, the gap detector, and the TTS provider abstraction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareSpeechText } from '../src/voice/speechPrep.js';
import { isStopPhrase } from '../src/voice/stopPhrases.js';
import { createAuthorizationRegistry, AUTH_STATUS } from '../src/voice/authorization.js';
import { createTurnManager, TURN_STATE } from '../src/voice/turnManager.js';
import { createEchoSuppressor, textSimilarity } from '../src/voice/echoSuppressor.js';
import { createGapDetector } from '../src/voice/gapDetector.js';
import { createMockTtsProvider, createGroqTtsProvider, createDeepgramTtsProvider, createProxyTtsProvider, createTtsProvider, TtsProviderError, MAX_TTS_CHARS, bytesToBase64, base64ToBytes } from '../src/voice/ttsProvider.js';

// ── speech preparation ───────────────────────────────────────────────────────
test('prepareSpeechText strips Markdown and normalizes punctuation', () => {
  const r = prepareSpeechText('**The wrench** is in the _lower-right_ .');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'The wrench is in the lower-right.');
});

test('prepareSpeechText refuses empty, whitespace, and JSON/debug content', () => {
  assert.equal(prepareSpeechText('   ').ok, false);
  assert.equal(prepareSpeechText('').ok, false);
  assert.equal(prepareSpeechText('{"decision":"respond","response":"hi"}').ok, false);
  assert.equal(prepareSpeechText('authorizationId: speech_auth_1').ok, false);
});

test('prepareSpeechText enforces a maximum length at a word/sentence boundary', () => {
  const long = `${'This is a sentence. '.repeat(20)}`;
  const r = prepareSpeechText(long, { maxLength: 40 });
  assert.equal(r.ok, true);
  assert.ok(r.text.length <= 40);
  assert.equal(r.truncated, true);
});

// ── stop phrases ───────────────────────────────────────────────────────────────
test('isStopPhrase catches clear stop commands and ignores unrelated speech', () => {
  for (const phrase of ['stop', 'Stop!', 'be quiet', 'never mind', 'wait', 'Roma, stop', 'stop talking please']) {
    assert.equal(isStopPhrase(phrase), true, phrase);
  }
  for (const phrase of ["don't stop the car until we reach the store", 'I was waiting for the bus earlier today', 'the wrench is over there']) {
    assert.equal(isStopPhrase(phrase), false, phrase);
  }
});

// ── authorization registry ─────────────────────────────────────────────────────
test('registry never mints from an un-approved gate decision', () => {
  const reg = createAuthorizationRegistry();
  assert.equal(reg.mint({ approved: false, reason: 'nope' }, { sourceType: 'x', sourceId: '1', text: 'hi' }), null);
});

test('registry lifecycle: authorized → playing → consumed; expiry and revoke block start', () => {
  let clock = 1000;
  const reg = createAuthorizationRegistry({ now: () => clock });
  const auth = reg.mint({ approved: true, reason: 'ok' }, { sourceType: 'direct_response', sourceId: 't1', text: 'hi', lifetimeMs: 500 });
  assert.equal(reg.canStart(auth.authorizationId), true);
  reg.markPlaying(auth.authorizationId);
  assert.equal(reg.isValid(auth.authorizationId), true);
  assert.equal(reg.canStart(auth.authorizationId), false); // already playing, can't re-start
  reg.consume(auth.authorizationId);
  assert.equal(reg.get(auth.authorizationId).status, AUTH_STATUS.CONSUMED);

  const auth2 = reg.mint({ approved: true }, { sourceType: 'x', sourceId: 't2', text: 'hi', lifetimeMs: 100 });
  clock += 200; // now expired
  assert.equal(reg.canStart(auth2.authorizationId), false);
  assert.equal(reg.get(auth2.authorizationId).status, AUTH_STATUS.EXPIRED);

  const auth3 = reg.mint({ approved: true }, { sourceType: 'x', sourceId: 't3', text: 'hi', lifetimeMs: 5000 });
  reg.revoke(auth3.authorizationId, 'barge-in');
  assert.equal(reg.canStart(auth3.authorizationId), false);
  assert.equal(reg.get(auth3.authorizationId).revokedReason, 'barge-in');
});

// ── turn manager ───────────────────────────────────────────────────────────────
test('turn manager supersedes the previous turn and discards its late results', () => {
  const tm = createTurnManager();
  const t1 = tm.beginTurn({ source: 'direct', sourceId: 'a' });
  tm.transition(TURN_STATE.THINKING);
  const t2 = tm.beginTurn({ source: 'direct', sourceId: 'b' }); // supersedes t1
  assert.notEqual(t1.turnId, t2.turnId);
  assert.equal(tm.isCurrent(t1.turnId), false);
  assert.equal(tm.isCurrent(t2.turnId), true);
  assert.equal(t1.agentController.signal.aborted, true); // t1's work was aborted
  tm.discardLate(t1.turnId, 'model');
  assert.equal(tm.lateDiscardedCount(), 1);
});

test('turn manager cancel aborts all controllers and marks interrupted', () => {
  const tm = createTurnManager();
  const t = tm.beginTurn({ source: 'direct', sourceId: 'a' });
  tm.cancel('user stop');
  assert.equal(tm.current().state, TURN_STATE.INTERRUPTED);
  assert.equal(t.ttsController.signal.aborted, true);
});

// ── echo suppression ─────────────────────────────────────────────────────────
test('echo suppressor flags overlapping matching text, preserves different speech', () => {
  let clock = 0;
  const echo = createEchoSuppressor({ now: () => clock });
  echo.playbackStarted({ authorizationId: 'a1', turnId: 't1', spokenText: 'The wrench is in the lower right', at: 100 });
  clock = 200;
  const same = echo.classify({ text: 'the wrench is in the lower right', startedAt: 150, endedAt: 250 }, 260);
  assert.equal(same.isEcho, true);
  const different = echo.classify({ text: 'can you grab me a coffee', startedAt: 150, endedAt: 250 }, 260);
  assert.equal(different.isEcho, false);
});

test('textSimilarity is high for near-identical text and low for unrelated', () => {
  assert.ok(textSimilarity('the wrench is here', 'wrench is the here') > 0.9);
  assert.ok(textSimilarity('hello there friend', 'quantum physics lecture') < 0.2);
});

// ── gap detector ───────────────────────────────────────────────────────────────
test('gap detector resolves "gap" when quiet and "timeout" when speech never stops', async () => {
  const reg = { canStart: () => true };
  const quiet = { isSpeaking: () => false, msSinceVoice: () => 5000, subscribe: () => () => {} };
  const gd = createGapDetector({ voiceActivity: quiet, registry: reg, minGapMs: 100, maxWaitMs: 500, pollMs: 20 });
  const clear = await gd.waitForGap({ authorizationId: 'a', expiresAt: Date.now() + 10000 });
  assert.equal(clear.outcome, 'gap');

  const busy = { isSpeaking: () => true, msSinceVoice: () => 0, subscribe: () => () => {} };
  const gd2 = createGapDetector({ voiceActivity: busy, registry: reg, minGapMs: 100, maxWaitMs: 150, pollMs: 20 });
  const timed = await gd2.waitForGap({ authorizationId: 'a', expiresAt: Date.now() + 10000 });
  assert.equal(timed.outcome, 'timeout');
});

test('gap detector abandons an invalidated suggestion while waiting', async () => {
  const reg = { canStart: () => true };
  const busy = { isSpeaking: () => true, msSinceVoice: () => 0 };
  const gd = createGapDetector({ voiceActivity: busy, registry: reg, minGapMs: 100, maxWaitMs: 1000, pollMs: 20 });
  let valid = true;
  setTimeout(() => { valid = false; }, 40);
  const r = await gd.waitForGap({ authorizationId: 'a', expiresAt: Date.now() + 10000 }, { isStillValid: () => valid });
  assert.equal(r.outcome, 'invalidated');
});

// ── TTS providers ──────────────────────────────────────────────────────────────
test('mock TTS returns audio bytes and honors abort', async () => {
  const tts = createMockTtsProvider({ latencyMs: 20 });
  const out = await tts.synthesize({ text: 'hello world' });
  assert.ok(out.audio.byteLength > 0);
  assert.equal(out.provider, 'mock-tts');

  const controller = new AbortController();
  const p = tts.synthesize({ text: 'hello world', signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (e) => e instanceof TtsProviderError && e.code === 'timeout');
});

test('TTS providers reject empty and over-long text without calling out', async () => {
  const tts = createMockTtsProvider();
  await assert.rejects(tts.synthesize({ text: '' }), (e) => e.code === 'invalid_request');
  await assert.rejects(tts.synthesize({ text: 'x'.repeat(MAX_TTS_CHARS + 1) }), (e) => e.code === 'invalid_request');
});

test('groq TTS builds the /audio/speech request and maps status codes to typed errors', async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  const tts = createGroqTtsProvider({ apiKey: 'k', model: 'playai-tts', voice: 'Fritz-PlayAI', fetchImpl: okFetch });
  const out = await tts.synthesize({ text: 'hi there' });
  assert.match(calls[0].url, /\/audio\/speech$/);
  assert.equal(JSON.parse(calls[0].init.body).input, 'hi there');
  assert.ok(!calls[0].init.headers.Authorization.includes('undefined'));
  assert.equal(out.byteLength, 4);

  const authFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
  const tts2 = createGroqTtsProvider({ apiKey: 'k', fetchImpl: authFetch });
  await assert.rejects(tts2.synthesize({ text: 'hi' }), (e) => e instanceof TtsProviderError && e.code === 'auth');
});

test('groq TTS retries a transient failure exactly once', async () => {
  let n = 0;
  const flakyFetch = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 503, json: async () => ({ error: { message: 'busy' } }) };
    return { ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => new Uint8Array([9]).buffer };
  };
  const tts = createGroqTtsProvider({ apiKey: 'k', fetchImpl: flakyFetch });
  const out = await tts.synthesize({ text: 'hi' });
  assert.equal(n, 2);
  assert.equal(out.byteLength, 1);
});

test('deepgram TTS posts to /speak with a Token header and maps auth errors', async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const tts = createDeepgramTtsProvider({ apiKey: 'dk', model: 'aura-2-thalia-en', fetchImpl: okFetch });
  const out = await tts.synthesize({ text: 'hi there' });
  assert.match(calls[0].url, /\/speak\?model=aura-2-thalia-en/);
  assert.match(calls[0].init.headers.Authorization, /^Token /);
  assert.equal(JSON.parse(calls[0].init.body).text, 'hi there');
  assert.equal(out.provider, 'deepgram-tts');
  assert.equal(out.contentType, 'audio/mpeg');

  const authFetch = async () => ({ ok: false, status: 401, json: async () => ({ err_msg: 'bad key' }) });
  const tts2 = createDeepgramTtsProvider({ apiKey: 'dk', fetchImpl: authFetch });
  await assert.rejects(tts2.synthesize({ text: 'hi' }), (e) => e instanceof TtsProviderError && e.code === 'auth');
});

test('createTtsProvider factory selects deepgram/groq/mock by name', () => {
  assert.equal(createTtsProvider({ provider: 'deepgram', apiKey: 'k' }).name, 'deepgram-tts');
  assert.equal(createTtsProvider({ provider: 'groq', apiKey: 'k' }).name, 'groq-tts');
  assert.equal(createTtsProvider({ provider: 'mock' }).name, 'mock-tts');
});

test('proxy TTS decodes base64 audio from the server route', async () => {
  const bytes = new Uint8Array([5, 6, 7, 8]);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ audioBase64: bytesToBase64(bytes), contentType: 'audio/wav', provider: 'groq-tts' }) });
  const tts = createProxyTtsProvider({ fetchImpl });
  const out = await tts.synthesize({ text: 'hi' });
  assert.deepEqual([...out.audio], [...bytes]);
});

test('base64 round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 128, 42]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});
