// Pure reducer deriving the "pending speak_when_convenient" UI state from
// voice-delivery events. Kept separate from useVoiceDelivery.js (a React hook)
// so the actual decision logic — what counts as pending, what updates its
// waiting reason, what clears it — is unit-testable without a component
// renderer. The Turn Manager holds exactly one active turn/authorization at a
// time, so "pending" is always 0-or-1 record.
//
// No hidden reasoning is carried here — only the concise text, source type,
// priority, timestamps, and a short deterministic waiting-reason string.

/**
 * @param {object|null} current
 * @param {object} event a voice-delivery event
 * @param {{ get: (id: string) => object|null }} [registry] delivery.registry, for authorizedAt/expiresAt/priority
 * @returns {object|null} the next pending-speech record (or null)
 */
export function pendingSpeechReducer(current, event, registry) {
  switch (event.type) {
    case 'authorized': {
      if (event.delivery !== 'speak_when_convenient') return current;
      const record = registry?.get?.(event.authorizationId);
      return {
        authorizationId: event.authorizationId,
        turnId: event.turnId,
        sourceType: event.sourceType,
        text: event.text,
        priority: record?.priority ?? 'low',
        createdAt: record?.authorizedAt ?? event.at,
        expiresAt: record?.expiresAt ?? null,
        policyReason: event.policyReason,
        waitingReason: 'authorized, about to check for a conversational gap',
      };
    }
    case 'awaiting-gap':
      return current && current.authorizationId === event.authorizationId
        ? { ...current, waitingReason: 'waiting for a quiet moment in the conversation' }
        : current;
    case 'turn-state':
      if (event.state === 'synthesizing' && current && current.turnId === event.turnId) {
        return { ...current, waitingReason: 'gap found — synthesizing audio now' };
      }
      return current;
    case 'stopped-all':
      return null; // global stop always clears
    case 'spoken':
    case 'speech-discarded':
    case 'turn-cancelled':
    case 'turn-completed':
    case 'playback-started': {
      if (!current) return current;
      // turn-completed carries only turnId (no authorizationId) — match on
      // EITHER so an unrelated turn's lifecycle events never clear a still-
      // pending item, but this item's own resolution always clears it.
      const matches = (event.authorizationId && event.authorizationId === current.authorizationId)
        || (event.turnId && event.turnId === current.turnId);
      return matches ? null : current;
    }
    default:
      return current;
  }
}
