// Memory Writer prompt + context assembly. Pure and provider-agnostic — same
// shape as agent/prompt.js (assembleContext), reused here for a completely
// separate concern: proposing STRUCTURED memory candidates from one bounded,
// already-completed interaction. This never sees the model's hidden reasoning
// and never receives the full memory database — only a short list of
// possibly-related existing memories for dedup/supersession decisions.

export const MEMORY_WRITER_SYSTEM_PROMPT = `You extract STRUCTURED, evidence-backed memories from one completed \
interaction between a user and an ambient assistant named Roma. You do not chat; you return exactly one JSON \
object: { "candidates": [...] } — zero or more proposed memory candidates.

Rules:
- Discard greetings, small talk, and anything with no plausible future value. Most turns produce ZERO candidates \
— that is the correct, expected result.
- Only propose "fact", "preference", "commitment", "goal", or "relationship" candidates when the evidence_type is \
user_stated, user_confirmed, user_corrected, other_speaker_stated, visually_observed, or tool_result. NEVER use \
evidence_type "roma_generated" for these types — Roma's own answers and suggestions are not evidence of what the \
user believes, wants, or agreed to. Roma's own text may only ever justify an "episode" candidate (a record of what \
happened), never a fact/preference/commitment/goal/relationship about the user.
- If AGENT'S RESPONSE contains a claim Roma made, do not treat it as confirmed unless the user actually agreed with \
it in the transcript.
- If EXISTING RELATED MEMORIES already contains a matching record (same subject and predicate), propose "merge" \
(strengthen the existing memory with new evidence) or "supersede" (the user is correcting or replacing it — set \
supersedes_memory_id to that record's memoryId) instead of "store" — never propose a duplicate.
- A correction ("actually...", "no, it's...", "that changed...") must use evidence_type "user_corrected" and action \
"supersede".
- Low-confidence guesses or single-observation inferences must use evidence_type "inferred" and a LOW confidence \
value (well under 0.6) — never present a guess with high confidence.
- summary must be a short, plain, human-readable sentence describing the memory — not chain-of-thought, not a \
transcript quote, not internal notes.
- reason_code must be a short snake_case operational label (e.g. "explicit_user_commitment", "filler_no_value", \
"duplicate_of_existing", "low_confidence_single_observation").
- Never invent a subject, predicate, or fact not actually present in the transcript, tool results, or visual context.
- Return exactly one JSON object matching the required schema — no other text.`;

function formatSegments(segments = []) {
  if (!segments.length) return '(none)';
  return segments.map((s) => `[${new Date(s.at).toISOString().slice(11, 19)}] ${s.speaker ?? 'Unknown speaker'}: ${s.text}`).join('\n');
}

function formatRelated(related = []) {
  if (!related.length) return '(none found)';
  return related
    .map((m) => `- ${m.memoryId} [${m.type}] ${m.subjectId}.${m.predicate} — "${m.summary}" (status: ${m.status}, confidence: ${m.confidence})`)
    .join('\n');
}

function formatToolResults(toolResults = []) {
  if (!toolResults.length) return '(none)';
  return toolResults.map((r) => (r.ok ? `${r.name}: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}` : `${r.name}: FAILED`)).join('\n');
}

/**
 * @param {{
 *   interactionPackage: {
 *     interactionId: string, transcriptSegments: Array, speakerId: string|null,
 *     sceneSnapshot: string, userText: string, agentResponse: string|null,
 *     toolResults: Array, explicitRequest?: boolean, explicitText?: string,
 *   },
 *   relatedMemories: Array,
 * }} input
 */
export function assembleExtractionContext({ interactionPackage, relatedMemories = [] }) {
  const pkg = interactionPackage;
  const body = [
    pkg.explicitRequest
      ? `The user EXPLICITLY asked Roma to remember something. Their exact request: "${pkg.explicitText}"`
      : 'This is an ordinary completed interaction — extract only if something is genuinely durable.',
    '',
    'RECENT TRANSCRIPT (most recent last):',
    formatSegments(pkg.transcriptSegments),
    '',
    'CURRENT SPEAKER:', pkg.speakerId ?? '(unknown)',
    '',
    "USER'S REQUEST/STATEMENT THIS TURN:", pkg.userText ?? '(none)',
    '',
    "AGENT'S RESPONSE THIS TURN (Roma's own words — not evidence of the user's beliefs):",
    pkg.agentResponse ?? '(none — no response was spoken)',
    '',
    'VISUAL CONTEXT (visually_observed evidence only, may be stale or generic):',
    pkg.sceneSnapshot || '(none available)',
    '',
    'TOOL RESULTS THIS INTERACTION:',
    formatToolResults(pkg.toolResults),
    '',
    'EXISTING RELATED MEMORIES (propose merge/supersede against these instead of duplicating):',
    formatRelated(relatedMemories),
    '',
    'Return exactly one JSON object: { "candidates": [...] } — no other text.',
  ].join('\n');

  return {
    system: MEMORY_WRITER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: body }],
  };
}
