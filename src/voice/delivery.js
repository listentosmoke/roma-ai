// Voice delivery — the orchestrator that sits AFTER the deterministic Speech Gate
// and turns an approved speech request into (eventually) audio. It is the single
// guardian between "the gate approved" and "the speaker makes sound":
//
//   gate-approved request
//        → mint authorization (only from an approved gate decision)
//        → Turn Manager begins/attaches a turn
//        → speak_when_convenient? wait for a real conversational gap
//        → prepare + synthesize (TTS)  [abortable]
//        → verify the authorization still valid
//        → playback controller plays exactly one response
//
// No component reaches the TTS provider without a valid authorization from here,
// and a superseded / expired / revoked authorization never plays. Direct
// (prompted) answers take precedence over pending low-priority proactive speech.

import { createAuthorizationRegistry } from './authorization.js';
import { createTurnManager, TURN_STATE } from './turnManager.js';
import { createPlaybackController } from './playbackController.js';
import { createVoiceActivity } from './voiceActivity.js';
import { createGapDetector } from './gapDetector.js';
import { createEchoSuppressor } from './echoSuppressor.js';
import { prepareSpeechText } from './speechPrep.js';
import { isStopPhrase } from './stopPhrases.js';
import { createMockTtsProvider, TtsProviderError } from './ttsProvider.js';
import { voiceConfig, DEFAULT_STOP_PHRASES } from './config.js';

