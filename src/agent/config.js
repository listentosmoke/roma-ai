// ─────────────────────────────────────────────────────────────────────────────
// Agent configuration (browser side).
//
// SECURITY: the browser never holds the Groq API key. All model calls go
// through the local server routes (server/groqApi.js — see vite.config.js),
// which read GROQ_API_KEY / GROQ_MODEL / GROQ_BASE_URL / VISION_MODEL from the
// server environment or the gitignored `.env`. Do NOT reintroduce a VITE_-
// prefixed Groq key reference in client code — the vision test suite fails if
// any src/ file mentions one, because a referenced VITE_ var gets inlined into
// the public bundle.
//
// The app checks GET /api/health at startup: if the server has no key, the
// runtime falls back to the mock provider and says so in the Agent panel.
// ─────────────────────────────────────────────────────────────────────────────

export const agentConfig = {
  provider: 'proxy',
  proxy: {
    endpoint: '/api/agent/infer',
    timeoutMs: 20000,
  },
  healthEndpoint: '/api/health',
  // Total inferences allowed per turn (initial + bounded tool/vision follow-ups).
  // 4 (not 3): identity tool chains (e.g. name_current_speaker, sometimes
  // followed by a memory tool like remember_this for the same turn) can
  // legitimately need two tool-call rounds before responding, same class of
  // issue as the earlier memory correction/recall chain (recall_memories then
  // correct_memory) that first pushed this from 2 to 3 — 3 left no round free
  // once an identity round and a memory round both occur in one turn.
  // Observed live: two harness turns hit `loop-cap` (no response ever
  // produced) with maxToolRounds:3 once identity tools were introduced;
  // confirmed fixed by re-running the same harness turns after this change.
  maxToolRounds: 4,
  // Bounded recent-transcript window projected into every inference (outside the model).
  transcriptWindowSize: 30,
  transcriptWindowMs: 5 * 60 * 1000,
};
