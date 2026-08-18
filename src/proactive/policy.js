// Intervention Policy — the deterministic decision layer between "the model
// found something" and "the user experiences something". Two exports matter:
//
//   scoreOpportunity(opportunity, context)  → transparent weighted 0..1 score
//   decideDelivery(opportunity, context)    → { finalDelivery, interventionScore,
//                                              threshold, policyReason, suppressed }
//
// The model's deliveryRecommendation is advisory: this policy can only keep it
// or DOWNGRADE it (speak_now → visual_only → silent → discard), never upgrade.
// All limits come from preferences.js MODE_POLICIES + the speech gate — no
// model output can bypass them.

import { modePolicy } from './preferences.js';

const URGENCY_VALUE = { low: 0.2, medium: 0.6, high: 1 };
const TIME_VALUE = { immediate: 1, soon: 0.6, anytime: 0.3 };

// Weights are deliberately simple and visible — no learned/opaque scoring.
export const SCORE_WEIGHTS = { usefulness: 0.4, confidence: 0.25, urgency: 0.15, timeSensitivity: 0.1, novelty: 0.1 };

/**
 * @param {object} opportunity — validated opportunity (schema.js)
 * @param {{ isNovel?: boolean, recentShownCount?: number }} [context]
 */
export function scoreOpportunity(opportunity, { isNovel = true, recentShownCount = 0 } = {}) {
  const base =
    SCORE_WEIGHTS.usefulness * opportunity.usefulness
    + SCORE_WEIGHTS.confidence * opportunity.confidence
    + SCORE_WEIGHTS.urgency * (URGENCY_VALUE[opportunity.urgency] ?? 0.2)
    + SCORE_WEIGHTS.timeSensitivity * (TIME_VALUE[opportunity.timeSensitivity] ?? 0.3)
    + SCORE_WEIGHTS.novelty * (isNovel ? 1 : 0);
  // Interruption cost: each recently shown suggestion makes the next one
  // slightly harder to justify.
  const crowdingPenalty = Math.min(0.2, recentShownCount * 0.05);
  return Math.max(0, Math.min(1, +(base - crowdingPenalty).toFixed(3)));
}

const DELIVERY_RANK = { silent: 0, visual_only: 1, notification: 2, ask_permission: 2, speak_when_convenient: 3, speak_now: 4 };

// Suggestion categories that exist to help the WEARER during a live
// conversation — the ones the glasses-audio delivery preference governs.
// Planning/task proposals are deliberately excluded: lengthy proposals are
// never auto-spoken (they route through ask_permission instead).
const WEARER_ASSIST_TYPES = new Set([
  'conversation_coaching',
  'missing_information',
  'clarification_opportunity',
  'risk_or_concern',
  'general_assistance',
  'follow_up',
]);

function capDelivery(recommended, cap) {
  return (DELIVERY_RANK[recommended] ?? 1) <= (DELIVERY_RANK[cap] ?? 1) ? recommended : cap;
}

/**
 * Decide the final delivery for one validated opportunity. Deterministic.
 *
 * @param {object} opportunity
 * @param {{
 *   preferences: object,
 *   speechGate: { requestSpeech: Function },
 *   isDuplicate?: boolean,
 *   reactiveHandled?: boolean,   // the reactive agent is answering this same turn
 *   recentShownCount?: number,   // suggestions shown in the last minute
 *   someoneSpeaking?: boolean,
 *   expired?: boolean,
 * }} context
 * @returns {{ finalDelivery: string, interventionScore: number, threshold: number, policyReason: string, suppressed: boolean }}
 */
