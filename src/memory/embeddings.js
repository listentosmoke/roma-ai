// Provider-independent embedding interface for semantic memory retrieval.
//
// HONEST STATUS (see MEMORY.md "Embedding provider"): neither of this app's two
// existing model providers exposes an embeddings endpoint in this codebase's
// setup (Groq's chat-completions API here is used for text generation only;
// Deepgram is STT/TTS only). Rather than fabricate an unverified third-party
// integration, this phase ships:
//   - a real, deterministic-but-honestly-labeled interface (createMockEmbedder)
//     used ONLY in tests/simulation to exercise the semantic-search code path,
//   - a keyword/token-overlap scorer (createKeywordScorer) that is the ACTUAL
//     production relevance signal used by the retriever when no embedding
//     provider is configured (which is always, today).
// retriever.js reports which one produced each result's score (`matchType`) so
// nothing here is ever silently presented as real semantic embedding retrieval.

const MAX_INPUT_CHARS = 2000;

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
