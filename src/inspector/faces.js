// Known-person identification interface — MODULAR PLACEHOLDER.
//
// The Inspector calls identify(frame, personTracks) each cycle and merges the
// result into the scene state's people list. The default recognizer labels
// everyone unidentified (identity: null), which is honest and keeps the rest of
// the pipeline real. Swap in an actual implementation (face-api.js embeddings,
// InsightFace via a small backend, etc.) behind the same contract:
//
//   identify(frame, personTracks) -> Promise<[{ id, identity|null, confidence }]>
//
// `lookup` lets tests/simulations script identities without a model.

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
