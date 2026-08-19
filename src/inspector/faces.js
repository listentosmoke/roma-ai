// Known-person identification.
//
// The Inspector calls identify(frame, personTracks) each cycle and merges the
// result into the scene state's people list.
//
//   identify(frame, personTracks)
//     -> Promise<[{ id, identity|null, personId|null, faceProfileId|null,
//                   confidence, quality }]>
//
// `identity` is a human-readable name for display and for the agent's scene
// snapshot. `personId`/`faceProfileId`/`quality` are the machine-side fields
// the identity resolver needs to turn a sighting into `face_match` evidence
// (src/identity/resolver.js) — the resolver never reads a name.
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
          personId: match?.personId ?? null,
          faceProfileId: match?.faceProfileId ?? null,
          confidence: match?.confidence ?? 0,
          quality: match?.quality ?? 0,
        };
      });
    },
  };
}

/**
 * The two halves of this pipeline describe boxes differently, and getting it
 * wrong is silent rather than loud — every association simply fails and
 * nobody is ever recognised.
 *
 *   person tracks (src/inspector/tracker.js) — { x, y, width, height },
 *                                              NORMALIZED to 0..1
 *   face boxes    (server/faceIdentity)      — { x1, y1, x2, y2},
 *                                              PIXELS of the submitted frame
 *
 * So both are converted to normalized corners before they are compared.
 */
function toCorners(box) {
  if (!box) return null;
  if (Array.isArray(box)) return box.length === 4 ? box : null;
  if (box.x2 != null && box.x1 != null) return [box.x1, box.y1, box.x2, box.y2];
  if (box.width != null && box.x != null) return [box.x, box.y, box.x + box.width, box.y + box.height];
  return null;
}

