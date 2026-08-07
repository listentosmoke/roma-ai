// Bounded suggestion store — lives OUTSIDE the model context, like the scene
// store. Tracks every surfaced suggestion's full lifecycle:
//
//   pending → displayed → accepted | dismissed | expired | spoken | converted_to_task
//
// plus deduplication (normalized-token overlap + entity overlap + category
// cooldown) and time-based invalidation: conversation coaching that has
// expired, been superseded, or been RESOLVED by a later transcript turn is
// discarded instead of surfacing late.

import { now as clockNow } from '../clock.js';

export const SUGGESTION_STATUSES = ['pending', 'displayed', 'accepted', 'dismissed', 'expired', 'spoken', 'converted_to_task'];

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'that', 'this', 'it', 'you', 'your', 'they', 'whether', 'if', 'ask', 'clarify', 'check', 'confirm', 'could', 'should', 'say', 'yes', 'no']);

// Light suffix stemming so phrasing variants land on the same token
// ("includes"/"included" → "includ", "materials" → "material").
function stem(token) {
  const stripped = token.replace(/(ies|ing|ed|es|s)$/, '');
  return stripped.length >= 3 ? stripped : token;
}

export function normalizeTokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s$]/g, ' ')
      .split(/\s+/)
      .filter((token) => token && !STOP_WORDS.has(token))
      .map(stem),
  );
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * @param {{ maxActive?: number, dedupWindowMs?: number, dedupOverlap?: number, now?: () => number }} [options]
 */
