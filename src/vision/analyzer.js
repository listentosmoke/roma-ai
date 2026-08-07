// Vision analyzer — the request-shaping layer between the frame buffer and a
// vision provider. Adds the operational guarantees the raw provider doesn't:
//
//  - duplicate-request cache: the same (frame, normalized question, model)
//    within a short TTL reuses the recent result instead of a new remote call
//  - in-flight coalescing: identical concurrent requests await ONE promise
//  - a small concurrency cap on simultaneous remote requests
//  - image preparation (resize/compress/optional crop) before upload
//  - prep/provider/total latency + payload-size metrics on every result
//
// Errors are never cached; the base64 image payload is never logged.

import { now as clockNow } from '../clock.js';
import { prepareImage } from './prepare.js';

export function normalizeQuestion(question) {
  return String(question ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Compact fast-detector hint lines for the vision prompt — hints, not facts. */
export function sceneContextFrom(sceneState) {
  if (!sceneState) return '';
  const lines = (sceneState.objects ?? [])
    .filter((o) => o.visibility === 'visible')
    .slice(0, 10)
    .map((o) => `- ${o.label}, ${o.position}, confidence ${(o.confidence ?? 0).toFixed(2)}`);
  if (sceneState.scene?.summary) lines.unshift(`Scene: ${sceneState.scene.summary}`);
  return lines.join('\n');
}

/**
 * Adapt a vision analyzer to the deep-analysis `analyze` contract
 * (createDeepAnalyzer in src/inspector/deepAnalysis.js), so the existing
 * escalation interface stays unchanged while gaining real vision.
 */
export function createVisionAnalyze(analyzer, { transcriptContext } = {}) {
  return async ({ frame, reason, sceneState, frameAt }) => analyzer.analyze({
    frame,
    frameAt,
    question: reason,
    sceneContext: sceneContextFrom(sceneState),
    transcriptContext: transcriptContext?.() ?? undefined,
  });
}

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < limit) { active += 1; return; }
      await new Promise((resolve) => waiters.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      waiters.shift()?.();
    },
    active: () => active,
  };
}

/**
 * @param {{
 *   provider: { analyze: Function, model?: string, name?: string },
 *   prepare?: typeof prepareImage,
 *   prepareOptions?: object,
 *   cacheTtlMs?: number,
 *   maxConcurrent?: number,
 *   now?: () => number,
 * }} deps
 */
export function createVisionAnalyzer({
  provider,
  prepare = prepareImage,
  prepareOptions = {},
  cacheTtlMs = 30000,
  maxConcurrent = 2,
  now = clockNow,
} = {}) {
  const cache = new Map(); // key -> { at, outcome }
  const inFlight = new Map(); // key -> Promise
  const semaphore = createSemaphore(maxConcurrent);
  let cacheHits = 0;
  let remoteCalls = 0;

  function cacheKey({ frameAt, question }) {
    return `${frameAt ?? 'live'}|${normalizeQuestion(question)}|${provider.model ?? provider.name ?? 'vision'}`;
  }

  async function run({ frame, frameAt, question, sceneContext, transcriptContext, target, crop, signal }) {
    await semaphore.acquire();
    const startedAt = now();
    try {
      const prepared = await prepare(frame, { ...prepareOptions, crop: crop ?? null });
      const prepMs = now() - startedAt;
      remoteCalls += 1;
      const response = await provider.analyze({
        image: prepared.dataUrl,
        question,
        sceneContext,
        transcriptContext,
        target,
        capturedAt: frameAt ?? null,
        requestedAt: now(),
        signal,
      });
      return {
        result: response.result,
        model: response.model,
        usage: response.usage,
        frameAt: frameAt ?? null,
        prepared: { width: prepared.width, height: prepared.height, bytes: prepared.bytes, resized: prepared.resized, cropped: prepared.cropped },
        prepMs,
        providerMs: response.latencyMs,
        totalMs: now() - startedAt,
        cacheHit: false,
      };
    } finally {
      semaphore.release();
    }
  }

  return {
    provider,

    /** @returns {Promise<{ result, model, frameAt, prepared, prepMs, providerMs, totalMs, cacheHit }>} */
    async analyze(request) {
      const key = cacheKey(request);

      const cached = cache.get(key);
      if (cached && now() - cached.at <= cacheTtlMs) {
        cacheHits += 1;
        return { ...cached.outcome, cacheHit: true };
      }
      if (cached) cache.delete(key);

      const existing = inFlight.get(key);
      if (existing) {
        cacheHits += 1;
        return existing.then((outcome) => ({ ...outcome, cacheHit: true }));
      }

      const promise = run(request);
      inFlight.set(key, promise);
      try {
        const outcome = await promise;
        cache.set(key, { at: now(), outcome });
        return outcome;
      } finally {
        inFlight.delete(key); // errors are not cached — the next call retries fresh
      }
    },

    stats: () => ({ cacheHits, remoteCalls, inFlight: inFlight.size, active: semaphore.active(), cacheSize: cache.size }),
  };
}
