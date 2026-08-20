// Authenticated text-embedding route.
//
// Same boundary discipline as the face and voice routes: the principal comes
// from the auth layer and never from the body, bodies are bounded, errors are
// generic. The model runs here, in the server process, so memory text never
// leaves the machine — the browser sends text it already holds and gets back
// vectors.
//
// Nothing is stored by this route. It is a pure function of its input; the
// caller owns any caching (src/memory/repository.js caches per memory, keyed
// by the model that produced the vector).

const MAX_BODY_BYTES = 512 * 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Body too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function createRateLimiter({ windowMs = 10_000, max = 60 } = {}) {
  const hits = new Map();
  return function check(key) {
    const at = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    recent.push(at);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

export function createEmbeddingsApiHandlers({ provider, auth, maxBatch = 64, embeddingStore = null }) {
  // Retrieval embeds a whole candidate pool on a cold cache, so the budget is
  // per request rather than per text.
  const limit = createRateLimiter({ windowMs: 10_000, max: 60 });

  async function principalOf(req, res) {
    const resolved = await auth.resolvePrincipal(req);
    if (!resolved.ok) { sendJson(res, resolved.status ?? 401, { error: 'Unauthorized.', code: resolved.reasonCode }); return null; }
    return resolved.principal;
  }

  return {
    async status(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      const described = provider.describe();
      sendJson(res, 200, {
        ok: true,
        // "available" means the encoder can be used, not that it is loaded —
        // loading is lazy and the first call pays for it.
        available: !described.error,
        ...described,
      });
    },

    /** Warm the model deliberately, so the first real retrieval is not the slow one. */
    async warmup(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      try {
        const result = await provider.warmup();
        sendJson(res, 200, { ...result, ...provider.describe() });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: 'The text encoder could not be loaded.', code: 'model_unavailable', detail: error?.message ?? null });
      }
    },

    async embed(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!limit(principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return; }
      const body = await readJsonBody(req);
      const texts = Array.isArray(body.texts) ? body.texts : (typeof body.text === 'string' ? [body.text] : null);
      if (!texts || !texts.length) { sendJson(res, 400, { error: 'texts must be a non-empty array of strings.', code: 'texts_required' }); return; }
      if (texts.length > maxBatch) { sendJson(res, 400, { error: `At most ${maxBatch} texts per request.`, code: 'batch_too_large' }); return; }
      if (!texts.every((text) => typeof text === 'string')) { sendJson(res, 400, { error: 'Every text must be a string.', code: 'texts_required' }); return; }

      try {
        const vectors = await provider.embedMany(texts);
        sendJson(res, 200, { ok: true, vectors, model: provider.model, dimensions: provider.dimensions, latencyMs: provider.lastLatencyMs });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: 'The text encoder is unavailable.', code: 'model_unavailable', detail: error?.message ?? null });
      }
    },
  };
}

/** Vectors the browser can seed its cache from, so a fresh profile embeds nothing. */
export function createMemoryEmbeddingHandlers({ provider, auth, embeddingStore, memoryRepository }) {
  async function principalOf(req, res) {
    const resolved = await auth.resolvePrincipal(req);
    if (!resolved.ok) { sendJson(res, resolved.status ?? 401, { error: 'Unauthorized.', code: resolved.reasonCode }); return null; }
    return resolved.principal;
  }

  return {
    async read(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      const model = provider.model;
      const store = embeddingStore.forWorkspace(principal.workspaceId);
      const memories = memoryRepository.forWorkspace(principal.workspaceId, principal.userId).exportAll();
      const stored = store.read(memories.map((memory) => memory.memoryId), { model });
      sendJson(res, 200, {
        ok: true,
        model,
        // Only the shape the browser cache expects; no memory text goes back
        // out through this route, because the browser already has it.
        embeddings: Object.fromEntries(Object.entries(stored).map(([memoryId, entry]) => [memoryId, {
          vector: entry.vector, model: entry.model, dimensions: entry.dimensions, computedAt: entry.computedAt,
        }])),
        counts: store.counts({ model }),
      });
    },

    /**
     * Embed a bounded slice of whatever has no vector yet. Bounded rather than
     * exhaustive so this can be called repeatedly from a warm path instead of
     * blocking startup on a store of unknown size.
     */
    async backfill(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      const body = await readJsonBody(req).catch(() => ({}));
      const store = embeddingStore.forWorkspace(principal.workspaceId);
      const model = provider.model;
      const pending = store.missing({ model, limit: Number(body.limit) || 64 });
      if (!pending.length) {
        sendJson(res, 200, { ok: true, embedded: 0, remaining: 0, model, counts: store.counts({ model }) });
        return;
      }
      try {
        const vectors = await provider.embedMany(pending.map((row) => row.summary));
        const written = store.write(pending.map((row, index) => ({ memoryId: row.memoryId, vector: vectors[index] })), { model: provider.model });
        // A model swap leaves rows nobody can compare against; drop them once
        // the replacement has produced at least one vector of its own.
        const purged = store.purgeOtherModels({ model: provider.model });
        const counts = store.counts({ model: provider.model });
        sendJson(res, 200, { ok: true, embedded: written, purged, remaining: Math.max(0, counts.total - counts.embedded), model: provider.model, counts });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: 'The text encoder is unavailable.', code: 'model_unavailable', detail: error?.message ?? null });
      }
    },
  };
}

const ROUTES = [
  ['GET', '/api/embeddings/status', 'status'],
  ['POST', '/api/embeddings/warmup', 'warmup'],
  ['POST', '/api/embeddings', 'embed'],
];

const MEMORY_ROUTES = [
  ['GET', '/api/memory/embeddings', 'read'],
  ['POST', '/api/memory/embeddings/backfill', 'backfill'],
];

export function attachEmbeddingsApi(middlewares, handlers, memoryHandlers = null) {
  middlewares.use(async (req, res, next) => {
    const isEmbeddings = req.url.startsWith('/api/embeddings');
    const isMemoryEmbeddings = req.url.startsWith('/api/memory/embeddings');
    if (!isEmbeddings && !isMemoryEmbeddings) { next(); return; }
    const pathname = new URL(req.url, 'http://internal').pathname;
    if (isMemoryEmbeddings) {
      for (const [method, path, handler] of MEMORY_ROUTES) {
        if (req.method !== method || pathname !== path) continue;
        if (!memoryHandlers) { sendJson(res, 503, { error: 'Memory embeddings are not configured.', code: 'not_configured' }); return; }
        try { await memoryHandlers[handler](req, res); }
        catch (error) { sendJson(res, 500, { error: error?.message ?? 'Internal error.', code: 'server_error' }); }
        return;
      }
      sendJson(res, 404, { error: 'No such memory-embeddings route.', code: 'not_found' });
      return;
    }
    for (const [method, path, handler] of ROUTES) {
      if (req.method !== method || pathname !== path) continue;
      try { await handlers[handler](req, res); }
      catch (error) { sendJson(res, 500, { error: error?.message ?? 'Internal error.', code: 'server_error' }); }
      return;
    }
    sendJson(res, 404, { error: 'No such embeddings route.', code: 'not_found' });
  });
}
