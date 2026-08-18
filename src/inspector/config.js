// ─────────────────────────────────────────────────────────────────────────────
// Inspector configuration — kept separate from engine/config.js so the audio
// engine and the visual Inspector stay decoupled (either is replaceable without
// touching the other).
// ─────────────────────────────────────────────────────────────────────────────

export const inspectorConfig = {
  // 'coco-ssd' (real, in-browser, loaded from CDN) or 'mock' (scripted frames).
  detector: 'coco-ssd',
  // Fast-path cadence. 250 ms ≈ 4 fps keeps scene state fresh enough for live
  // physical interaction while leaving headroom on modest hardware.
  intervalMs: 250,
  // Drop raw detections below this confidence before tracking.
  minDetectionConfidence: 0.35,
  // Camera capture size (frames are analyzed at this resolution).
  video: { width: 640, height: 480, facingMode: 'environment' },
  // Rolling frame buffer: recent visual history for rewind + deep analysis.
  buffer: { maxDurationMs: 30000, maxFrames: 120, bufferEveryNth: 2 },
  // Deep analysis: agent-requested frames go to the real vision model (via the
  // server's /api/vision/analyze route); the continuous escalation loop stays
  // on the free local stub so no frame is sent remotely without a request.
  deepAnalysis: {
    enabled: true,
    minConfidence: 0.55,
    cooldownMs: 12000,
    // Vision analyzer knobs: duplicate-request cache TTL and the cap on
    // simultaneous remote analyses.
    vision: { cacheTtlMs: 30000, maxConcurrent: 2 },
  },
  // Event promotion: dedup window for notable changes.
  eventCooldownMs: 8000,
};
