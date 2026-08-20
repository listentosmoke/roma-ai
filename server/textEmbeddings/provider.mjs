// Local text-embedding provider — the real semantic signal behind
// src/memory/embeddings.js's long-standing interface.
//
// WHY THIS EXISTS NOW. embeddings.js said, honestly at the time: "neither of
// this app's two existing model providers exposes an embeddings endpoint", so
// retrieval fell back to token overlap. That premise expired. This repository
// now runs local models server-side twice over — WavLM for speaker identity
// and InsightFace for faces — and `@huggingface/transformers` is already a
// direct dependency. A sentence encoder needs no third-party endpoint at all,
// so the honest fallback can finally be replaced by the real thing.
//
// The model is pinned by id AND revision, like the other two, so an upstream
// change can never silently alter what a stored vector means. `model` travels
// with every vector; a mismatch makes the caller re-embed instead of serving a
// stale one (see embeddingMatchesEmbedder).
//
// Text never leaves the machine. This is the same privacy property the voice
// and face encoders have, and it matters more here than it looks: memory
// summaries are the most personal text Roma holds.

const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
// fp32, not the q8 used elsewhere in this repo, and the reason is measured:
// under q8 the SAME text embeds differently depending on what else is in its
// batch (cosine 0.970 alone vs batched with a longer string). Vectors here are
// cached and compared across time, so that variance would quietly put a few
// percent of noise between a stored memory and a query. At fp32 the same
// comparison is exactly 1.000000, and the model is small enough that it costs
// about a millisecond (6ms vs 5ms for two texts). Correctness is free here.
const DEFAULT_DTYPE = 'fp32';

/**
 * Sentence-transformers convention: mean-pool the token states, then L2
 * normalize — pooled over the ATTENTION MASK, so padding contributes nothing.
 *
 * Done explicitly here rather than through the feature-extraction pipeline's
 * own `pooling: 'mean'`, so that what a vector means is visible in this file
 * instead of depending on a library default. (Padding turned out not to be the
 * source of the batch variance that prompted this — quantization was, see
 * DEFAULT_DTYPE — but masking is still what the model was trained with.)
 */
export const POOLING = 'masked-mean';

/** Bounded so one enormous input cannot stall the queue for everything else. */
export const MAX_INPUT_CHARS = 2000;
export const MAX_BATCH = 64;

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_INPUT_CHARS) : '';
}

/**
 * @param {object} [options]
 * @param {Function|null} [options.runtimeLoader] inject the transformers module (tests)
 */
