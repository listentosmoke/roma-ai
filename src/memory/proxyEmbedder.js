// Browser-side embedder that satisfies src/memory/embeddings.js's interface by
// asking the local server, which owns the model.
//
// Shape is deliberately identical to createMockEmbedder's — `{ name, model,
// dimensions, embed(text) }` — so the retriever, the repository cache, and
// embeddingMatchesEmbedder all work unchanged. `embedMany` is added on top,
// because a cold cache embeds a whole candidate pool at once and doing that
// one HTTP round trip per memory is the difference between usable and not.
//
// `model` and `dimensions` are supplied at construction from the server's
// status, NOT discovered on first use. They are what every cached vector is
// keyed by, so a nullable value here would make every cache entry look stale
// and re-embed the world on each turn.

import { MAX_EMBED_BATCH } from './embeddings.js';

/**
 * @param {object} deps
 * @param {(path: string, body: object) => Promise<any>} deps.post authenticated POST
 * @param {string} deps.model     model id reported by the server
 * @param {number} deps.dimensions vector width reported by the server
 */
export function createProxyEmbedder({ post, model, dimensions, batchSize = MAX_EMBED_BATCH }) {
  if (!post || !model || !dimensions) throw new Error('A proxy embedder needs post, model, and dimensions.');

  async function embedMany(texts) {
    const inputs = Array.isArray(texts) ? texts : [texts];
    if (!inputs.length) return [];
    const vectors = [];
    // The route bounds its batch, so a large pool is split rather than
    // rejected — the caller should not have to know the server's limit.
    for (let start = 0; start < inputs.length; start += batchSize) {
      const chunk = inputs.slice(start, start + batchSize);
      const response = await post('/api/embeddings', { texts: chunk });
      const received = response?.vectors ?? [];
      if (received.length !== chunk.length) throw new Error('The embedding service returned the wrong number of vectors.');
      vectors.push(...received);
    }
    return vectors;
  }

  return {
    name: 'server-proxy-embedder',
    model,
    dimensions,
    embedMany,
    async embed(text) {
      const [vector] = await embedMany([text]);
      return vector ?? [];
    },
  };
}

/**
 * Fill the browser's vector cache from the server's persisted vectors, then
 * ask the server to embed anything it has not embedded yet.
 *
 * Both halves are best-effort: retrieval works without either, just colder.
 * The backfill is bounded per call, so a large store warms over a few passes
 * rather than blocking startup on an unknown amount of work.
 */
export async function warmEmbeddingCache({ dataClient, repository, embedder, maxPasses = 4 }) {
  if (!embedder || !repository?.seedEmbeddings) return { seeded: 0, embedded: 0 };
  let seeded = 0;
  let embedded = 0;
  try {
    const stored = await dataClient.get('/api/memory/embeddings');
    seeded = repository.seedEmbeddings(stored?.embeddings ?? {}, { embedder });

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await dataClient.post('/api/memory/embeddings/backfill', { limit: 64 });
      embedded += result?.embedded ?? 0;
      if (!result?.embedded || !result?.remaining) break;
    }
    if (embedded) {
      const refreshed = await dataClient.get('/api/memory/embeddings');
      seeded += repository.seedEmbeddings(refreshed?.embeddings ?? {}, { embedder });
    }
  } catch {
    // An unreachable or unconfigured server means a cold cache, not a failure.
  }
  return { seeded, embedded };
}

/**
 * Ask the server whether a real encoder is available, and build the embedder
 * only if one is. Returns null otherwise, which is exactly what the memory
 * coordinator already treats as "no embedder configured" — so a machine
 * without the model keeps the honest keyword fallback instead of failing.
 */
export async function createServerEmbedderIfAvailable({ dataClient }) {
  try {
    const status = await dataClient.get('/api/embeddings/status');
    if (!status?.available) return null;
    // dimensions are only known once the model has been loaded at least once;
    // warm it here so the first retrieval is not the one that pays.
    const ready = status.dimensions ? status : await dataClient.post('/api/embeddings/warmup', {});
    if (!ready?.dimensions || !ready?.model) return null;
    return createProxyEmbedder({
      post: (path, body) => dataClient.post(path, body),
      model: ready.model,
      dimensions: ready.dimensions,
    });
  } catch {
    return null; // unreachable server, no model, wrong build — all mean "keyword"
  }
}
