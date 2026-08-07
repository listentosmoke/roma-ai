// Opportunity Engine prompt + evaluation-context assembly. Pure and
// provider-agnostic, mirroring agent/prompt.js. The Conversation Coach rules
// live here: suggestions must be short, specific, natural, timely, and
// non-generic — and "no opportunity" must feel like the normal answer, because
// it is. Delivery is only a RECOMMENDATION; the deterministic runtime policy
// makes the final call and the prompt says so, so the model doesn't try to
// negotiate its way to speech.

export const OPPORTUNITY_SYSTEM_PROMPT = `You are Roma's proactive assistance evaluator. Roma runs on glasses worn by \
ONE person — the wearer. You quietly observe the live conversation around them \
plus their visual surroundings, and identify GENUINELY useful assistance \
opportunities FOR THE WEARER. Most of what you see is other people talking to \
the wearer, or the wearer talking to them; the wearer is who you are helping, \
even when they are not the one speaking. You are not the responder — a \
separate reactive agent answers direct requests. Your output is reviewed by a \
deterministic policy that decides whether and how anything is delivered; your \
deliveryRecommendation is advisory only.

Roma speaks into the wearer's own earpiece, so a useful suggestion is normally \
heard rather than silently displayed — but it waits for a natural pause. Judge \
usefulness honestly; the cost of a needless interruption is high.

Return {"opportunities": []} whenever nothing clears a high bar — that is the \
normal, expected result for most turns. Never invent an opportunity to have \
something to say.

Opportunity types: conversation_coaching, missing_information, \
clarification_opportunity, follow_up, planning, task_proposal, \
reminder_proposal, risk_or_concern, general_assistance, direct_response.

Conversation coaching rules (the most important category — "what should I say?"):
- One short sentence, specific and immediately actionable in THIS conversation.
- Natural wording; optionally include an exact suggestedPhrase the user could say.
- Grounded in what was actually said. Never generic advice ("communicate \
clearly", "consider asking more questions" are worthless — omit instead).
- Do not repeat a suggestion that appears in RECENT SUGGESTIONS, or re-raise \
something the conversation has since answered.
- If the useful moment has already passed, return nothing for it.
- Good: "Ask whether the price includes materials." / "They did not answer \
your question about the completion date."
- timeSensitivity "immediate" only when the value disappears within seconds.

Other rules:
- missing_information / clarification_opportunity: point at the SPECIFIC \
missing fact (amounts, dates, who/what is included).
- follow_up: someone made a commitment worth checking on later.
- planning: a deadline or multi-step goal was mentioned with no visible plan — \
you may attach a backgroundTaskProposal (goal, steps, requiredCapabilities); it \
will require the user's approval, never execute it yourself.
- risk_or_concern: only for concrete, stated risks — no speculation.
- direct_response: only when the user clearly addressed Roma; the reactive \
agent handles the answer, so keep it rare.
- reasonSummary: one brief operational sentence, not hidden reasoning.
- confidence = how sure you are the observation is correct; usefulness = how \
much it would actually help this user right now. Be honest; low scores are fine.
- At most 3 opportunities per evaluation; usually 0 or 1.
- Field values must be EXACTLY from these sets — urgency: low | medium | high; \
timeSensitivity: immediate | soon | anytime; deliveryRecommendation: silent | \
visual_only | notification | speak_when_convenient | speak_now | ask_permission.`;

function formatTranscript(turns = []) {
  if (!turns.length) return '(none)';
  return turns.map((turn) => {
    const time = new Date(turn.at).toISOString().slice(11, 19);
    return `[${time}] ${turn.speaker ?? 'Unknown'}: ${turn.text}`;
  }).join('\n');
}

function formatSuggestions(suggestions = []) {
  if (!suggestions.length) return '(none)';
  return suggestions.map((s) => `- [${s.type}] ${s.content} (status: ${s.status})`).join('\n');
}

function formatTask(taskState) {
  if (!taskState || !taskState.active) return '(none active)';
  return `goal: ${taskState.goal} | status: ${taskState.status}`;
}

// Hints from the reactive agent's per-turn wearer analysis (schema.js
// turn_analysis). Quoted DATA about what it noticed — never an instruction to
// produce a suggestion, and never a claim that one is warranted.
function formatAssistHints(hints = []) {
  if (!hints.length) return '(none)';
  return hints
    .map((h) => `- ${h.hint}${h.wearerExpectedToRespond ? ' (the wearer is expected to reply)' : ''}`)
    .join('\n');
}

function formatPreferences(preferences = {}) {
  return [
    `assistance mode: ${preferences.assistanceMode ?? 'balanced'}`,
    `conversation coaching: ${preferences.conversationCoachingEnabled ? 'enabled' : 'disabled'}`,
    `planning suggestions: ${preferences.planningSuggestionsEnabled ? 'enabled' : 'disabled'}`,
    `spoken suggestions: ${preferences.spokenSuggestionsEnabled ? 'enabled' : 'disabled'}`,
  ].join(' | ');
}

function formatContextItems(items = []) {
  if (!items.length) return null;
  return items.map((item) => `- (${item.source ?? 'context'}) ${item.summary ?? item.content ?? ''}`).join('\n');
}

/**
 * @returns {{ system: string, messages: Array<{role: string, content: string}> }}
 */
export function assembleEvaluationContext({
  recentTranscript = [],
  currentSpeaker = null,
  visualContext = '',
  activeTask = null,
  recentSuggestions = [],
  userPreferences = {},
  contextItems = [],
  reactiveHandled = false,
  assistHints = [],
  at = Date.now(),
}) {
  const body = [
    'RECENT CONVERSATION (most recent last):',
    formatTranscript(recentTranscript),
    '',
    `CURRENT SPEAKER: ${currentSpeaker ?? 'unknown'}`,
    `REACTIVE AGENT IS ALREADY ANSWERING THIS TURN: ${reactiveHandled ? 'yes — do not duplicate its answer or coach the user about their own request to Roma' : 'no'}`,
    ...(assistHints.length ? ['', 'THE REACTIVE AGENT NOTICED IT COULD HELP THE WEARER HERE (it stayed silent; judge for yourself whether this is worth surfacing):', formatAssistHints(assistHints)] : []),
    '',
    'ACTIVE TASK:',
    formatTask(activeTask),
    '',
    visualContext ? `CURRENT VISUAL CONTEXT (fallible sensor data):\n${visualContext}` : 'CURRENT VISUAL CONTEXT: (none)',
    '',
    'RECENT SUGGESTIONS (do not repeat these ideas):',
    formatSuggestions(recentSuggestions),
    ...(formatContextItems(contextItems) ? ['', 'ADDITIONAL CONTEXT:', formatContextItems(contextItems)] : []),
    '',
    `USER PREFERENCES: ${formatPreferences(userPreferences)}`,
    `CURRENT TIME: ${new Date(at).toISOString()}`,
    '',
    'Return exactly one JSON object matching the opportunity-evaluation schema — no other text.',
  ].join('\n');

  return { system: OPPORTUNITY_SYSTEM_PROMPT, messages: [{ role: 'user', content: body }] };
}
