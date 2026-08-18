// Known-person identification.
//
// The Inspector calls identify(frame, personTracks) each cycle and merges the
// result into the scene state's people list.
//
//   identify(frame, personTracks) -> Promise<[{ id, identity|null, confidence }]>
//
// Two implementations satisfy that contract:
//
//   createFaceRecognizer()        — the honest null recognizer: labels nobody.
//                                   Still the default, and what `lookup` lets
//                                   tests and simulations script.
//   createServerFaceRecognizer()  — real recognition against the local server
//                                   (/api/face/identify), which holds the
//                                   encoder and the encrypted templates.
//
// The browser never sees a face template and never runs the model: it sends a
// JPEG of the current frame and receives person ids back. Frames are not
// stored anywhere, by either side.
//
// A match is EVIDENCE, never authentication, and there is no liveness check —
// a printed photograph may match. See PLAN-FACE-IDENTITY.md.

export function createFaceRecognizer({ lookup } = {}) {
  return {
    name: lookup ? 'scripted' : 'placeholder',
    async identify(frame, personTracks) {
      return (personTracks ?? []).map((track) => {
        const match = lookup?.(track, frame) ?? null;
        return {
          id: track.id,
          identity: match?.identity ?? null,
          confidence: match?.confidence ?? 0,
        };
      });
    },
  };
}

/** Largest-overlap association between a detected face box and a person track. */
function bestTrackForFace(box, personTracks) {
  let best = null;
  let bestArea = 0;
  for (const track of personTracks ?? []) {
    const b = track.bbox ?? track.box ?? null;
    if (!b) continue;
    const [tx1, ty1, tx2, ty2] = Array.isArray(b) ? b : [b.x1, b.y1, b.x2, b.y2];
    const overlap = Math.max(0, Math.min(box.x2, tx2) - Math.max(box.x1, tx1))
      * Math.max(0, Math.min(box.y2, ty2) - Math.max(box.y1, ty1));
    if (overlap > bestArea) { bestArea = overlap; best = track; }
  }
  return bestArea > 0 ? best : null;
}

/**
 * Real recognition through the server.
 *
 * @param {object} deps
 * @param {(frame:any)=>Promise<string|null>} deps.encodeFrame frame -> base64 JPEG
 * @param {(path:string, body:object)=>Promise<any>} deps.post authenticated POST
 * @param {()=>boolean} [deps.enabled] master switch (camera on, feature on)
 * @param {number} [deps.minIntervalMs] floor between calls; recognition is far
 *   more expensive than detection and does not need to run every frame.
 */
export function createServerFaceRecognizer({ encodeFrame, post, enabled = () => true, minIntervalMs = 1500, now = Date.now } = {}) {
  let lastCallAt = 0;
  let inFlight = false;
  // Results persist between calls so tracks keep their label on the frames
  // where recognition was skipped — otherwise a name would flicker on and off.
  let lastByTrack = new Map();

  return {
    name: 'server_face_identity',
    async identify(frame, personTracks) {
      const tracks = personTracks ?? [];
      const fallback = () => tracks.map((track) => ({
        id: track.id,
        identity: lastByTrack.get(track.id)?.identity ?? null,
        confidence: lastByTrack.get(track.id)?.confidence ?? 0,
      }));

      if (!enabled() || !tracks.length) return tracks.map((track) => ({ id: track.id, identity: null, confidence: 0 }));
      // Never queue up: a slow server must not build a backlog of stale frames.
      if (inFlight || now() - lastCallAt < minIntervalMs) return fallback();

      inFlight = true;
      lastCallAt = now();
      try {
        const image = await encodeFrame(frame);
        if (!image) return fallback();
        const response = await post('/api/face/identify', { image });
        const next = new Map();
        for (const face of response?.faces ?? []) {
          if (!face.match) continue;
          const track = bestTrackForFace(face.box, tracks);
          if (track) next.set(track.id, { identity: face.match.personId, confidence: face.match.similarity });
        }
        lastByTrack = next;
        return tracks.map((track) => ({
          id: track.id,
          identity: next.get(track.id)?.identity ?? null,
          confidence: next.get(track.id)?.confidence ?? 0,
        }));
      } catch {
        // A recognition failure must never break perception: the scene still
        // has people in it, they are simply unidentified.
        return fallback();
      } finally {
        inFlight = false;
      }
    },
  };
}