/** Pixel dimensions of the frame the face boxes were measured against. */
function frameSize(frame) {
  const width = frame?.width ?? frame?.canvas?.width ?? frame?.video?.videoWidth ?? 0;
  const height = frame?.height ?? frame?.canvas?.height ?? frame?.video?.videoHeight ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Largest-overlap association between a detected face box and a person track. */
function bestTrackForFace(faceBox, personTracks, frame) {
  const corners = toCorners(faceBox);
  if (!corners) return null;
  const size = frameSize(frame);
  // Without frame dimensions the two coordinate spaces cannot be reconciled.
  // Boxes already inside the unit square are taken as normalized; anything
  // else is refused rather than associated by accident.
  const withinUnit = corners.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  if (!size && !withinUnit) return null;
  const [fx1, fy1, fx2, fy2] = size
    ? [corners[0] / size.width, corners[1] / size.height, corners[2] / size.width, corners[3] / size.height]
    : corners;

  let best = null;
  let bestArea = 0;
  for (const track of personTracks ?? []) {
    const t = toCorners(track.box ?? track.bbox ?? null);
    if (!t) continue;
    const overlap = Math.max(0, Math.min(fx2, t[2]) - Math.max(fx1, t[0]))
      * Math.max(0, Math.min(fy2, t[3]) - Math.max(fy1, t[1]));
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
export function createServerFaceRecognizer({
  encodeFrame,
  post,
  enabled = () => true,
  /**
   * personId -> display name, from the browser's people mirror. The server
   * answers with ids; a name is the caller's to supply, and its absence is
   * reported honestly rather than by printing an id at the agent.
   */
  describePerson = () => null,
  minIntervalMs = 1500,
  // Temporal voting. Measured on a real 3 fps video clip: per-frame identity is
  // noisy — faces are missed on turns and blurs, and a scene cut can put a
  // different person in the same track. Requiring agreement across observations
  // before asserting a name, and forgetting after enough disagreement, is what
  // turns a jittery per-frame signal into a stable one.
  confirmAfter = 2,
  forgetAfter = 3,
  now = Date.now,
} = {}) {
  let lastCallAt = 0;
  let inFlight = false;
  // Results persist between calls so tracks keep their label on the frames
  // where recognition was skipped — otherwise a name would flicker on and off.
  let lastByTrack = new Map();
  // trackId -> { personId, hits, misses, confidence, quality, faceProfileId }
  const votes = new Map();

  /** Fold one observation into a track's running vote. */
  function record(trackId, personId, confidence, extra = {}) {
    const vote = votes.get(trackId) ?? { personId: null, hits: 0, misses: 0, confidence: 0, quality: 0, faceProfileId: null };
    if (personId && personId === vote.personId) {
      vote.hits += 1;
      vote.misses = 0;
      vote.confidence = Math.max(vote.confidence, confidence);
      vote.quality = Math.max(vote.quality, extra.quality ?? 0);
      vote.faceProfileId = extra.faceProfileId ?? vote.faceProfileId;
    } else if (personId) {
      // A different answer restarts the count rather than overwriting a
      // confirmed identity on a single frame.
      if (vote.personId && vote.hits >= confirmAfter) vote.misses += 1;
      if (!vote.personId || vote.misses >= forgetAfter || vote.hits < confirmAfter) {
        vote.personId = personId; vote.hits = 1; vote.misses = 0; vote.confidence = confidence;
        vote.quality = extra.quality ?? 0; vote.faceProfileId = extra.faceProfileId ?? null;
      }
    } else {
      vote.misses += 1;
      if (vote.misses >= forgetAfter) { vote.personId = null; vote.hits = 0; vote.confidence = 0; vote.quality = 0; vote.faceProfileId = null; }
    }
    votes.set(trackId, vote);
    return vote;
  }

  /**
   * Only a vote that has cleared confirmAfter is allowed to name anyone.
   *
   * "identity" is a DISPLAY NAME (or null) and is what gets shown and read
   * into the agent's scene snapshot; "personId" is the machine-side reference
   * the identity resolver works in. They are separate because a recognised
   * person whose name the browser cannot look up must not be described to the
   * model as an opaque record id.
   */
  function settled(trackId) {
    const vote = votes.get(trackId);
    if (!vote || !vote.personId || vote.hits < confirmAfter) {
      return { identity: null, personId: null, faceProfileId: null, confidence: 0, quality: 0 };
    }
    return {
      identity: describePerson(vote.personId) ?? null,
      personId: vote.personId,
      faceProfileId: vote.faceProfileId,
      confidence: vote.confidence,
      quality: vote.quality,
    };
  }

  return {
    name: 'server_face_identity',
    async identify(frame, personTracks) {
      const tracks = personTracks ?? [];
      // A throttled cycle reports the settled vote, not a fresh guess.
      const fallback = () => tracks.map((track) => ({ id: track.id, ...settled(track.id) }));

      if (!enabled() || !tracks.length) {
        votes.clear();
        return tracks.map((track) => ({ id: track.id, identity: null, personId: null, faceProfileId: null, confidence: 0, quality: 0 }));
      }
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
          const track = bestTrackForFace(face.box, tracks, frame);
          if (!track) continue;
          next.set(track.id, {
            personId: face.match.personId,
            faceProfileId: face.match.faceProfileId ?? null,
            confidence: face.match.similarity,
            // The server's own quality gate (server/faceIdentity/service.mjs).
            // A face it judged unusable scores 0 here, which is below every
            // identity threshold downstream — it can label a track on screen
            // but can never become evidence about who somebody is.
            quality: face.quality?.value ?? 0,
          });
        }
        lastByTrack = next;
        // Every visible track votes this cycle — including the ones that saw
        // nobody, so a person who walks away is eventually forgotten.
        for (const track of tracks) {
          const observed = next.get(track.id) ?? null;
          record(track.id, observed?.personId ?? null, observed?.confidence ?? 0, { quality: observed?.quality ?? 0, faceProfileId: observed?.faceProfileId ?? null });
        }
        for (const trackId of [...votes.keys()]) {
          if (!tracks.some((track) => track.id === trackId)) votes.delete(trackId);
        }
        return tracks.map((track) => ({ id: track.id, ...settled(track.id) }));
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
