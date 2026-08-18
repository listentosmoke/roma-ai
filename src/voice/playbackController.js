// Playback controller — the single place that turns synthesized audio bytes into
// sound. Raw HTMLAudioElement logic lives here, never inside React panels. It:
//  - plays exactly ONE response at a time (a newer one stops the current),
//  - refuses audio whose authorization is expired / revoked / superseded,
//  - emits started / completed / stopped / blocked / failed events with turn +
//    authorization ids,
//  - measures playback-start latency,
//  - releases object URLs and audio resources,
//  - handles browser autoplay restrictions without freezing.
//
// The actual audio sink is injected (`audioFactory`) so this is fully testable in
// Node with a fake element; the default builds a browser HTMLAudioElement.

function browserAudioFactory({ audio, contentType }) {
  const blob = new Blob([audio], { type: contentType || 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  // Virtual-hardware lab tap (see src/simulation/index.js): in a DEV
  // simulation session the lab OBSERVES the real decoded playback element so
  // it can mix Roma's actual output back into the virtual microphone as
  // controlled echo. Observation only — playback, authorization, and every
  // decision stay exactly as below. `import.meta.env.DEV` makes this line
  // dead code in production builds (verified by the simulation security test).
  if (import.meta.env.DEV && typeof window !== 'undefined' && typeof window.__romaSimulationPlaybackTap === 'function') {
    try { window.__romaSimulationPlaybackTap(el); } catch { /* tap must never break playback */ }
  }
  return {
    play: () => el.play(),
    pause: () => { try { el.pause(); } catch { /* noop */ } },
    set onended(fn) { el.onended = fn; },
    set onerror(fn) { el.onerror = fn; },
    get durationMs() { return Number.isFinite(el.duration) ? el.duration * 1000 : null; },
    release: () => { try { el.pause(); el.src = ''; } catch { /* noop */ } URL.revokeObjectURL(url); },
  };
}

/**
 * @param {{
 *   registry: { canStart: Function, markPlaying: Function, consume: Function, revoke: Function },
 *   audioFactory?: Function,
 *   now?: () => number,
 *   onEvent?: (event: object) => void,
 * }} deps
 */
export function createPlaybackController({ registry, audioFactory = browserAudioFactory, now = Date.now, onEvent = () => {} } = {}) {
  let active = null; // { authorizationId, turnId, element, startedAt }
  const metrics = { started: 0, completed: 0, stopped: 0, blocked: 0, failed: 0, autoplayFailures: 0, startLatencyTotal: 0 };

  function emit(event) { onEvent({ at: now(), ...event }); }

  function releaseActive() {
    if (!active) return;
    try { active.element.release(); } catch { /* noop */ }
    active = null;
  }

  return {
    /**
     * @param {{
     *   authorization: { authorizationId: string, turnId?: string|number },
     *   audio: Uint8Array, contentType?: string, turnId?: string|number,
     *   requestedAt?: number,
     * }} request
     * @returns {Promise<{ outcome: 'completed'|'blocked'|'stopped'|'failed', startLatencyMs?: number }>}
     */
    async play({ authorization, audio, contentType, turnId, requestedAt }) {
      const authId = authorization.authorizationId;
      const at = now();
      // Reject audio for an authorization that can no longer start.
      if (!registry.canStart(authId, at)) {
        metrics.blocked += 1;
        emit({ type: 'playback-blocked', authorizationId: authId, turnId, reason: 'authorization expired, revoked, or superseded' });
        return { outcome: 'blocked' };
      }
      // Only one at a time: stop whatever is playing (older, not-yet-finished).
      if (active) this.stop('replaced by a newer response');

      let element;
      try {
        element = audioFactory({ audio, contentType });
      } catch (error) {
        metrics.failed += 1;
        emit({ type: 'playback-failed', authorizationId: authId, turnId, message: error?.message ?? String(error) });
        return { outcome: 'failed' };
      }

      active = { authorizationId: authId, turnId, element, startedAt: null };
      registry.markPlaying(authId);

      return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

        element.onended = () => {
          if (!active || active.authorizationId !== authId) return;
          metrics.completed += 1;
          registry.consume(authId);
          emit({ type: 'playback-completed', authorizationId: authId, turnId });
          releaseActive();
          settle({ outcome: 'completed' });
        };
        element.onerror = () => {
          // release() clears the element's src, which itself fires a delayed
          // 'error' event on some browsers — a real outcome (completed/stopped)
          // already cleared `active` by then, so this guard (matching onended's)
          // stops that post-release error from being reported as a failure.
          if (!active || active.authorizationId !== authId) return;
          metrics.failed += 1;
          emit({ type: 'playback-failed', authorizationId: authId, turnId, message: 'audio element error' });
          releaseActive();
          settle({ outcome: 'failed' });
        };
        // Expose a stop hook the Turn Manager can call.
        active.stop = (reason) => {
          if (!active || active.authorizationId !== authId) return;
          metrics.stopped += 1;
          registry.revoke(authId, reason ?? 'stopped');
          emit({ type: 'playback-stopped', authorizationId: authId, turnId, reason: reason ?? 'stopped' });
          releaseActive();
          settle({ outcome: 'stopped' });
        };
        active._settleReplaced = () => settle({ outcome: 'stopped' });

        Promise.resolve()
          .then(() => element.play())
          .then(() => {
            if (!active || active.authorizationId !== authId) return;
            const started = now();
            active.startedAt = started;
            metrics.started += 1;
            const startLatencyMs = requestedAt != null ? Math.max(0, started - requestedAt) : null;
            if (startLatencyMs != null) metrics.startLatencyTotal += startLatencyMs;
            emit({ type: 'playback-started', authorizationId: authId, turnId, startLatencyMs, durationMs: element.durationMs });
          })
          .catch((error) => {
            // Autoplay policy rejection (or any play() failure) — never freeze.
            metrics.blocked += 1;
            metrics.autoplayFailures += 1;
            registry.revoke(authId, 'autoplay blocked');
            emit({ type: 'playback-blocked', authorizationId: authId, turnId, reason: 'autoplay blocked by the browser', message: error?.message });
            releaseActive();
            settle({ outcome: 'blocked' });
          });
      });
    },

    /** Immediate stop of the current response (barge-in / stop command / replace). */
    stop(reason = 'stopped') {
      if (!active) return false;
      if (active.stop) active.stop(reason);
      else { releaseActive(); }
      return true;
    },

    isPlaying: () => Boolean(active && active.startedAt),
    hasPending: () => Boolean(active),
    activeAuthorizationId: () => active?.authorizationId ?? null,
    metrics: () => ({ ...metrics, avgStartLatencyMs: metrics.started ? +(metrics.startLatencyTotal / metrics.started).toFixed(1) : 0 }),
    dispose() { this.stop('disposed'); },
  };
}