export function createTextEmbeddingProvider({
  modelId = process.env.MEMORY_EMBEDDING_MODEL ?? DEFAULT_MODEL_ID,
  modelRevision = process.env.MEMORY_EMBEDDING_MODEL_REVISION ?? DEFAULT_MODEL_REVISION,
  dtype = process.env.MEMORY_EMBEDDING_DTYPE ?? DEFAULT_DTYPE,
  device = process.env.MEMORY_EMBEDDING_DEVICE ?? 'cpu',
  maxQueue = 8,
  now = Date.now,
  runtimeLoader = null,
} = {}) {
  let pipelinePromise = null;
  let loadError = null;
  let dimensions = null;
  let active = 0;
  const queue = [];

  async function load() {
    if (!pipelinePromise) {
      const modulePromise = runtimeLoader ? Promise.resolve().then(runtimeLoader) : import('@huggingface/transformers');
      pipelinePromise = modulePromise
        .then(async ({ AutoTokenizer, AutoModel }) => {
          const [tokenizer, model] = await Promise.all([
            AutoTokenizer.from_pretrained(modelId, { revision: modelRevision }),
            AutoModel.from_pretrained(modelId, { revision: modelRevision, dtype, device }),
          ]);
          return { tokenizer, model };
        })
        .catch((error) => {
          loadError = error;
          pipelinePromise = null; // a failed load must not poison every later call
          throw error;
        });
    }
    return pipelinePromise;
  }

  /** Mean over real tokens only, then L2 normalize. See POOLING. */
  function pool(hidden, mask, rows, cols, dims) {
    const vectors = [];
    for (let row = 0; row < rows; row += 1) {
      const vector = new Array(dims).fill(0);
      let counted = 0;
      for (let token = 0; token < cols; token += 1) {
        if (!Number(mask[row * cols + token])) continue; // padding contributes nothing
        counted += 1;
        const offset = (row * cols + token) * dims;
        for (let d = 0; d < dims; d += 1) vector[d] += Number(hidden[offset + d]);
      }
      const divisor = counted || 1;
      let square = 0;
      for (let d = 0; d < dims; d += 1) { vector[d] /= divisor; square += vector[d] * vector[d]; }
      const norm = Math.sqrt(square) || 1;
      for (let d = 0; d < dims; d += 1) vector[d] /= norm;
      vectors.push(vector);
    }
    return vectors;
  }

  // The encoder is CPU-bound; letting every caller in at once would make each
  // one slower without finishing any sooner. Same shape as the voice provider.
  function schedule(task) {
    if (active + queue.length >= maxQueue) return Promise.reject(new Error('Embedding queue is full.'));
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  function drain() {
    if (active || !queue.length) return;
    const item = queue.shift();
    active += 1;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { active -= 1; drain(); });
  }

  /**
   * Embed one or more texts. Batched deliberately: retrieval embeds a whole
   * candidate pool at once on a cold cache, and doing that one HTTP round trip
   * (and one model call) at a time is the difference between usable and not.
   *
   * @param {string[]} texts
   * @returns {Promise<{ vectors: number[][], model: string, dimensions: number, latencyMs: number }>}
   */
  async function embedMany(texts) {
    const inputs = (Array.isArray(texts) ? texts : [texts]).map(normalizeText);
    if (!inputs.length) return { vectors: [], model: modelId, dimensions: dimensions ?? 0, latencyMs: 0 };
    if (inputs.length > MAX_BATCH) throw new Error(`Embedding batch of ${inputs.length} exceeds the ${MAX_BATCH} limit.`);
    // An empty string still has to yield a vector of the right shape, or the
    // caller's cache would store a hole it can never match against.
    const safe = inputs.map((text) => (text || ' '));

    return schedule(async () => {
      const startedAt = now();
      const { tokenizer, model } = await load();
      const encoded = await tokenizer(safe, { padding: true, truncation: true });
      const output = await model(encoded);
      const states = output.last_hidden_state ?? output.logits;
      if (!states?.dims) throw new Error('Text encoder returned no hidden states.');
      const [rows, cols, dims] = states.dims;
      const vectors = pool(states.data, encoded.attention_mask.data, rows, cols, dims);
      dimensions = dims;
      return { vectors, model: modelId, dimensions: dims, latencyMs: now() - startedAt };
    });
  }

  async function embed(text) {
    const { vectors } = await embedMany([text]);
    return vectors[0] ?? [];
  }

  return {
    name: 'local_minilm',
    get model() { return modelId; },
    get dimensions() { return dimensions; },
    embed,
    embedMany,
    /** Load the model without embedding anything, so first use is not the slow one. */
    async warmup() {
      await embedMany(['warmup']);
      return { ok: true, model: modelId, dimensions };
    },
    describe() {
      return {
        provider: 'local_minilm',
        model: modelId,
        revision: modelRevision,
        dtype,
        device,
        pooling: POOLING,
        dimensions,
        loaded: Boolean(dimensions),
        local: true,
        error: loadError ? String(loadError.message ?? loadError) : null,
      };
    },
  };
}

let shared = null;
/** One encoder per process — loading the model twice would double the memory for nothing. */
export function getSharedTextEmbeddingProvider() {
  shared ??= createTextEmbeddingProvider();
  return shared;
}
