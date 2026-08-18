// Turn Manager — the single owner of interaction-turn state. Turn state must NOT
// be scattered across React components, the audio engine, and the agent runtime;
// it lives here. It tracks the current turn's identity, its speech
// authorization, the AbortControllers for agent / tool / TTS work, playback
// timing, cancellation reasons, and how many late results were discarded.
//
// The core guarantee callers rely on: every async result carries its turnId, and
// `isCurrent(turnId)` says whether that result still belongs to the active turn.
// A superseded or cancelled turn's late results are dropped and counted.

export const TURN_STATE = {
  LISTENING: 'listening',
  TRANSCRIPT_PENDING: 'transcript_pending',
  THINKING: 'thinking',
  TOOL_RUNNING: 'tool_running',
  WAITING_FOR_GAP: 'waiting_for_gap',
  SYNTHESIZING: 'synthesizing',
  READY_TO_PLAY: 'ready_to_play',
  SPEAKING: 'speaking',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
  ERROR: 'error',
};

const TERMINAL = new Set([TURN_STATE.COMPLETED, TURN_STATE.INTERRUPTED, TURN_STATE.ERROR]);

export function createTurnManager({ now = Date.now, AbortControllerImpl = globalThis.AbortController } = {}) {
  const listeners = new Set();
  let counter = 0;
  let current = null;
  let someoneElseSpeaking = false;
  let lateDiscarded = 0;

  function emit(event) {
    for (const listener of listeners) listener({ at: now(), ...event });
  }

  function newController() {
    return AbortControllerImpl ? new AbortControllerImpl() : { signal: undefined, abort() {} };
  }

  function abortControllers(turn, reason) {
    for (const key of ['agentController', 'toolController', 'ttsController']) {
      try { turn[key]?.abort?.(reason); } catch { /* noop */ }
    }
    try { turn.playback?.stop?.(reason); } catch { /* noop */ }
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /**
     * Begin a new interaction turn. Any active, non-terminal turn is superseded
     * (its controllers aborted, its authorization left for the caller to revoke).
     * @param {{ source?: string, sourceId?: string|number, speaker?: string, transcriptIds?: Array }} [meta]
     */
    beginTurn(meta = {}) {
      if (current && !TERMINAL.has(current.state)) {
        this.cancel('superseded by a newer turn');
      }
      counter += 1;
      current = {
        turnId: `turn_${counter}`,
        seq: counter,
        state: TURN_STATE.TRANSCRIPT_PENDING,
        source: meta.source ?? 'direct',
        sourceId: meta.sourceId ?? null,
        speaker: meta.speaker ?? null,
        transcriptIds: meta.transcriptIds ?? [],
        authorizationId: null,
        authorizationExpiresAt: null,
        agentController: newController(),
        toolController: newController(),
        ttsController: newController(),
        playback: null,
        startedAt: now(),
        speechStartedAt: null,
        speechEndedAt: null,
        cancellationReason: null,
        lateResultDiscarded: false,
      };
      emit({ type: 'turn-started', turnId: current.turnId, source: current.source, sourceId: current.sourceId });
      return { ...current };
    },

    /** Transition the current turn's state. */
    transition(state, extra = {}) {
      if (!current) return null;
      current.state = state;
      if (state === TURN_STATE.SPEAKING && !current.speechStartedAt) current.speechStartedAt = now();
      if (TERMINAL.has(state) && current.speechStartedAt && !current.speechEndedAt) current.speechEndedAt = now();
      emit({ type: 'turn-state', turnId: current.turnId, state, ...extra });
      return { ...current };
    },

    attachAuthorization(authorization) {
      if (!current) return null;
      current.authorizationId = authorization.authorizationId;
      current.authorizationExpiresAt = authorization.expiresAt;
      current.interruptible = authorization.interruptible;
      emit({ type: 'authorization-attached', turnId: current.turnId, authorizationId: authorization.authorizationId });
      return { ...current };
    },

    attachPlayback(playback) { if (current) current.playback = playback; },
    controllers: () => (current ? { agent: current.agentController, tool: current.toolController, tts: current.ttsController } : null),

    /** Cancel the active turn — aborts its controllers + playback, marks it. */
    cancel(reason = 'cancelled') {
      if (!current || TERMINAL.has(current.state)) return null;
      current.cancellationReason = reason;
      abortControllers(current, reason);
      current.state = TURN_STATE.INTERRUPTED;
      if (current.speechStartedAt && !current.speechEndedAt) current.speechEndedAt = now();
      emit({ type: 'turn-cancelled', turnId: current.turnId, reason, authorizationId: current.authorizationId });
      return { ...current };
    },

    complete() {
      if (!current) return null;
      current.state = TURN_STATE.COMPLETED;
      if (current.speechStartedAt && !current.speechEndedAt) current.speechEndedAt = now();
      emit({ type: 'turn-completed', turnId: current.turnId });
      return { ...current };
    },

    fail(message) {
      if (!current) return null;
      current.state = TURN_STATE.ERROR;
      current.cancellationReason = message;
      emit({ type: 'turn-error', turnId: current.turnId, message });
      return { ...current };
    },

    /** Whether a result tagged with `turnId` still belongs to the active turn. */
    isCurrent(turnId) {
      return Boolean(current) && current.turnId === turnId && !TERMINAL.has(current.state);
    },

    /** Record (and count) a late result from a superseded/cancelled turn. */
    discardLate(turnId, kind = 'result') {
      lateDiscarded += 1;
      if (current && current.turnId === turnId) current.lateResultDiscarded = true;
      emit({ type: 'late-result-discarded', turnId, kind, totalDiscarded: lateDiscarded });
      return lateDiscarded;
    },

    setSomeoneElseSpeaking(value) { someoneElseSpeaking = Boolean(value); },
    someoneElseSpeaking: () => someoneElseSpeaking,
    lateDiscardedCount: () => lateDiscarded,
    current: () => (current ? { ...current } : null),
    state: () => current?.state ?? TURN_STATE.LISTENING,
    reset() {
      if (current && !TERMINAL.has(current.state)) this.cancel('reset');
      current = null;
    },
  };
}
