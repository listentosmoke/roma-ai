-- Persisted memory embeddings.
--
-- Vectors were cached in the browser's localStorage, keyed by memory id. That
-- works, but it is per-device and per-profile: a second browser, a cleared
-- cache, or a fresh machine re-embeds the entire memory store before the first
-- retrieval can rank anything. The model lives on the server, so the vectors
-- it produces belong there too.
--
-- `model` and `dimensions` travel with every row because a vector only means
-- anything relative to the encoder that produced it. A model swap does not
-- migrate this table — it makes every row unusable, and the reader re-embeds
-- rather than comparing numbers that no longer share a space
-- (see embeddingMatchesEmbedder).
--
-- The vector is stored as base64 of a little-endian Float32Array: 1.5 KB per
-- 384-d vector, against roughly 8 KB as JSON text, and exact rather than
-- decimal-rounded.

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(memory_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_workspace_model
  ON memory_embeddings(workspace_id, model);
