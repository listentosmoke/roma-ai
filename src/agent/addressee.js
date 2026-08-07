// Addressee normalization — a small, pure, deterministic overlay on top of the
// agent's own decision. The MODEL still makes the only semantic judgment call
// (ignore / respond / clarify / tool_call / inspect_vision / update_task); this
// module never changes that outcome. It only computes OBSERVABLE metadata about
// *why* a turn was or wasn't treated as addressed to Roma, so the behavior can be
// inspected and tested instead of living only inside an opaque prompt.
//
// confidence and reasonCode are deterministic heuristics computed from features
// available outside the model (wake-word presence, active-engagement window) —
// they are NOT a probability reported by the model (the decision schema has no
// such field) and must never be presented as the model's hidden reasoning.

export const ADDRESSEE_OUTCOMES = ['respond', 'clarify', 'ignore'];

export const ADDRESSEE_REASON_CODES = [
  'wake_word_direct_address', // wake word present and the model engaged
  'engagement_continuation', // no wake word, but an active interaction window covered it
  'direct_address_inferred', // model engaged with neither signal present (semantic-only call)
  'ambient_conversation', // ignored; no wake word, no active engagement
  'ambient_during_engagement', // ignored despite an active window (e.g. someone else spoke)
  'wake_word_but_not_a_request', // wake word present, but the model judged it not a request
  // ── wearer-centered codes (glasses reframe) ────────────────────────────────
  // Roma stayed out of the conversation, but the turn was NOT irrelevant: it
  // was aimed at the person wearing the glasses. These distinguish "silent
  // because nothing was happening" from "silent because it was the wearer's
  // conversation, not mine" — the second case is where private assistance
  // belongs.
  'addressed_to_wearer', // someone spoke to the wearer; Roma did not answer for them
  'wearer_reply_expected', // ...and the wearer is now expected to respond
  'third_party_conversation', // other people talking to each other
  'wearer_speaking', // the wearer themselves was talking (not to Roma)
];

const WAKE_WORD_RE = /\broma\b/i;

export function hasWakeWord(text) {
  return WAKE_WORD_RE.test(String(text ?? ''));
}

// Internal decisions collapse to exactly one of the three allowed outcomes:
// tool_call/inspect_vision never reach here (runtime resolves them to a final
// decision before this is computed); update_task (silent) has no spoken output,
// so it is treated as 'ignore' for addressee purposes (nothing was said aloud),
// though it still reflects an intentional instruction from the user.
function normalizeOutcome(internalDecision) {
  if (internalDecision === 'respond' || internalDecision === 'clarify') return internalDecision;
  return 'ignore';
}

/**
 * @param {{
 *   text: string,
 *   decision: string,
 *   engagementActive: boolean,
 *   turnAnalysis?: { speakerRole?: string, addressedTo?: string, wearerExpectedToRespond?: boolean, assistOpportunity?: string|null },
 * }} input
 * @returns {{ decision: 'respond'|'clarify'|'ignore', addressedToRoma: boolean, confidence: number, reasonCode: string, addressedTo: string, speakerRole: string, wearerExpectedToRespond: boolean, assistOpportunity: string|null }}
 */
export function classifyAddressee({ text, decision, engagementActive = false, turnAnalysis = null }) {
  const outcome = normalizeOutcome(decision);
  const wakeWord = hasWakeWord(text);
  const engaged = outcome === 'respond' || outcome === 'clarify';
  const analysis = {
    speakerRole: turnAnalysis?.speakerRole ?? 'unknown',
    addressedTo: turnAnalysis?.addressedTo ?? 'unclear',
    wearerExpectedToRespond: turnAnalysis?.wearerExpectedToRespond === true,
    assistOpportunity: turnAnalysis?.assistOpportunity ?? null,
  };
  const decorate = (record) => ({ ...record, ...analysis });

  if (engaged) {
    if (wakeWord) return decorate({ decision: outcome, addressedToRoma: true, confidence: 0.95, reasonCode: 'wake_word_direct_address' });
    if (engagementActive) return decorate({ decision: outcome, addressedToRoma: true, confidence: 0.85, reasonCode: 'engagement_continuation' });
    return decorate({ decision: outcome, addressedToRoma: true, confidence: 0.7, reasonCode: 'direct_address_inferred' });
  }

  // outcome === 'ignore' — Roma said nothing. WHY it said nothing is what the
  // wearer-centered codes capture: the model's own turn_analysis takes
  // precedence over the older wake-word/engagement heuristics, because it is
  // the only signal that knows who was being spoken to.
  if (analysis.addressedTo === 'wearer' || analysis.addressedTo === 'group') {
    const reasonCode = analysis.wearerExpectedToRespond ? 'wearer_reply_expected' : 'addressed_to_wearer';
    return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.9, reasonCode });
  }
  // The wearer talking is checked BEFORE the generic third-party case: "the
  // person I'm helping is saying something" is more specific — and more useful
  // to the assist layer — than "people are talking near me".
  if (analysis.speakerRole === 'wearer' && analysis.addressedTo !== 'roma') {
    return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.8, reasonCode: 'wearer_speaking' });
  }
  if (analysis.addressedTo === 'another_person') {
    return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.9, reasonCode: 'third_party_conversation' });
  }
  if (wakeWord) return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.6, reasonCode: 'wake_word_but_not_a_request' });
  if (engagementActive) return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.8, reasonCode: 'ambient_during_engagement' });
  return decorate({ decision: 'ignore', addressedToRoma: false, confidence: 0.95, reasonCode: 'ambient_conversation' });
}
