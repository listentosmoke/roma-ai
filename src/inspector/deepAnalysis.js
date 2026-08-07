// Deep-analysis path: when the fast path can't confidently understand something,
// pick the current frame and escalate it to a stronger vision-capable model.
//
// This file is the INTERFACE + decision logic. The analyzer is pluggable:
// `analyze: async ({ frame, reason, sceneState, frameAt }) => string | object`.
// In the browser the real Groq vision pipeline is wired in via
// src/vision/analyzer.js (see inspector/index.js); `autoAnalyze` lets the
// CONTINUOUS escalation loop keep using the free stub while agent-requested
// analyzeFrame() calls hit the real remote model — remote analysis only happens
// when explicitly requested, never per-frame. OCR rides the same path (the
// vision result carries visibleText).

export const stubAnalyze = async ({ reason }) =>
  `[deep-analysis placeholder] Frame captured for: ${reason}. Wire a real vision model in createDeepAnalyzer({ analyze }).`;

function toOutcome(value) {
  return typeof value === 'string' ? { description: value } : { description: value?.result?.answer ?? value?.description ?? null, ...value };
}

/** Why (if at all) the current scene warrants a deeper look. Returns a reason string or null. */
export function shouldEscalate(sceneState, { minConfidence = 0.55 } = {}) {
  if (!sceneState) return null;
  const uncertain = sceneState.objects.find(
    (o) => o.visibility === 'visible' && o.confidence > 0 && o.confidence < minConfidence,
  );
  if (uncertain) return `low-confidence ${uncertain.label} (${Math.round(uncertain.confidence * 100)}%)`;
  const stranger = sceneState.people.find((p) => !p.identity);
  if (stranger) return 'unidentified person in scene';
  return null;
}

/**
 * @param {{ analyze?: Function, autoAnalyze?: Function, minConfidence?: number, cooldownMs?: number }} [options]
 *   `analyze` serves explicit analyzeFrame() requests (agent tools).
 *   `autoAnalyze` serves the continuous maybeAnalyze() escalation loop; it
 *   defaults to `analyze` for back-compat, but the browser wiring passes the
 *   stub here so the always-on loop never makes remote calls on its own.
 */
export function createDeepAnalyzer({ analyze = stubAnalyze, autoAnalyze, minConfidence = 0.55, cooldownMs = 10000 } = {}) {
  const loopAnalyze = autoAnalyze ?? analyze;
  const lastRunAt = new Map(); // reason -> epoch ms (per-reason rate limit)
  let inFlight = false;

  return {
    /** Called every fast-path cycle; escalates at most one frame per reason per cooldown. */
    async maybeAnalyze({ frame, sceneState, at }) {
      const reason = shouldEscalate(sceneState, { minConfidence });
      if (!reason || inFlight) return { requested: false };
      const last = lastRunAt.get(reason);
      if (last !== undefined && at - last < cooldownMs) return { requested: false };
      lastRunAt.set(reason, at);

      inFlight = true;
      try {
        const outcome = toOutcome(await loopAnalyze({ frame, reason, sceneState, frameAt: at }));
        return { requested: true, reason, at, ...outcome };
      } catch (error) {
        return { requested: true, reason, at, error: error.message ?? String(error) };
      } finally {
        inFlight = false;
      }
    },

    /**
     * Explicit escalation of a specific frame (agent vision tools). Provider or
     * validation failures propagate as errors — the tool registry converts them
     * into clear { ok:false } tool failures. Never logs the image payload.
     */
    async analyzeFrame(frame, reason, sceneState, { frameAt } = {}) {
      const outcome = toOutcome(await analyze({ frame, reason, sceneState, frameAt }));
      return { requested: true, reason, ...outcome };
    },
  };
}
