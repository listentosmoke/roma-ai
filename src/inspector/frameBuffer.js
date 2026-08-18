// Rolling video-frame buffer: recent visual history, addressable by timestamp.
// Frames are opaque payloads (canvas dataURLs in the browser, plain objects in
// the Node simulation) stamped with the shared epoch-ms clock, so a frame can be
// looked up for any transcript timestamp and handed to the deep-analysis model.
//
// Foundation only: rewind/forward/nearest lookup + pinned keyframes. Long-term
// visual-memory search over this history is a documented future layer.

export function createFrameBuffer({ maxDurationMs = 30000, maxFrames = 240, maxKeyframes = 20 } = {}) {
  const frames = []; // [{ at, frame }] ascending by time
  const keyframes = []; // [{ at, reason, frame }] pinned, survive the rolling window

  function evict(nowMs) {
    while (frames.length > maxFrames || (frames.length && nowMs - frames[0].at > maxDurationMs)) {
      frames.shift();
    }
  }

  return {
    push(frame, at) {
      frames.push({ at, frame });
      evict(at);
    },

    latest() {
      return frames.at(-1) ?? null;
    },

    /** Nearest frame to a timestamp (rewind or forward), or null if outside the buffer. */
    frameAt(at) {
      if (!frames.length) return null;
      let best = frames[0];
      for (const entry of frames) {
        if (Math.abs(entry.at - at) < Math.abs(best.at - at)) best = entry;
      }
      return best;
    },

    /** All buffered frames within [fromMs, toMs] — e.g. the span of a transcript segment. */
    range(fromMs, toMs) {
      return frames.filter((entry) => entry.at >= fromMs && entry.at <= toMs);
    },

    /** Pin the frame nearest `at` as a keyframe so it outlives the rolling window. */
    saveKeyframe(at, reason) {
      const entry = this.frameAt(at);
      if (!entry) return null;
      const keyframe = { at: entry.at, reason, frame: entry.frame };
      keyframes.push(keyframe);
      if (keyframes.length > maxKeyframes) keyframes.shift();
      return keyframe;
    },

    keyframes: () => [...keyframes],
    size: () => frames.length,
  };
}
