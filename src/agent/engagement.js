// Deterministic conversation-engagement tracker. The MODEL keeps sole authority
// over whether a given turn is a request (ignore/respond/clarify); this tracker
// only decides whether the CONTEXT handed to the model should say "you are in an
// active interaction" so the user doesn't have to repeat "Roma" on every
// follow-up. It never overrides ignore into respond, and never forces respond —
// it only removes the wake-word requirement for a bounded window after Roma last
// engaged, with a clear, testable entry/continuation/timeout/exit contract.
//
//   entry:        the model decided respond/clarify/update_task (Roma engaged)
//   continuation: isActive() stays true for engagementTimeoutMs after entry
//   timeout:      isActive() naturally returns false once the window elapses
//   exit:         an explicit call (e.g. a deterministic stop phrase) ends it now

const DEFAULT_TIMEOUT_MS = 20000;

export function createEngagementTracker({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  let engagedAt = 0;
  let active = false;
  let lastTurnId = null;
  let lastExitReason = null;

  return {
    /** True while inside the active-interaction window (entry + continuation). */
    isActive(at = now()) {
      if (!active) return false;
      return at - engagedAt < timeoutMs;
    },

    remainingMs(at = now()) {
      if (!this.isActive(at)) return 0;
      return Math.max(0, timeoutMs - (at - engagedAt));
    },

    /** Entry/continuation: call when the model engaged (respond/clarify/update_task). */
    markEngaged(turnId, at = now()) {
      active = true;
      engagedAt = at;
      lastTurnId = turnId;
      lastExitReason = null;
    },

    /** Exit: deterministic, immediate — e.g. a stop phrase or explicit end-of-topic. */
    markExited(reason = 'exited') {
      active = false;
      lastExitReason = reason;
    },

    state(at = now()) {
      return {
        active: this.isActive(at),
        remainingMs: this.remainingMs(at),
        lastTurnId,
        lastExitReason,
        timeoutMs,
      };
    },
  };
}
