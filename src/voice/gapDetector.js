// Conversational-gap detection for `speak_when_convenient`. Approved coaching is
// NOT played immediately — it waits for a real opening in the conversation. This
// is deliberately more than a fixed timer: it consults live voice activity, a
// "someone has an unfinished turn" signal, the authorization's own expiry, and a
// still-useful check so a stale suggestion is dropped rather than forced in.
//
//   waitForGap(authorization, { isStillValid }) ->
//     Promise<{ outcome: 'gap'|'expired'|'invalidated'|'timeout', waitedMs }>
//
// Only `outcome === 'gap'` should proceed to synthesis.

/**
 * @param {{
 *   voiceActivity: { isSpeaking: Function, msSinceVoice: Function, subscribe: Function },
 *   registry: { canStart: Function },
 *   now?: () => number,
 *   minGapMs?: number,
 *   maxWaitMs?: number,
 *   pollMs?: number,
 * }} deps
 */
export function createGapDetector({
  voiceActivity,
  registry,
  now = Date.now,
  minGapMs = 700,
  maxWaitMs = 5000,
  pollMs = 100,
}) {
  /**
   * @param {{ authorizationId: string, expiresAt: number }} authorization
   * @param {{ isStillValid?: () => boolean, someoneSpeaking?: () => boolean }} [hooks]
   */
  function waitForGap(authorization, { isStillValid = () => true, someoneSpeaking = () => false } = {}) {
    const startedAt = now();
    return new Promise((resolve) => {
      let timer = null;
      const finish = (outcome) => {
        if (timer) clearTimeout(timer);
        resolve({ outcome, waitedMs: now() - startedAt });
      };

      const check = () => {
        const at = now();
        // Authorization no longer allowed to start (expired / revoked / consumed).
        if (!registry.canStart(authorization.authorizationId, at)) { finish('expired'); return; }
        if (at >= authorization.expiresAt) { finish('expired'); return; }
        // The related suggestion was invalidated / the conversation moved on.
        if (!isStillValid()) { finish('invalidated'); return; }
        // Hard time budget: don't force stale coaching into the conversation.
        if (at - startedAt >= maxWaitMs) { finish('timeout'); return; }

        const quietFor = voiceActivity.msSinceVoice(at);
        const clear = !voiceActivity.isSpeaking() && !someoneSpeaking() && quietFor >= minGapMs;
        if (clear) { finish('gap'); return; }

        timer = setTimeout(check, pollMs);
      };

      check();
    });
  }

  return { waitForGap };
}