export function createSuggestionStore({ maxActive = 5, dedupWindowMs = 90000, dedupOverlap = 0.6, now = clockNow } = {}) {
  const suggestions = []; // newest last; bounded
  const listeners = new Set();
  let nextId = 1;

  function notify(event) {
    for (const listener of listeners) listener(event);
  }

  function isActive(suggestion, at) {
    return (suggestion.status === 'pending' || suggestion.status === 'displayed') && suggestion.expiresAt > at;
  }

  function setStatus(suggestion, status, extra = {}) {
    suggestion.status = status;
    Object.assign(suggestion, extra);
    notify({ type: `suggestion-${status === 'converted_to_task' ? 'accepted' : status}`, suggestionId: suggestion.id, suggestion: { ...suggestion } });
  }

  return {
    /**
     * Deduplication check against RECENT suggestions (any status — a dismissed
     * idea should not immediately reappear). "Same useful idea" ≈ same type
     * with high normalized-token overlap, or same type sharing an entity value.
     */
    findDuplicate(opportunity, at = now()) {
      const tokens = normalizeTokens(`${opportunity.content} ${opportunity.suggestedPhrase ?? ''}`);
      const values = new Set(opportunity.relatedEntities?.map((e) => e.value.toLowerCase()) ?? []);
      for (const existing of suggestions) {
        if (at - existing.createdAt > dedupWindowMs) continue;
        if (existing.type !== opportunity.type) continue;
        if (overlapRatio(tokens, existing.tokens) >= dedupOverlap) return existing;
        if (values.size && existing.entityValues.some((value) => values.has(value))) return existing;
      }
      return null;
    },

    /** Record a policy-approved suggestion. Evicts the lowest-scored active one when full. */
    add(opportunity, { interventionScore, finalDelivery, policyReason, sourceTranscriptIds = [], sceneRevision = null, relatedTaskId = null }, at = now()) {
      const suggestion = {
        id: `sug_${nextId++}`,
        createdAt: at,
        expiresAt: at + (opportunity.expiresInMs ?? 20000),
        type: opportunity.type,
        content: opportunity.content,
        suggestedPhrase: opportunity.suggestedPhrase,
        confidence: opportunity.confidence,
        usefulness: opportunity.usefulness,
        urgency: opportunity.urgency,
        timeSensitivity: opportunity.timeSensitivity,
        reasonSummary: opportunity.reasonSummary,
        interventionScore,
        deliveryMode: finalDelivery,
        policyReason,
        status: 'pending',
        sourceTranscriptIds,
        sceneRevision,
        relatedTaskId,
        displayed: false,
        spoken: false,
        tokens: normalizeTokens(`${opportunity.content} ${opportunity.suggestedPhrase ?? ''}`),
        entityValues: opportunity.relatedEntities?.map((e) => e.value.toLowerCase()) ?? [],
      };

      const active = suggestions.filter((s) => isActive(s, at));
      if (active.length >= maxActive) {
        const weakest = active.reduce((min, s) => (s.interventionScore < min.interventionScore ? s : min));
        setStatus(weakest, 'expired', { expiredReason: 'evicted for a newer suggestion' });
      }
      suggestions.push(suggestion);
      if (suggestions.length > maxActive * 6) suggestions.shift(); // history stays bounded too
      return suggestion;
    },

    markDisplayed(id, at = now()) {
      const suggestion = suggestions.find((s) => s.id === id);
      if (!suggestion || !isActive(suggestion, at)) return null;
      suggestion.displayed = true;
      setStatus(suggestion, 'displayed');
      return suggestion;
    },

    markSpoken(id) {
      const suggestion = suggestions.find((s) => s.id === id);
      if (!suggestion) return null;
      suggestion.spoken = true;
      setStatus(suggestion, 'spoken');
      return suggestion;
    },

    accept(id) {
      const suggestion = suggestions.find((s) => s.id === id);
      if (suggestion) setStatus(suggestion, 'accepted');
      return suggestion ?? null;
    },

    dismiss(id) {
      const suggestion = suggestions.find((s) => s.id === id);
      if (suggestion) setStatus(suggestion, 'dismissed');
      return suggestion ?? null;
    },

    convertToTask(id, taskId) {
      const suggestion = suggestions.find((s) => s.id === id);
      if (suggestion) setStatus(suggestion, 'converted_to_task', { relatedTaskId: taskId });
      return suggestion ?? null;
    },

    /** Expire everything past its deadline. Returns the expired suggestions. */
    sweepExpired(at = now()) {
      const expired = [];
      for (const suggestion of suggestions) {
        if ((suggestion.status === 'pending' || suggestion.status === 'displayed') && suggestion.expiresAt <= at) {
          setStatus(suggestion, 'expired', { expiredReason: 'time limit reached' });
          expired.push(suggestion);
        }
      }
      return expired;
    },

    /**
     * A new transcript turn may RESOLVE an open suggestion (e.g. the other
     * person answers the materials question) — invalidate instead of surfacing
     * stale coaching. Heuristic: strong token/entity overlap with the new turn.
     */
    invalidateResolvedBy(turnText, at = now()) {
      const turnTokens = normalizeTokens(turnText);
      const invalidated = [];
      for (const suggestion of suggestions) {
        if (!isActive(suggestion, at)) continue;
        const overlap = overlapRatio(suggestion.tokens, turnTokens);
        const entityHit = suggestion.entityValues.some((value) => turnText.toLowerCase().includes(value));
        if (overlap >= 0.5 || (entityHit && overlap >= 0.25)) {
          setStatus(suggestion, 'expired', { expiredReason: 'resolved by the conversation' });
          invalidated.push(suggestion);
        }
      }
      return invalidated;
    },

    active: (at = now()) => suggestions.filter((s) => isActive(s, at)).map((s) => ({ ...s })),
    // Still worth speaking? Unlike active(), this treats a suggestion already
    // handed to the voice layer (status 'spoken') as valid — it is mid-delivery
    // (e.g. waiting for a conversational gap), not resolved. Expired/dismissed/
    // resolved-by-conversation suggestions return false so pending speech drops.
    isDeliverable: (id, at = now()) => {
      const s = suggestions.find((x) => x.id === id);
      if (!s || s.expiresAt <= at) return false;
      return s.status === 'pending' || s.status === 'displayed' || s.status === 'spoken';
    },
    all: () => suggestions.map((s) => ({ ...s })),
    shownSince: (sinceMs, at = now()) => suggestions.filter((s) => s.displayed && s.createdAt >= at - sinceMs).length,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
