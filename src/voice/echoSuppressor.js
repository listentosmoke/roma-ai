// Self-transcription / echo suppression. Roma must not treat its own spoken
// output — picked up by the microphone — as new user speech. We do NOT attempt
// acoustic echo-cancellation DSP (the mic already requests browser
// echoCancellation); instead we combine cheap, robust signals:
//
//   1. timing overlap: does the transcript segment fall inside a playback window?
//   2. text similarity: does it match what Roma just said?
//   3. (optional) speaker label continuity
//
// A segment that overlaps playback AND is textually similar is marked as echo
// and suppressed before it reaches the reactive agent and Opportunity Engine.
// Genuinely different speech during playback is preserved (that is a barge-in,
// handled elsewhere).

function normalizeTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Jaccard token overlap — simple, order-insensitive, good enough for echo.
export function textSimilarity(a, b) {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * @param {{ now?: () => number, similarityThreshold?: number, tailMs?: number }} [options]
 * @param options.tailMs grace window after playback ends (echo can lag slightly).
 */
export function createEchoSuppressor({ now = Date.now, similarityThreshold = 0.5, tailMs = 600 } = {}) {
  const windows = []; // { authorizationId, turnId, spokenText, startedAt, endedAt|null, interruptedAt|null }

  function prune(at) {
    while (windows.length > 12 || (windows[0] && windows[0].endedAt && at - windows[0].endedAt > 10000)) windows.shift();
  }

  return {
    /** Record that playback of `spokenText` started. */
    playbackStarted({ authorizationId, turnId, spokenText, at = now() }) {
      windows.push({ authorizationId, turnId, spokenText, startedAt: at, endedAt: null, interruptedAt: null });
      prune(at);
    },

    playbackEnded({ authorizationId, at = now(), interrupted = false } = {}) {
      const window = [...windows].reverse().find((w) => w.authorizationId === authorizationId && !w.endedAt);
      if (window) { window.endedAt = at; if (interrupted) window.interruptedAt = at; }
    },

    /**
     * Decide whether a transcript segment is Roma's own echo.
     * @param {{ text: string, startedAt?: number, endedAt?: number }} segment
     * @returns {{ isEcho: boolean, reason?: string, similarity?: number, authorizationId?: string }}
     */
    classify(segment, at = now()) {
      const segStart = segment.startedAt ?? at;
      const segEnd = segment.endedAt ?? segStart;
      for (const window of windows) {
        const windowEnd = (window.endedAt ?? at) + tailMs;
        const overlaps = segStart <= windowEnd && segEnd >= window.startedAt;
        if (!overlaps) continue;
        const similarity = textSimilarity(segment.text, window.spokenText);
        if (similarity >= similarityThreshold) {
          return { isEcho: true, reason: 'overlaps Roma playback and text matches', similarity, authorizationId: window.authorizationId };
        }
      }
      return { isEcho: false };
    },

    /** Currently-open (playing) window, if any. */
    activeWindow(at = now()) {
      return [...windows].reverse().find((w) => !w.endedAt || at - w.endedAt <= tailMs) ?? null;
    },

    windows: () => windows.map((w) => ({ ...w })),
  };
}
