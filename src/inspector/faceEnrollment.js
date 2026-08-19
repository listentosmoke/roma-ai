// Face enrollment capture — the pure half, so it can be tested without a
// camera, a server, or React.
//
// Enrollment takes SEVERAL frames spaced over a second or two rather than one
// snapshot, because a single frame binds someone to one pose and one lighting
// condition — which is how recognition quietly gets worse the moment they turn
// their head. The server averages the usable ones into a single template
// (server/faceIdentity/service.mjs).
//
// Nothing here retains an image: frames are encoded, handed to the caller, and
// dropped. The server does not store them either.

export const ENROLLMENT_FRAMES = 5;
export const ENROLLMENT_INTERVAL_MS = 600;
/** The server averages at most this many; asking for more just wastes a POST. */
export const MAX_ENROLLMENT_IMAGES = 8;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Grab `count` frames, spaced by `intervalMs`, and encode each one.
 *
 * A frame that cannot be grabbed or encoded is skipped rather than aborting
 * the capture: the camera can legitimately return nothing for a cycle, and
 * losing one of five frames is not a reason to make the user start over.
 *
 * @param {object} deps
 * @param {() => any} deps.grabFrame live frame source (inspector camera)
 * @param {(frame:any) => Promise<string|null>} deps.encodeFrame frame -> base64/data URL
 * @param {(step:{captured:number, attempted:number, total:number}) => void} [deps.onProgress]
 * @returns {Promise<string[]>} encoded images, at most MAX_ENROLLMENT_IMAGES
 */
export async function captureEnrollmentFrames({
  grabFrame,
  encodeFrame,
  count = ENROLLMENT_FRAMES,
  intervalMs = ENROLLMENT_INTERVAL_MS,
  wait = sleep,
  onProgress = null,
} = {}) {
  const total = Math.max(1, Math.min(count, MAX_ENROLLMENT_IMAGES));
  const images = [];
  for (let attempt = 0; attempt < total; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    let image = null;
    try {
      const frame = grabFrame?.() ?? null;
      image = frame ? await encodeFrame(frame) : null;
    } catch {
      image = null; // a bad frame is a skipped frame, not a failed enrollment
    }
    if (image) images.push(image);
    onProgress?.({ captured: images.length, attempted: attempt + 1, total });
  }
  return images;
}

const REJECTION_TEXT = {
  no_face_detected: 'no face in shot',
  multiple_faces: 'more than one face in shot',
  face_too_small: 'too far from the camera',
  low_detection_confidence: 'the face was unclear',
  face_turned_away: 'the face was turned away',
};

/**
 * Turn an enrollment response into one honest sentence for the panel —
 * including WHY frames were dropped, so "it didn't work" is actionable rather
 * than mysterious.
 */
export function summarizeEnrollment(result, { captured = 0 } = {}) {
  if (!result) return 'Enrollment did not complete.';
  if (!result.ok) {
    const reason = REJECTION_TEXT[result.reasonCode] ?? result.reasonCode ?? 'unknown reason';
    return `Enrollment failed: ${reason}. Nothing was stored.`;
  }
  const used = result.samplesUsed ?? 1;
  const dropped = Math.max(0, captured - used);
  const why = (result.rejected ?? []).length
    ? ` Dropped ${dropped}: ${[...new Set(result.rejected)].map((code) => REJECTION_TEXT[code] ?? code).join(', ')}.`
    : '';
  return `Enrolled from ${used} of ${captured} frames.${why}`;
}
