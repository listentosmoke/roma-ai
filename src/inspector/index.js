// Inspector factory — mirrors engine/index.js. Builds the full fast-path stack
// (store, buffer, detector, faces, deep analyzer, orchestrator) from config with
// per-piece overrides, so the browser hook and the Node simulation assemble the
// SAME pipeline from the same parts.

import { inspectorConfig } from './config.js';
import { createSceneStore } from './sceneStore.js';
import { createFrameBuffer } from './frameBuffer.js';
import { createDetector } from './detector.js';
import { createFaceRecognizer } from './faces.js';
import { createDeepAnalyzer, stubAnalyze } from './deepAnalysis.js';
import { createInspector } from './inspector.js';
import { createVisionAnalyzer, createVisionAnalyze } from '../vision/analyzer.js';
import { createProxyVisionProvider } from '../vision/provider.js';

export { inspectorConfig };
export { createSceneStore } from './sceneStore.js';
export { createFrameBuffer } from './frameBuffer.js';
export { createInspector } from './inspector.js';

/**
 * @param {{ source: object }} deps — a video source is required; everything else defaults from config.
 * @param {object} [overrides] — partial inspectorConfig plus optional pre-built pieces
 *   ({ detector, faces, deepAnalyzer, store, buffer, onStatus }).
 */
export async function buildInspector({ source, ...pieces }, overrides = {}) {
  const cfg = { ...inspectorConfig, ...overrides };
  const store = pieces.store ?? createSceneStore({ eventCooldownMs: cfg.eventCooldownMs });
  const buffer = pieces.buffer ?? createFrameBuffer(cfg.buffer);
  const detector = pieces.detector ?? (await createDetector(cfg, pieces.onStatus));
  const faces = pieces.faces ?? createFaceRecognizer();
  // In the browser, explicit analyzeFrame() requests (agent vision tools) go to
  // the REAL vision pipeline via the server proxy — with dedup caching,
  // in-flight coalescing, and a concurrency cap. The continuous escalation loop
  // stays on the free stub (autoAnalyze) so remote analysis only happens when
  // explicitly requested, never per-frame.
  const deepAnalyzer = pieces.deepAnalyzer
    ?? (cfg.deepAnalysis?.enabled
      ? createDeepAnalyzer({
        ...cfg.deepAnalysis,
        ...(typeof window !== 'undefined'
          ? {
            analyze: createVisionAnalyze(createVisionAnalyzer({ provider: createProxyVisionProvider(), ...cfg.deepAnalysis.vision })),
            autoAnalyze: stubAnalyze,
          }
          : {}),
      })
      : undefined);

  const inspector = createInspector({
    source,
    detector,
    store,
    faces,
    buffer,
    deepAnalyzer,
    intervalMs: cfg.intervalMs,
    minDetectionConfidence: cfg.minDetectionConfidence,
    bufferEveryNth: cfg.buffer?.bufferEveryNth,
    onStatus: pieces.onStatus,
  });

  return { inspector, store, buffer, detector, deepAnalyzer };
}
