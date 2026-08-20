// Persisted memory vectors (migration 0008).
//
// The encoder lives on the server, so its output does too. Before this, every
// browser profile re-embedded the whole memory store on first use — correct,
// but wasted, and slow exactly when someone opens Roma somewhere new.
//
// A vector only means something relative to the encoder that produced it, so
// `model` is stored with every row and read back with it. Rows from another
// model are not migrated or reinterpreted: they are ignored, and the caller
// re-embeds. Numbers from two different encoders share no space.

/** Float32 little-endian, base64 — 1.5 KB per 384-d vector, and exact. */
export function encodeVector(values) {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded, dimensions) {
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.byteLength !== dimensions * 4) return null; // truncated or from another width
  // The buffer may not be 4-byte aligned, so copy rather than view in place.
  const copy = Buffer.allocUnsafe(buffer.byteLength);
  buffer.copy(copy);
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, dimensions));
}

export function createMemoryEmbeddingStore({ db, now = Date.now }) {
  function forWorkspace(workspaceId) {
    return {
      /** Vectors for these memories that were produced by THIS model. */
      read(memoryIds = [], { model }) {
        if (!memoryIds.length || !model) return {};
        const out = {};
        // Chunked so a large store cannot blow past SQLite's variable limit.
        for (let start = 0; start < memoryIds.length; start += 400) {
          const chunk = memoryIds.slice(start, start + 400);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT memory_id, model, dimensions, vector, computed_at FROM memory_embeddings
             WHERE workspace_id = ? AND model = ? AND memory_id IN (${placeholders})`,
          ).all(workspaceId, model, ...chunk);
          for (const row of rows) {
            const vector = decodeVector(row.vector, row.dimensions);
            if (!vector) continue; // a malformed row is a cache miss, never a wrong answer
            out[row.memory_id] = { vector, model: row.model, dimensions: row.dimensions, computedAt: row.computed_at };
          }
        }
        return out;
      },

      /** @param {Array<{ memoryId: string, vector: number[] }>} entries */
      write(entries, { model }) {
        if (!entries.length || !model) return 0;
        const at = now();
        const statement = db.prepare(
          `INSERT INTO memory_embeddings (memory_id, workspace_id, model, dimensions, vector, computed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions,
             vector = excluded.vector, computed_at = excluded.computed_at`,
        );
        let written = 0;
        db.exec('BEGIN');
        try {
          for (const { memoryId, vector } of entries) {
            if (!memoryId || !vector?.length) continue;
            statement.run(memoryId, workspaceId, model, vector.length, encodeVector(vector), at);
            written += 1;
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return written;
      },

      /** Active memories with no usable vector for this model — the backfill queue. */
      missing({ model, limit = 64 }) {
        if (!model) return [];
        return db.prepare(
          `SELECT m.memory_id, m.summary FROM memories m
           LEFT JOIN memory_embeddings e ON e.memory_id = m.memory_id AND e.model = ?
           WHERE m.workspace_id = ? AND m.status = 'active' AND e.memory_id IS NULL
           ORDER BY m.updated_at DESC LIMIT ?`,
        ).all(model, workspaceId, Math.max(1, Math.min(limit, 256)))
          .map((row) => ({ memoryId: row.memory_id, summary: row.summary }));
      },

      counts({ model }) {
        const total = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE workspace_id = ? AND status = 'active'").get(workspaceId).n;
        const embedded = model
          ? db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE workspace_id = ? AND model = ?').get(workspaceId, model).n
          : 0;
        return { total, embedded, model: model ?? null };
      },

      /** Drop everything from a retired model rather than leaving vectors nobody can compare. */
      purgeOtherModels({ model }) {
        if (!model) return 0;
        const result = db.prepare('DELETE FROM memory_embeddings WHERE workspace_id = ? AND model != ?').run(workspaceId, model);
        return result.changes ?? 0;
      },
    };
  }

  return { forWorkspace };
}
