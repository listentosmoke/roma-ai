// Speech authorization registry — the normalized bridge between the deterministic
// Speech Gate and everything that produces audio (Turn Manager, TTS provider,
// playback controller).
//
// The Speech Gate (proactive/speechGate.js) decides IF speech is allowed. When
// it approves, the runtime/engine mint an authorization here: a small immutable
// record that travels with the request all the way to the speaker. TTS and
// playback VERIFY the authorization is still valid (not expired, revoked,
// superseded, or already consumed) before doing anything — so a stale or
// cancelled approval can never play.
//
// The registry is NOT itself an authority: `mint()` requires an already-approved
// gate decision. It only tracks the lifecycle of approvals the gate granted.

let sequence = 0;
function nextId() {
  sequence += 1;
  return `speech_auth_${sequence}`;
}

export const AUTH_STATUS = {
  AUTHORIZED: 'authorized', // minted, not yet played
  PLAYING: 'playing',
  CONSUMED: 'consumed', // finished playing normally
  EXPIRED: 'expired',
  REVOKED: 'revoked', // barge-in / stop / superseded
};

export function createAuthorizationRegistry({ now = Date.now } = {}) {
  const records = new Map(); // authorizationId -> authorization

  function refreshExpiry(record, at) {
    if (record.status === AUTH_STATUS.AUTHORIZED && at >= record.expiresAt) {
      record.status = AUTH_STATUS.EXPIRED;
    }
    return record;
  }

  return {
    /**
     * Mint an authorization from an APPROVED gate decision. Returns null if the
     * gate did not approve — so no code path can produce a playable
     * authorization without gate approval.
     *
     * @param {{ approved: boolean, reason?: string }} gateDecision
     * @param {{
     *   sourceType: 'direct_response'|'conversation_coaching'|'planning'|string,
     *   sourceId: string, text: string,
     *   delivery?: 'speak_now'|'speak_when_convenient',
     *   priority?: 'low'|'normal'|'high',
     *   turnId?: string|number|null,
     *   interruptible?: boolean, unprompted?: boolean,
     *   lifetimeMs?: number,
     * }} fields
     */
    mint(gateDecision, fields) {
      if (!gateDecision?.approved) return null;
      const at = now();
      const record = {
        authorizationId: nextId(),
        sourceType: fields.sourceType,
        sourceId: fields.sourceId,
        turnId: fields.turnId ?? null,
        text: fields.text,
        delivery: fields.delivery ?? 'speak_now',
        priority: fields.priority ?? 'normal',
        authorizedAt: at,
        expiresAt: at + (fields.lifetimeMs ?? 10000),
        interruptible: fields.interruptible ?? true,
        policyReason: gateDecision.reason ?? '',
        unprompted: fields.unprompted ?? false,
        status: AUTH_STATUS.AUTHORIZED,
        revokedReason: null,
      };
      records.set(record.authorizationId, record);
      return { ...record };
    },

    /** True only if the id is registered AND still authorized/playing and unexpired. */
    isValid(authorizationId, at = now()) {
      const record = records.get(authorizationId);
      if (!record) return false;
      refreshExpiry(record, at);
      return record.status === AUTH_STATUS.AUTHORIZED || record.status === AUTH_STATUS.PLAYING;
    },

    /** True only if the authorization is still allowed to START playing. */
    canStart(authorizationId, at = now()) {
      const record = records.get(authorizationId);
      if (!record) return false;
      refreshExpiry(record, at);
      return record.status === AUTH_STATUS.AUTHORIZED;
    },

    markPlaying(authorizationId) {
      const record = records.get(authorizationId);
      if (record && record.status === AUTH_STATUS.AUTHORIZED) record.status = AUTH_STATUS.PLAYING;
      return record ? { ...record } : null;
    },

    consume(authorizationId) {
      const record = records.get(authorizationId);
      if (record && (record.status === AUTH_STATUS.PLAYING || record.status === AUTH_STATUS.AUTHORIZED)) {
        record.status = AUTH_STATUS.CONSUMED;
      }
      return record ? { ...record } : null;
    },

    revoke(authorizationId, reason = 'revoked') {
      const record = records.get(authorizationId);
      if (record && record.status !== AUTH_STATUS.CONSUMED) {
        record.status = AUTH_STATUS.REVOKED;
        record.revokedReason = reason;
      }
      return record ? { ...record } : null;
    },

    /** Revoke every authorization that has not finished — used by stop/barge-in. */
    revokeAll(reason = 'revoked') {
      const revoked = [];
      for (const record of records.values()) {
        if (record.status === AUTH_STATUS.AUTHORIZED || record.status === AUTH_STATUS.PLAYING) {
          record.status = AUTH_STATUS.REVOKED;
          record.revokedReason = reason;
          revoked.push({ ...record });
        }
      }
      return revoked;
    },

    get(authorizationId) {
      const record = records.get(authorizationId);
      return record ? { ...refreshExpiry(record, now()) } : null;
    },

    /** House-keeping so the map does not grow unbounded in a long session. */
    prune(keep = 50) {
      if (records.size <= keep) return;
      const ids = [...records.keys()];
      for (const id of ids.slice(0, records.size - keep)) records.delete(id);
    },
  };
}
