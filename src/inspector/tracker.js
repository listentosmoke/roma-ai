// Lightweight object tracking (fast path). Pure and dependency-free — like
// engine/segmenter.js it runs identically in the browser Inspector and in the
// Node simulation/tests, so the harness exercises the REAL logic.
//
// Greedy label + IoU matching over normalized [0..1] boxes. Detections that match
// an existing track keep its stable id; unmatched tracks go 'missing' after a
// grace period and are dropped after a longer one. This is intentionally simple —
// swap in a real tracker (e.g. ByteTrack) behind the same update() contract later.

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// Approximate spatial position from a normalized box center ("upper-left",
// "middle-right", "center", …). Good enough for "the wrench is lower-right".
export function describePosition(box) {
  if (!box) return 'unknown';
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
  const row = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle';
  if (row === 'middle' && col === 'center') return 'center';
  return `${row}-${col}`;
}

/**
 * @param {{ iouThreshold?: number, missAfterMs?: number, dropAfterMs?: number }} [options]
 */
export function createTracker({ iouThreshold = 0.2, missAfterMs = 1500, dropAfterMs = 10000 } = {}) {
  const tracks = new Map(); // id -> track
  let nextId = 1;

  function list() {
    return [...tracks.values()].map((track) => ({ ...track, box: track.box ? { ...track.box } : undefined }));
  }

  return {
    /**
     * @param {Array<{label:string, confidence?:number, box?:{x:number,y:number,width:number,height:number}}>} detections
     * @param {number} at epoch ms
     */
    update(detections, at) {
      const unmatched = new Set(tracks.keys());

      for (const detection of detections ?? []) {
        let bestId = null;
        let bestScore = -1;
        for (const id of unmatched) {
          const track = tracks.get(id);
          if (track.label !== detection.label) continue;
          // Boxes are optional (some detectors/mocks are label-only); a same-label
          // track with no box competition still re-matches.
          const score = detection.box && track.box ? iou(detection.box, track.box) : iouThreshold;
          if (score > bestScore) { bestScore = score; bestId = id; }
        }

        if (bestId !== null && bestScore >= iouThreshold) {
          unmatched.delete(bestId);
          const track = tracks.get(bestId);
          track.box = detection.box ?? track.box;
          track.confidence = detection.confidence ?? track.confidence;
          track.position = describePosition(track.box);
          track.lastSeenAt = at;
          track.visibility = 'visible';
        } else {
          const id = `${detection.label === 'person' ? 'person' : 'obj'}_${nextId++}`;
          tracks.set(id, {
            id,
            label: detection.label,
            confidence: detection.confidence ?? 0,
            box: detection.box,
            position: describePosition(detection.box),
            visibility: 'visible',
            firstSeenAt: at,
            lastSeenAt: at,
          });
        }
      }

      for (const id of unmatched) {
        const track = tracks.get(id);
        const gone = at - track.lastSeenAt;
        if (gone > dropAfterMs) tracks.delete(id);
        else if (gone > missAfterMs) track.visibility = 'missing';
      }

      return list();
    },
    tracks: list,
  };
}
