// ─────────────────────────────────────────────────────────────────────────────
// Engine configuration. Transcription + diarization run on Deepgram's streaming
// API (server-side speaker labels and endpointing/pauses).
//
// SECURITY: the browser never holds the Deepgram key. Put DEEPGRAM_API_KEY in a
// gitignored `.env` (read by the dev server — see server/env.mjs). The client
// opens its streaming WebSocket to the LOCAL proxy path (/api/deepgram/stream),
// and the server pipes it to Deepgram with the real key. Do NOT reintroduce a
// VITE_-prefixed Deepgram key in client code — a referenced VITE_ var gets
// inlined into the public bundle and the security test fails.
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  engine: 'deepgram',
  language: 'en-US',
  deepgram: {
    // The key lives on the server; the client streams through this local proxy.
    proxyPath: '/api/deepgram/stream',
    endpoint: 'wss://api.deepgram.com/v1/listen',
    model: 'nova-3',
    // Silence (ms) that ends an utterance — this is what separates turns/pauses.
    endpointingMs: 300,
    // Emit an UtteranceEnd event after this much silence (backstop for endpointing).
    utteranceEndMs: 1000,
    // This app is tuned for two-person conversations; leave undefined for open-ended speaker counts.
    maxSpeakers: 2,
  },
};
