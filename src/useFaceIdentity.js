// React glue for face identity — the counterpart of useVoiceIdentity.
//
// Two jobs:
//   1. Build the live recognizer the Inspector runs each cycle
//      (src/inspector/faces.js), pointed at the local server.
//   2. Drive explicit enrollment from the People panel: capture a few frames
//      from the camera already running, POST them, and report honestly what
//      the server did with them.
//
// The browser never holds a template or an embedding, and never keeps a frame:
// images are encoded, posted, and dropped. What comes back is a person id.
//
// CONSENT IS NOT ENFORCED in this build (see server/faceIdentity/service.mjs).
// The panel says so rather than implying a protection that is switched off.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDataClient } from './server/dataClient.js';
import { createServerFaceRecognizer } from './inspector/faces.js';
import { captureEnrollmentFrames, summarizeEnrollment, ENROLLMENT_FRAMES } from './inspector/faceEnrollment.js';

/** Frames are JPEG-encoded at this quality: enough for a 112px aligned crop, small enough to post every cycle. */
const FRAME_QUALITY = 0.8;

const encodeFrame = async (frame) => frame?.toDataUrl?.(FRAME_QUALITY) ?? null;

export function useFaceIdentity({ people = null, cameraOn = () => false } = {}) {
  const client = useMemo(() => createDataClient({ timeoutMs: 30000 }), []);
  const [status, setStatus] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [busyPersonId, setBusyPersonId] = useState(null);
  const [progress, setProgress] = useState(null);
  const [lastResult, setLastResult] = useState('');
  const [error, setError] = useState('');

  // Refs so the recognizer built once below always sees current values
  // without being rebuilt (rebuilding it would throw away its vote history).
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const cameraOnRef = useRef(cameraOn);
  cameraOnRef.current = cameraOn;
  const enrolledRef = useRef(false);
  enrolledRef.current = profiles.length > 0;

  const refreshStatus = useCallback(
    () => client.get('/api/face/health')
      .then((response) => setStatus(response.face ?? null))
      .catch((caught) => setStatus({ available: false, reason: caught.message })),
    [client],
  );

  const refreshProfiles = useCallback(
    () => client.get('/api/face/profiles')
      .then((response) => setProfiles(response.profiles ?? []))
      .catch(() => setProfiles([])),
    [client],
  );

  useEffect(() => { refreshStatus(); refreshProfiles(); }, [refreshStatus, refreshProfiles]);

  /**
   * The recognizer handed to the Inspector. Built ONCE — its temporal voting
   * is stateful, and a rebuild would forget who it had settled on.
   *
   * It runs only while the camera is on AND somebody is actually enrolled:
   * with an empty template store every request can only ever answer "nobody",
   * so posting frames would be pure cost.
   */
  const recognizer = useMemo(() => createServerFaceRecognizer({
    encodeFrame,
    post: (path, body) => client.post(path, body),
    enabled: () => cameraOnRef.current() && enrolledRef.current,
    describePerson: (personId) => peopleRef.current?.get?.(personId)?.displayName ?? null,
  }), [client]);

  const profilesFor = useCallback((personId) => profiles.filter((profile) => profile.personId === personId), [profiles]);

  /**
   * Explicit enrollment. Requires the camera to already be running — this
   * never starts it, so a face is never captured by a background action.
   */
  const enroll = useCallback(async ({ personId, grabFrame, frames = ENROLLMENT_FRAMES }) => {
    setError('');
    setLastResult('');
    if (!personId) { setError('Choose a person to enrol.'); return null; }
    if (typeof grabFrame !== 'function') { setError('Start the camera before enrolling a face.'); return null; }

    setBusyPersonId(personId);
    setProgress({ captured: 0, attempted: 0, total: frames });
    try {
      const images = await captureEnrollmentFrames({ grabFrame, encodeFrame, count: frames, onProgress: setProgress });
      if (!images.length) {
        setError('The camera returned no usable frames. Is it still running?');
        return null;
      }
      const result = await client.post('/api/face/enroll', { personId, images });
      setLastResult(summarizeEnrollment(result, { captured: images.length }));
      if (result?.ok) {
        await refreshProfiles();
        // Mirror the enrollment into the local person record so the panel and
        // the evidence trail agree without waiting for a full re-hydration.
        peopleRef.current?.recordFaceEnrollment?.({
          personId,
          faceProfileId: result.profile.faceProfileId,
          quality: result.profile.aggregateQuality ?? null,
          sampleCount: result.samplesUsed ?? null,
          provider: result.profile.provider ?? null,
          providerModel: result.profile.model ?? null,
        });
      }
      return result;
    } catch (caught) {
      setError(caught.message || 'Enrollment failed.');
      return null;
    } finally {
      setBusyPersonId(null);
      setProgress(null);
    }
  }, [client, refreshProfiles]);

  /** Forget one enrolled face. The template is deleted server-side, not just unlinked. */
  const forgetFace = useCallback(async ({ personId, faceProfileId }) => {
    setError('');
    try {
      await client.del(`/api/face/profiles/${encodeURIComponent(faceProfileId)}`);
      peopleRef.current?.removeFaceProfile?.({ personId, faceProfileId });
      await refreshProfiles();
      setLastResult('Face template deleted.');
      return true;
    } catch (caught) {
      setError(caught.message || 'Could not delete that face template.');
      return false;
    }
  }, [client, refreshProfiles]);

  return {
    status,
    // "Configured" is the service's own word for a usable template store
    // (server/faceIdentity/service.mjs describe()). Without it, enrollment
    // would fail closed anyway — the panel just says so first.
    ready: Boolean(status?.configured),
    profiles,
    profilesFor,
    enrolledCount: profiles.length,
    busyPersonId,
    progress,
    lastResult,
    error,
    recognizer,
    enroll,
    forgetFace,
    refreshProfiles,
    refreshStatus,
  };
}
