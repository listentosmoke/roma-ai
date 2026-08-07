// ─────────────────────────────────────────────────────────────────────────────
// Identity configuration (browser side). No provider credentials live here —
// there is no real voice-identity provider wired into this environment (see
// identity/voiceProvider.js "FEASIBILITY FINDING" and IDENTITY.md "Provider
// limitations"). `voiceProviderMode` selects between:
//
//   - 'unavailable'   (production default) — every voice operation honestly
//                       reports why a real provider isn't configured.
//   - 'deterministic' (tests/simulation, and opt-in local dev via
//                       VITE_IDENTITY_VOICE_DEV_MODE=deterministic) — a
//                       repeatable test provider, clearly labeled as such
//                       everywhere it surfaces (People panel, tool results).
// ─────────────────────────────────────────────────────────────────────────────

export const identityConfig = {
  storageKey: 'roma.people',
  sessionTimeoutMs: 30 * 60 * 1000,
  voiceProviderMode: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_IDENTITY_VOICE_DEV_MODE === 'deterministic') ? 'deterministic' : 'unavailable',
  relationshipContext: { maximumRelationships: 5 },
};
