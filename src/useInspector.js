// React glue around the Inspector — the visual counterpart of useVoice. Starts
// the camera + fast-path loop, subscribes to the scene store, and exposes the
// live scene state, the compiled agent-facing snapshot (for visibility/demo), and
// per-stage latency metrics. The store itself is exposed so an agent runtime can
// read it independently of React.

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildInspector } from './inspector/index.js';
import { createCameraSource } from './inspector/video.js';
import { inspectorConfig } from './inspector/config.js';

/**
 * @param {{ faces?: object }} [deps] — an optional face recognizer
 *   (src/inspector/faces.js). Without one the Inspector labels nobody, which
 *   is the honest default; src/useFaceIdentity.js supplies the real one.
 */
export function useInspector({ faces = null } = {}) {
  const inspectorRef = useRef(null);
  const sourceRef = useRef(null);
  const storeRef = useRef(null);
  const frameBufferRef = useRef(null);
  const deepAnalyzerRef = useRef(null);
  const [watching, setWatching] = useState(false);
  const [startingCamera, setStartingCamera] = useState(false);
  const [scene, setScene] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [inspectorStatus, setInspectorStatus] = useState('Camera off');
  const [inspectorError, setInspectorError] = useState('');
  // Held in a ref so a recognizer identity change never restarts the camera.
  const facesRef = useRef(faces);
  facesRef.current = faces;

  const stopWatching = useCallback(() => {
    inspectorRef.current?.stop();
    inspectorRef.current = null;
    sourceRef.current = null;
    setWatching(false);
    setInspectorStatus('Camera off');
  }, []);

  const startWatching = useCallback(async () => {
    setInspectorError('');
    setStartingCamera(true);
    try {
      const source = await createCameraSource(inspectorConfig.video);
      sourceRef.current = source;
      const { inspector, store, buffer, deepAnalyzer } = await buildInspector({ source, faces: facesRef.current ?? undefined, onStatus: setInspectorStatus });
      storeRef.current = store;
      frameBufferRef.current = buffer;
      deepAnalyzerRef.current = deepAnalyzer;
      // Throttle React updates: the store changes every fast-path cycle, but
      // re-rendering the whole app that often is wasted main-thread time. A
      // trailing update keeps the panel current without per-cycle renders.
      let lastRender = 0;
      let pending = null;
      const THROTTLE_MS = 400;
      store.subscribe((state) => {
        const nowMs = Date.now();
        if (nowMs - lastRender >= THROTTLE_MS) {
          lastRender = nowMs;
          setScene(state);
          setMetrics(inspector.metrics());
        } else if (!pending) {
          pending = setTimeout(() => {
            pending = null;
            lastRender = Date.now();
            setScene(storeRef.current?.getState() ?? state);
            setMetrics(inspector.metrics());
          }, THROTTLE_MS - (nowMs - lastRender));
        }
      });
      inspectorRef.current = inspector;
      inspector.start();
      setWatching(true);
    } catch (caught) {
      sourceRef.current?.stop();
      sourceRef.current = null;
      setInspectorError(caught.message || 'Failed to start the camera.');
      setInspectorStatus('Camera off');
    } finally {
      setStartingCamera(false);
    }
  }, []);

  useEffect(() => () => inspectorRef.current?.stop(), []);

  return {
    watching,
    startingCamera,
    scene,
    metrics,
    inspectorStatus,
    inspectorError,
    sceneStore: storeRef,
    frameBuffer: frameBufferRef,
    deepAnalyzer: deepAnalyzerRef,
    startWatching,
    stopWatching,
    /**
     * One frame from the live camera, or null when it is off. Used by
     * explicit face enrollment — which is why it exists at all: enrollment
     * must be a deliberate act against the camera the user can see running,
     * never a background capture.
     */
    grabFrame: () => sourceRef.current?.grabFrame?.() ?? null,
  };
}
