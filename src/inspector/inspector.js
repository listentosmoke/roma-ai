// The Inspector — fast-path visual perception loop. Independent of the main
// agent: it only ever WRITES to the shared scene store (and frame buffer); it
// never touches conversation history. The agent runtime reads the store through
// the Context Compiler when the agent is about to think.
//
// Each cycle: grab frame → buffer → detect → track → identify people →
// classify+interpret → store.update → maybe escalate a frame for deep analysis.
// Every stage is pluggable (source/detector/faces/deep analyzer), and per-stage
// latency is measured so regressions are visible (metrics()).

import { now } from '../clock.js';
import { createTracker } from './tracker.js';
import { classifyScene, interpretScene } from './interpreter.js';

function createStageTimer(names) {
  const totals = Object.fromEntries(names.map((name) => [name, 0]));
  const last = Object.fromEntries(names.map((name) => [name, 0]));
  let cycles = 0;
  return {
    record(samples) {
      cycles += 1;
      for (const [name, ms] of Object.entries(samples)) {
        totals[name] += ms;
        last[name] = ms;
      }
    },
    metrics() {
      const average = Object.fromEntries(
        Object.entries(totals).map(([name, total]) => [name, cycles ? +(total / cycles).toFixed(1) : 0]),
      );
      return { cycles, averageMs: average, lastMs: { ...last } };
    },
  };
}

/**
 * @param {{
 *   source: { grabFrame: Function, stop: Function },
 *   detector: { name?: string, detect: Function },
 *   store: ReturnType<import('./sceneStore.js').createSceneStore>,
 *   faces?: { identify: Function },
 *   buffer?: ReturnType<import('./frameBuffer.js').createFrameBuffer>,
 *   deepAnalyzer?: { maybeAnalyze: Function },
 *   intervalMs?: number,
 *   minDetectionConfidence?: number,
 *   bufferEveryNth?: number,
 *   onStatus?: (status: string) => void,
 * }} deps
 */
export function createInspector({
  source,
  detector,
  store,
  faces,
  buffer,
  deepAnalyzer,
  intervalMs = 250,
  minDetectionConfidence = 0.35,
  bufferEveryNth = 2,
  onStatus,
}) {
  const tracker = createTracker();
  const timer = createStageTimer(['grab', 'buffer', 'detect', 'track', 'identify', 'interpret', 'store', 'escalate', 'cycle']);
  let running = false;
  let timeout = null;
  let cycleCount = 0;

  async function tickOnce(at = now()) {
    const t0 = now();
    let frame;
    try {
      frame = await source.grabFrame();
    } catch (error) {
      onStatus?.(`Frame grab failed: ${error.message}`);
      return null;
    }
    if (!frame) return null;
    const t1 = now();

    // Buffer a lightweight payload (JPEG for camera frames) every Nth cycle.
    cycleCount += 1;
    if (buffer && cycleCount % Math.max(1, bufferEveryNth) === 0) {
      buffer.push(frame.toDataUrl ? { dataUrl: frame.toDataUrl() } : frame, at);
    }
    const t2 = now();

    const rawDetections = await detector.detect(frame);
    const detections = rawDetections.filter((d) => (d.confidence ?? 1) >= minDetectionConfidence);
    const t3 = now();

    const tracks = tracker.update(detections, at);
    const t4 = now();

    const personTracks = tracks.filter((track) => track.label === 'person');
    const identities = faces ? await faces.identify(frame, personTracks) : [];
    const people = personTracks.map((track) => {
      const match = identities.find((identity) => identity.id === track.id);
      return {
        id: track.id,
        identity: match?.identity ?? null,
        // Carried so the agent runtime can hand the identity resolver a
        // bounded face observation (src/identity/resolver.js). No template,
        // no embedding, no frame — an id, a score and a quality.
        personId: match?.personId ?? null,
        faceProfileId: match?.faceProfileId ?? null,
        confidence: match?.confidence ?? 0,
        quality: match?.quality ?? 0,
        lastSeenAt: track.lastSeenAt,
      };
    });
    const objects = tracks.filter((track) => track.label !== 'person');
    const t5 = now();

    const sceneLabel = classifyScene(objects);
    const summary = interpretScene({ objects, people, sceneLabel });
    const t6 = now();

    const state = store.update({ objects, people, sceneLabel, summary }, at);
    const t7 = now();

    if (deepAnalyzer) {
      // Fire-and-forget: remote/deep analysis may take seconds and must never
      // block the continuous local fast path. Events land when it settles.
      deepAnalyzer.maybeAnalyze({ frame, sceneState: state, at }).then((escalation) => {
        if (!escalation?.requested) return;
        buffer?.saveKeyframe(at, escalation.reason);
        store.recordKeyframe(at, escalation.reason);
        store.recordEvent('deep-analysis', `Frame escalated for deeper analysis: ${escalation.reason}`, escalation.reason, at);
      }).catch((error) => onStatus?.(`Deep analysis failed: ${error.message}`));
    }
    const t8 = now();

    timer.record({
      grab: t1 - t0, buffer: t2 - t1, detect: t3 - t2, track: t4 - t3,
      identify: t5 - t4, interpret: t6 - t5, store: t7 - t6, escalate: t8 - t7, cycle: t8 - t0,
    });
    return state;
  }

  async function loop() {
    if (!running) return;
    const started = now();
    try {
      await tickOnce(started);
    } catch (error) {
      onStatus?.(`Inspector cycle failed: ${error.message}`);
    }
    if (!running) return;
    const elapsed = now() - started;
    // Adaptive pacing: idle at least as long as the cycle took (≤50% duty
    // cycle, capped at 2s). Without this, a slow detector (e.g. tfjs on a CPU
    // backend) makes intervalMs - elapsed negative and the loop runs back to
    // back at 100% CPU — the "camera lags the whole machine" failure mode.
    const idle = Math.max(intervalMs - elapsed, Math.min(elapsed, 2000));
    timeout = setTimeout(loop, idle);
  }

  return {
    start() {
      if (running) return;
      running = true;
      onStatus?.(`Watching · ${detector.name ?? 'detector'} @ ${Math.round(1000 / intervalMs)} fps`);
      loop();
    },
    stop() {
      running = false;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      source.stop?.();
      onStatus?.('Inspector stopped');
    },
    /** Run exactly one cycle — used by tests and the Node simulation for determinism. */
    tickOnce,
    metrics: () => timer.metrics(),
    isRunning: () => running,
  };
}
