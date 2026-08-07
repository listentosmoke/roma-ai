import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createEngine, config } from './engine/index.js';

// React glue around the streaming engine. Deepgram returns final, speaker-labeled
// segments directly (split on pauses server-side), so there is no client-side
// clustering or relabeling — onSegment just appends.
export function useVoice() {
  const engineRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [interim, setInterim] = useState('');
  const [segments, setSegments] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState('');
  const [captureStatus, setCaptureStatus] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  // The Deepgram key lives on the server now; availability comes from /api/health.
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((response) => response.json())
      .then((body) => { if (!cancelled) setHasApiKey(Boolean(body?.deepgram?.available)); })
      .catch(() => { if (!cancelled) setHasApiKey(false); });
    return () => { cancelled = true; };
  }, []);

  const handlers = useMemo(
    () => ({
      onInterim: setInterim,
      onSegment: (segment) => setSegments((existing) => [...existing, segment]),
      onSpeakers: setSpeakers,
      onLevel: setLevel,
      onStatus: setStatus,
      onError: setError,
      onVoiceCaptureStatus: setCaptureStatus,
    }),
    [],
  );

  const start = useCallback(async () => {
    setError('');
    setStarting(true);
    setSegments([]);
    setSpeakers([]);
    setInterim('');
    try {
      const engine = createEngine();
      engineRef.current = engine;
      setSessionId(crypto.randomUUID());
      await engine.start(handlers);
      setListening(true);
    } catch (caught) {
      engineRef.current?.stop();
      engineRef.current = null;
      setSessionId(null);
      setError(caught.message || 'Failed to start.');
      setStatus('Idle');
    } finally {
      setStarting(false);
    }
  }, [handlers]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    setListening(false);
    setInterim('');
    setLevel(0);
    setStatus('Idle');
    setSessionId(null);
    setCaptureStatus(null);
  }, []);

  const beginVoiceCapture = useCallback(async (capture) => {
    if (!engineRef.current?.startVoiceCapture) return { state: 'unavailable' };
    return engineRef.current.startVoiceCapture(capture);
  }, []);

  const endVoiceCapture = useCallback(async (operationId) => {
    if (!engineRef.current?.stopVoiceCapture) return { state: 'unavailable' };
    return engineRef.current.stopVoiceCapture(operationId);
  }, []);

  useEffect(() => () => engineRef.current?.stop(), []);

  return {
    listening,
    starting,
    interim,
    segments,
    speakers,
    level,
    status,
    error,
    engine: config.engine,
    hasApiKey,
    sessionId,
    captureStatus,
    beginVoiceCapture,
    endVoiceCapture,
    start,
    stop,
  };
}
