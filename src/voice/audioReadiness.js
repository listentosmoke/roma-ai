// Explicit browser-audio-readiness tracking. Playback of a gate-approved
// response can still be silently blocked by browser autoplay policy; this
// module makes that state OBSERVABLE and RECOVERABLE instead of a silent
// failure, without touching playbackController.js's contract.
//
// States: locked (never attempted) -> ready | blocked -> error (no audio API).
// `unlock()` is meant to be called directly inside a user gesture (the Start
// click) so a real HTMLAudioElement.play() has a chance to succeed; it plays a
// tiny silent clip and immediately pauses it — the standard unlock technique.
// It does not loop or retry unprompted; the caller decides when to retry
// (typically via a single "Enable Audio" button after a block).

export const AUDIO_READY_STATE = { LOCKED: 'locked', READY: 'ready', BLOCKED: 'blocked', ERROR: 'error' };

// A minimal valid silent WAV (44-byte header, 0 data frames is invalid in some
// engines, so include a handful of zero samples) — no network fetch required.
const SILENT_WAV_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function defaultAudioFactory() {
  if (typeof Audio === 'undefined') return null;
  return new Audio(`data:audio/wav;base64,${SILENT_WAV_BASE64}`);
}

/**
 * @param {{ audioFactory?: () => ({ play: () => Promise<void>, pause: () => void, currentTime: number } | null) }} [deps]
 */
export function createAudioReadiness({ audioFactory = defaultAudioFactory } = {}) {
  let state = AUDIO_READY_STATE.LOCKED;
  const listeners = new Set();

  function setState(next) {
    if (state === next) return state;
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /** Attempt to unlock playback. Call from within a user-gesture handler. */
    async unlock() {
      let element;
      try {
        element = audioFactory();
      } catch {
        return setState(AUDIO_READY_STATE.ERROR);
      }
      if (!element) return setState(AUDIO_READY_STATE.ERROR);

      try {
        await element.play();
        try { element.pause(); element.currentTime = 0; } catch { /* noop */ }
        return setState(AUDIO_READY_STATE.READY);
      } catch {
        return setState(AUDIO_READY_STATE.BLOCKED);
      }
    },

    /** Called when a real playback attempt reports an autoplay rejection. */
    markBlocked() { return setState(AUDIO_READY_STATE.BLOCKED); },
    /** Called when a real playback attempt actually starts (proof it works). */
    markReady() { return setState(AUDIO_READY_STATE.READY); },
    reset() { return setState(AUDIO_READY_STATE.LOCKED); },
  };
}
