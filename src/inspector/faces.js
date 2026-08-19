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
          const track = bestTrackForFace(face.box, tracks);
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