export function createVoiceDelivery({
  ttsProvider = createMockTtsProvider(),
  registry = createAuthorizationRegistry(),
  turnManager = createTurnManager(),
  voiceActivity = createVoiceActivity(),
  echoSuppressor = createEchoSuppressor(),
  playback,
  audioFactory,
  gapDetector,
  now = Date.now,
  voice,
  ttsModel,
  ttsFormat = voiceConfig.tts.format,
  minGapMs = voiceConfig.gap.minGapMs,
  maxWaitMs = voiceConfig.gap.maxWaitMs,
  bargeInMinMs = voiceConfig.bargeInMinMs,
  stopPhrases = DEFAULT_STOP_PHRASES,
  onEvent = () => {},
} = {}) {
  const listeners = new Set();
  const emit = (event) => { const e = { at: now(), ...event }; onEvent(e); for (const l of listeners) l(e); };

  const player = playback ?? createPlaybackController({ registry, audioFactory, now, onEvent: emit });
  const gaps = gapDetector ?? createGapDetector({ voiceActivity, registry, now, minGapMs, maxWaitMs });

  const metrics = {
    approved: 0, denied: 0, expiredBeforePlay: 0, downgradedToVisual: 0,
    ttsRequests: 0, ttsFailures: 0, ttsTimeouts: 0, ttsLatencyTotal: 0,
    gapWaits: 0, gapWaitMsTotal: 0, gapTimeouts: 0,
    bargeIns: 0, bargeInStopMsTotal: 0, stopCommands: 0,
    echoesSuppressed: 0, lateDiscarded: 0, autoplayFailures: 0,
    transcriptToAudioTotal: 0, transcriptToAudioCount: 0,
  };

  // Revoke a turn's authorization whenever the Turn Manager cancels it.
  turnManager.subscribe((event) => {
    if (event.type === 'turn-cancelled' && event.authorizationId) registry.revoke(event.authorizationId, event.reason);
    if (event.type === 'late-result-discarded') metrics.lateDiscarded += 1;
    emit({ type: 'turn-event', ...event });
  });

  function syncRomaSpeaking() {
    const speaking = player.hasPending();
    voiceActivity.setRomaSpeaking(speaking);
  }

  async function runSynthesisAndPlay(authorization, turn, { transcriptAt } = {}) {
    const controllers = turnManager.controllers();
    const signal = controllers?.tts?.signal;

    turnManager.transition(TURN_STATE.SYNTHESIZING);
    metrics.ttsRequests += 1;
    const ttsStart = now();
    // `voice` may be a plain string (static) or a getter (dynamic selection —
    // e.g. a UI voice picker). Resolved once, right before this request starts,
    // so a change made mid-flight never affects an already-scheduled synthesis —
    // only the NEXT authorization sees it.
    const resolvedVoice = typeof voice === 'function' ? voice() : voice;
    emit({ type: 'tts-requested', authorizationId: authorization.authorizationId, turnId: turn.turnId, provider: ttsProvider?.name ?? null, model: ttsModel, voice: resolvedVoice });
    let synth;
    try {
      synth = await ttsProvider.synthesize({
        text: authorization.text, voice: resolvedVoice, model: ttsModel, format: ttsFormat,
        authorizationId: authorization.authorizationId, turnId: turn.turnId, signal,
      });
    } catch (error) {
      const timedOut = error instanceof TtsProviderError && error.code === 'timeout';
      if (timedOut) metrics.ttsTimeouts += 1; else metrics.ttsFailures += 1;
      emit({ type: 'tts-failed', authorizationId: authorization.authorizationId, turnId: turn.turnId, code: error?.code, message: error?.message });
      // Failure/timeout: the text response stays visible; return to listening.
      if (turnManager.isCurrent(turn.turnId)) turnManager.fail(error?.message ?? 'tts failed');
      registry.revoke(authorization.authorizationId, 'tts failed');
      return { outcome: timedOut ? 'timeout' : 'failed' };
    }
    metrics.ttsLatencyTotal += synth.providerLatencyMs ?? 0;

    // A newer turn may have superseded us while synthesizing.
    if (!turnManager.isCurrent(turn.turnId) || !registry.canStart(authorization.authorizationId)) {
      metrics.lateDiscarded += 1;
      turnManager.discardLate(turn.turnId, 'tts');
      return { outcome: 'discarded' };
    }

    turnManager.transition(TURN_STATE.SPEAKING);
    echoSuppressor.playbackStarted({ authorizationId: authorization.authorizationId, turnId: turn.turnId, spokenText: authorization.text, at: now() });
    syncRomaSpeaking();
    const requestedAt = now();
    const playResult = await player.play({
      authorization, audio: synth.audio, contentType: synth.contentType, turnId: turn.turnId, requestedAt,
    });
    echoSuppressor.playbackEnded({ authorizationId: authorization.authorizationId, at: now(), interrupted: playResult.outcome !== 'completed' });
    syncRomaSpeaking();

    if (playResult.outcome === 'blocked' && player.metrics().autoplayFailures > metrics.autoplayFailures) {
      metrics.autoplayFailures = player.metrics().autoplayFailures;
    }
    if (playResult.outcome === 'completed') {
      if (transcriptAt != null) { metrics.transcriptToAudioTotal += Math.max(0, requestedAt - transcriptAt); metrics.transcriptToAudioCount += 1; }
      if (turnManager.isCurrent(turn.turnId)) turnManager.complete();
      emit({ type: 'spoken', authorizationId: authorization.authorizationId, turnId: turn.turnId, text: authorization.text,
        provider: synth.provider, model: synth.model, voice: synth.voice, ttsLatencyMs: synth.providerLatencyMs });
    }
    return { outcome: playResult.outcome, synth };
  }

  /**
   * Schedule an already-authorized speech request. Fire-and-forget; the returned
   * promise resolves with the final outcome for tests/simulation.
   */
  async function scheduleAuthorized(authorization, turn, { isStillValid = () => true, transcriptAt } = {}) {
    if (authorization.delivery === 'speak_when_convenient') {
      turnManager.transition(TURN_STATE.WAITING_FOR_GAP);
      metrics.gapWaits += 1;
      emit({ type: 'awaiting-gap', authorizationId: authorization.authorizationId, turnId: turn.turnId });
      const gap = await gaps.waitForGap(authorization, {
        isStillValid,
        someoneSpeaking: () => voiceActivity.isSpeaking() && !voiceActivity.isRomaSpeaking(),
      });
      metrics.gapWaitMsTotal += gap.waitedMs;
      if (gap.outcome !== 'gap') {
        if (gap.outcome === 'timeout') metrics.gapTimeouts += 1;
        if (gap.outcome === 'expired') metrics.expiredBeforePlay += 1;
        registry.revoke(authorization.authorizationId, `not spoken: ${gap.outcome}`);
        if (turnManager.isCurrent(turn.turnId)) turnManager.fail(`gap ${gap.outcome}`);
        emit({ type: 'speech-discarded', authorizationId: authorization.authorizationId, turnId: turn.turnId, reason: gap.outcome });
        return { outcome: gap.outcome };
      }
    }
    if (!registry.canStart(authorization.authorizationId)) {
      metrics.expiredBeforePlay += 1;
      emit({ type: 'speech-discarded', authorizationId: authorization.authorizationId, turnId: turn.turnId, reason: 'expired' });
      return { outcome: 'expired' };
    }
    return runSynthesisAndPlay(authorization, turn, { transcriptAt });
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    voiceActivity,
    turnManager,
    registry,
    playback: player,
    echoSuppressor,

    /**
     * Consume a gate decision and deliver. Returns synchronously; audio (if any)
     * is scheduled asynchronously. `promise` resolves with the final outcome.
     *
     * @param {{
     *   gateDecision: { approved: boolean, reason?: string },
     *   sourceType: string, sourceId: string, text: string,
     *   delivery?: 'speak_now'|'speak_when_convenient', priority?: string,
     *   turnId?: string|number, interruptible?: boolean, unprompted?: boolean,
     *   lifetimeMs?: number, maxChars?: number, transcriptAt?: number,
     *   isStillValid?: () => boolean, speaker?: string,
     * }} req
     */
    authorizeAndDeliver(req) {
      if (!req.gateDecision?.approved) {
        metrics.denied += 1;
        emit({ type: 'speech-denied', sourceId: req.sourceId, reason: req.gateDecision?.reason ?? 'not approved' });
        return { approved: false, reason: req.gateDecision?.reason ?? 'not approved', promise: Promise.resolve({ outcome: 'denied' }) };
      }
      // Prepare the spoken form BEFORE minting — empty/structured text is not spoken.
      const prep = prepareSpeechText(req.text, { maxLength: req.maxChars ?? voiceConfig.maxSpeechChars });
      if (!prep.ok) {
        emit({ type: 'speech-unsynthesizable', sourceId: req.sourceId, reason: prep.reason });
        return { approved: true, synthesizable: false, reason: prep.reason, promise: Promise.resolve({ outcome: 'unsynthesizable' }) };
      }

      const isDirect = req.unprompted === false || req.sourceType === 'direct_response';
      const lifetimeMs = req.lifetimeMs ?? (req.delivery === 'speak_when_convenient' ? voiceConfig.convenientAuthorizationMs : voiceConfig.directAuthorizationMs);
      const authorization = registry.mint(req.gateDecision, {
        sourceType: req.sourceType, sourceId: req.sourceId, text: prep.text,
        delivery: req.delivery ?? 'speak_now', priority: req.priority ?? (isDirect ? 'normal' : 'low'),
        turnId: null, interruptible: req.interruptible ?? true, unprompted: req.unprompted ?? !isDirect, lifetimeMs,
      });
      metrics.approved += 1;

      // Direct answers supersede any pending low-priority proactive speech.
      const turn = turnManager.beginTurn({ source: req.sourceType, sourceId: req.sourceId, speaker: req.speaker });
      turnManager.attachAuthorization(authorization);
      turnManager.attachPlayback(player);
      emit({ type: 'authorized', authorizationId: authorization.authorizationId, turnId: turn.turnId, sourceType: req.sourceType,
        delivery: authorization.delivery, unprompted: authorization.unprompted, text: prep.text, policyReason: authorization.policyReason });

      const promise = scheduleAuthorized(authorization, turn, { isStillValid: req.isStillValid, transcriptAt: req.transcriptAt })
        .catch((error) => { emit({ type: 'delivery-error', message: error?.message ?? String(error) }); return { outcome: 'error' }; });
      return { approved: true, synthesizable: true, authorizationId: authorization.authorizationId, turnId: turn.turnId, promise };
    },

    /**
     * Handle an incoming user utterance/level while Roma may be speaking. Returns
     * how it was treated so the caller can decide whether to forward it onward.
     * @param {{ text?: string, durationMs?: number, at?: number, speaker?: string, startedAt?: number, endedAt?: number }} utterance
     */
    handleUserSpeech(utterance = {}) {
      const at = utterance.at ?? now();
      // 1. Deterministic stop phrase — cancel immediately, no LLM.
      if (utterance.text && isStopPhrase(utterance.text, stopPhrases)) {
        metrics.stopCommands += 1;
        const stopped = this.stopAll('user said stop');
        emit({ type: 'stop-command', text: utterance.text, stopped });
        return { stopCommand: true, stopped, forward: true };
      }
      // 2. Echo of Roma's own playback — suppress before it reaches agent/engine.
      const echo = echoSuppressor.classify({ text: utterance.text ?? '', startedAt: utterance.startedAt ?? at, endedAt: utterance.endedAt ?? at }, at);
      if (echo.isEcho) {
        metrics.echoesSuppressed += 1;
        emit({ type: 'echo-suppressed', text: utterance.text, similarity: echo.similarity, authorizationId: echo.authorizationId });
        return { echo: true, forward: false };
      }
      // 3. Genuine user speech during playback of sufficient duration → barge-in.
      const bargeInAllowed = utterance.bargeInEnabled !== false;
      if (bargeInAllowed && player.isPlaying() && (utterance.durationMs ?? 0) >= bargeInMinMs) {
        const stopStart = now();
        const stopped = this.stopAll('user barge-in');
        const stopMs = now() - stopStart;
        metrics.bargeIns += 1;
        metrics.bargeInStopMsTotal += stopMs;
        emit({ type: 'barge-in', text: utterance.text, stopMs, stopped });
        return { bargeIn: true, stopped, forward: true };
      }
      return { forward: true };
    },

    /** Feed a finalized transcript segment; returns whether it is Roma's echo. */
    classifyTranscript(segment) {
      const result = echoSuppressor.classify(segment, now());
      if (result.isEcho) { metrics.echoesSuppressed += 1; emit({ type: 'echo-suppressed', text: segment.text, similarity: result.similarity }); }
      return result;
    },

    /** Deterministic stop: revoke all authorizations, stop playback, return to listening. */
    stopAll(reason = 'stopped') {
      const stopped = player.stop(reason);
      registry.revokeAll(reason);
      turnManager.cancel(reason);
      syncRomaSpeaking();
      emit({ type: 'stopped-all', reason, stoppedPlayback: stopped });
      return stopped;
    },

    /** "Clear pending speech" — drop anything not yet playing without stopping current. */
    clearPending(reason = 'cleared') {
      if (!player.isPlaying()) return this.stopAll(reason);
      return false;
    },

    /** UI "Test TTS": synthesize + play one short phrase through the normal path. */
    async testTts(text = 'Roma voice check. One two three.') {
      const result = this.authorizeAndDeliver({
        gateDecision: { approved: true, reason: 'manual TTS test' },
        sourceType: 'test', sourceId: `test_${now()}`, text, delivery: 'speak_now', unprompted: false,
      });
      return result.promise.then((outcome) => ({ ...outcome, authorizationId: result.authorizationId }));
    },

    metrics() {
      return {
        ...metrics,
        avgTtsLatencyMs: metrics.ttsRequests ? +(metrics.ttsLatencyTotal / metrics.ttsRequests).toFixed(1) : 0,
        avgGapWaitMs: metrics.gapWaits ? +(metrics.gapWaitMsTotal / metrics.gapWaits).toFixed(1) : 0,
        avgBargeInStopMs: metrics.bargeIns ? +(metrics.bargeInStopMsTotal / metrics.bargeIns).toFixed(1) : 0,
        avgTranscriptToAudioMs: metrics.transcriptToAudioCount ? +(metrics.transcriptToAudioTotal / metrics.transcriptToAudioCount).toFixed(1) : 0,
        playback: player.metrics(),
        turnState: turnManager.state(),
      };
    },

    dispose() { this.stopAll('disposed'); voiceActivity.dispose?.(); },
  };
}
