// Provider-independent embedding interface for semantic memory retrieval.
//
// STATUS: a real encoder now exists. It runs LOCALLY, in the server process
// (server/textEmbeddings/provider.mjs — MiniLM through the transformers
// runtime this repo already uses for voice and face), and the browser reaches
// it through src/memory/proxyEmbedder.js. Memory text never leaves the machine.
//
// This file previously explained that neither Groq nor Deepgram exposes an
// embeddings endpoint, so retrieval fell back to token overlap. That was true
// and is no longer the whole picture: a local model needs no third-party
// endpoint at all.
//
// What ships here, unchanged in shape:
//   - createMockEmbedder — deterministic, honestly labeled, tests/simulation
//     only. Never presented as semantic understanding.
//   - createKeywordScorer — the fallback that still runs whenever no encoder
//     is configured (a machine without the model, an unreachable server).
// retriever.js reports which one produced each score (`matchType`), and its
// relevance floor differs per scorer because their score distributions do —
// see MIN_SIGNAL_BY_MATCH_TYPE there.

const MAX_INPUT_CHARS = 2000;

/** Matches the server route's own per-request cap (server/routes/embeddingsApi.mjs). */
export const MAX_EMBED_BATCH = 64;

function tokenize(text) {
  return (text ?? '')
    .toLowerCase()
    .slice(0, MAX_INPUT_CHARS)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministic hashed bag-of-words embedder — NOT a real semantic model.
 * Same input always produces the same vector (no network, no randomness), so
 * tests are fully reproducible. Dimension + a model id travel with every
 * vector so a later swap to a real provider can detect and re-embed stale data.
 */
export function createMockEmbedder({ dimensions = 32 } = {}) {
  return {
    name: 'mock-hash-embedder',
    model: 'mock-hash-v1',
    dimensions,
    async embed(text) {
      const vector = new Array(dimensions).fill(0);
      for (const token of tokenize(text)) {
        let hash = 0;
        for (let i = 0; i < token.length; i += 1) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        vector[hash % dimensions] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    },
  };
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

/**
 * Deterministic token-overlap relevance score — the real fallback path used in
 * production today (no embedding credential exists). Jaccard-like overlap
 * between two texts' token sets, [0..1].
 */
export function createKeywordScorer() {
  return {
    name: 'keyword-overlap',
    score(queryText, targetText) {
      const q = new Set(tokenize(queryText));
      const t = new Set(tokenize(targetText));
      if (!q.size || !t.size) return 0;
      let overlap = 0;
      for (const token of q) if (t.has(token)) overlap += 1;
      return overlap / Math.sqrt(q.size * t.size);
    },
  };
}

/** Validate a stored embedding's shape against the embedder that would produce it now. */
export function embeddingMatchesEmbedder(stored, embedder) {
  if (!stored || !embedder) return false;
  return stored.model === embedder.model && Array.isArray(stored.vector) && stored.vector.length === embedder.dimensions;
}
