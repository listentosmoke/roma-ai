// Server-side TTS voice catalog + validation. Imported ONLY by server code
// (server/groqApi.js) — never by client bundles — because Deepgram's real
// catalog is fetched with the server-side key. The client always learns about
// voices through GET /api/tts/voices (server/groqApi.js), never by importing
// this file or hardcoding a list that could drift from what the account
// actually supports.
//
// For Deepgram, we ask Deepgram itself (GET /v1/models) rather than hand-
// maintaining a list, so the catalog can never go stale relative to the
// account. Results are cached briefly in-memory. If the live fetch fails, we
// fall back to just the configured default voice so the app stays usable.

const CACHE_TTL_MS = 10 * 60 * 1000;

// Minimal historical PlayAI voice set — Groq's PlayAI TTS is decommissioned
// (see roma-model-provider-choices memory); kept only so the provider
// abstraction and TTS_PROVIDER=groq path still return something sane if a
// future account regains access, without pretending to have live metadata.
const GROQ_PLAYAI_FALLBACK_VOICES = [
  { id: 'Fritz-PlayAI', displayName: 'Fritz' },
  { id: 'Arista-PlayAI', displayName: 'Arista' },
  { id: 'Atlas-PlayAI', displayName: 'Atlas' },
];

const MOCK_VOICES = [
  { id: 'mock-voice', displayName: 'Mock voice (offline/test)' },
];

function cacheEntry() {
  return { at: 0, catalog: null };
}

/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export function createVoiceCatalog({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = { deepgram: cacheEntry() };

  async function fetchDeepgramVoices(apiKey) {
    const cached = cache.deepgram;
    if (cached.catalog && now() - cached.at < CACHE_TTL_MS) return cached.catalog;

    const response = await fetchImpl('https://api.deepgram.com/v1/models', {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Deepgram models request failed with status ${response.status}`);
    const body = await response.json();
    const voices = (body.tts ?? [])
      .filter((m) => Array.isArray(m.languages) && m.languages.includes('en') && m.canonical_name)
      .map((m) => ({
        id: m.canonical_name,
        displayName: m.metadata?.display_name ?? m.name ?? m.canonical_name,
        architecture: m.architecture ?? null,
        accent: m.metadata?.accent ?? null,
        tags: Array.isArray(m.metadata?.tags) ? m.metadata.tags.slice(0, 4) : [],
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));

    // Deepgram's older ("aura", e.g. aura-arcas-en) and newer ("aura-2", e.g.
    // aura-2-arcas-en) voice generations reuse the same character names — a
    // colliding label in a dropdown would be ambiguous even though the ids
    // differ. Disambiguate only the names that actually collide.
    const counts = new Map();
    for (const v of voices) counts.set(v.displayName, (counts.get(v.displayName) ?? 0) + 1);
    for (const v of voices) {
      if (counts.get(v.displayName) > 1 && v.architecture) v.displayName = `${v.displayName} (${v.architecture})`;
    }

    cache.deepgram = { at: now(), catalog: voices };
    return voices;
  }

  /**
   * @param {{ provider: string, apiKey: string, defaultVoice: string }} config
   * @returns {Promise<{ voices: Array<{id:string, displayName:string}>, fallback: boolean }>}
   */
  async function listVoices({ provider, apiKey, defaultVoice }) {
    if (provider === 'deepgram' || provider === 'deepgram-tts') {
      try {
        const voices = await fetchDeepgramVoices(apiKey);
        // Always guarantee the configured default is present, even if Deepgram
        // renamed/retired it server-side — never leave the UI with no options.
        if (defaultVoice && !voices.some((v) => v.id === defaultVoice)) {
          voices.unshift({ id: defaultVoice, displayName: defaultVoice, accent: null, tags: [] });
        }
        return { voices, fallback: false };
      } catch {
        return { voices: [{ id: defaultVoice, displayName: defaultVoice, accent: null, tags: [] }], fallback: true };
      }
    }
    if (provider === 'groq' || provider === 'groq-tts') {
      const voices = GROQ_PLAYAI_FALLBACK_VOICES.some((v) => v.id === defaultVoice)
        ? GROQ_PLAYAI_FALLBACK_VOICES
        : [{ id: defaultVoice, displayName: defaultVoice }, ...GROQ_PLAYAI_FALLBACK_VOICES];
      return { voices, fallback: true }; // static list — provider is decommissioned, no live metadata to fetch
    }
    return { voices: MOCK_VOICES, fallback: false };
  }

  return {
    listVoices,
    /** Synchronous check against whatever is currently cached (safe default: unknown -> invalid). */
    isKnownVoice(provider, voiceId) {
      if (!voiceId) return false;
      if (provider === 'groq' || provider === 'groq-tts') return GROQ_PLAYAI_FALLBACK_VOICES.some((v) => v.id === voiceId);
      if (provider === 'mock' || provider === 'mock-tts') return MOCK_VOICES.some((v) => v.id === voiceId);
      const cached = cache.deepgram.catalog;
      return Boolean(cached && cached.some((v) => v.id === voiceId));
    },
  };
}