export function decideDelivery(opportunity, {
  preferences,
  speechGate,
  isDuplicate = false,
  reactiveHandled = false,
  recentShownCount = 0,
  someoneSpeaking = false,
  expired = false,
} = {}) {
  const mode = modePolicy(preferences);
  const score = scoreOpportunity(opportunity, { isNovel: !isDuplicate, recentShownCount });
  const decision = (finalDelivery, policyReason, suppressed = false) => ({
    finalDelivery, policyReason, suppressed, interventionScore: score, threshold: mode.scoreThreshold,
  });

  // ── hard discards (order matters) ──────────────────────────────────────────
  if (expired) return decision('discard', 'the useful moment has passed', true);
  if (isDuplicate) return decision('discard', 'duplicate of a recent suggestion', true);
  if (!preferences.proactiveAssistanceEnabled) return decision('discard', 'proactive assistance is disabled', true);
  if (opportunity.type === 'direct_response') {
    return decision('discard', 'direct responses belong to the reactive agent', true);
  }
  if (reactiveHandled && (opportunity.type === 'conversation_coaching' || opportunity.type === 'clarification_opportunity')) {
    return decision('discard', 'the reactive agent is already answering this turn', true);
  }
  if (opportunity.type === 'conversation_coaching' && !preferences.conversationCoachingEnabled) {
    return decision('discard', 'conversation coaching is disabled', true);
  }
  if ((opportunity.type === 'planning' || opportunity.type === 'task_proposal') && !preferences.planningSuggestionsEnabled) {
    return decision('discard', 'planning suggestions are disabled', true);
  }
  if (opportunity.backgroundTaskProposal && !mode.allowPlanningProposals) {
    return decision('discard', `${preferences.assistanceMode} mode does not surface planning proposals`, true);
  }
  if (opportunity.confidence < (preferences.minimumSuggestionConfidence ?? 0)) {
    return decision('discard', `confidence ${opportunity.confidence} below the user minimum ${preferences.minimumSuggestionConfidence}`, true);
  }
  if (score < mode.scoreThreshold) {
    return decision('discard', `intervention score ${score} below the ${preferences.assistanceMode}-mode threshold ${mode.scoreThreshold}`, true);
  }
  if (recentShownCount >= mode.maxVisiblePerMinute) {
    return decision('silent', `visible-suggestion budget for this minute is used up (${mode.maxVisiblePerMinute})`, true);
  }

  // ── delivery selection: recommendation can only be downgraded ──────────────
  if (opportunity.backgroundTaskProposal || opportunity.requiresPermission) {
    return decision('ask_permission', 'requires the user\'s approval before anything runs');
  }

  let recommended = opportunity.deliveryRecommendation;

  // ── glasses reframe: assistance the wearer never hears is assistance that
  // did not happen ───────────────────────────────────────────────────────────
  // Roma's output is a private near-ear speaker on the wearer's own glasses,
  // not a room speaker, so suggestions raised while a conversation is
  // happening are SPOKEN by default rather than shown silently.
  //
  // `conversationDelivery` is the user's deterministic preference and is
  // applied two ways:
  //   - always as the CEILING (a privacy-minded 'visual_only' still wins), and
  //   - as the TARGET when spoken suggestions are enabled, so a modest
  //     model recommendation does not silently downgrade help the user asked
  //     to hear.
  // This is NOT a model escalation — the model's own recommendation is never
  // used to raise delivery, and everything spoken still has to pass the
  // Speech Gate below (budget, cooldown, someone-speaking) and then wait for
  // a real conversational gap. A model that judged the item worthless
  // ('silent') is still respected.
  if (WEARER_ASSIST_TYPES.has(opportunity.type)) {
    const target = preferences.conversationDelivery ?? preferences.publicConversationSuggestions ?? 'visual_only';
    if (preferences.spokenSuggestionsEnabled && recommended !== 'silent') {
      // FLOOR only. Raise a modest recommendation up to the user's target so
      // useful help is actually heard — but never lower an urgent one: a real
      // risk warning that the model marked speak_now must not be made to wait
      // for a conversational gap.
      if ((DELIVERY_RANK[recommended] ?? 1) < (DELIVERY_RANK[target] ?? 1)) recommended = target;
    } else {
      recommended = capDelivery(recommended, target);
    }
  }

  if (recommended === 'speak_now' || recommended === 'speak_when_convenient') {
    const speech = speechGate.requestSpeech({
      prompted: false,
      preferences,
      urgent: opportunity.timeSensitivity === 'immediate' && opportunity.urgency === 'high',
      someoneSpeaking,
    });
    if (speech.approved) {
      return decision(recommended === 'speak_now' ? 'speak_now' : 'speak_when_convenient', speech.reason);
    }
    // Speech denied → fall back to the private UI, never to silence: the idea
    // was already judged useful enough to surface.
    return decision('visual_only', `speech denied by the speech gate (${speech.reason}); shown privately instead`);
  }

  if (recommended === 'silent') return decision('silent', 'useful for internal continuity only');
  if (recommended === 'notification') return decision('notification', 'useful but not time-critical; kept visible until reviewed');
  return decision('visual_only', 'shown privately in the Roma interface');
}
