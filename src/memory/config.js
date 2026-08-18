// Memory configuration (browser side). The extraction model call reuses the
// EXISTING /api/agent/infer proxy (server/groqApi.js) — it is already a
// generic { system, messages, schema } -> { decisionRaw } endpoint, so no new
// server route or credential is needed for memory extraction. Storage is
// local (see repository.js) — no server DB, no additional secret to protect.

export const memoryConfig = {
  proxy: { endpoint: '/api/agent/infer', timeoutMs: 20000 },
  storageKey: 'roma.memories',
  retrieval: {
    maximumMemories: 8,
    tokenBudget: 1200,
  },
  recall: {
    maximumMemories: 5,
    tokenBudget: 600,
  },
};
