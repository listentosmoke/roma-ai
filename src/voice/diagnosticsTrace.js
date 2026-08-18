// Development-only live-voice diagnostic trace. Pure function: merges the
// agent runtime's output events and the voice-delivery layer's events (both
// already bounded arrays exposed by useAgent/useVoiceDelivery — no new
// subscriptions needed) into one normalized, time-ordered, bounded list.
//
// Deliberately excludes: API keys (never present in these events), the full
// assembled model prompt (only short operational summaries/reason codes),
// hidden chain-of-thought (reason_summary/reasonCode are short classification
// labels, not private reasoning), and full transcript history (only the
// current turn's text is carried on each row).

const AGENT_KINDS = new Set(['addressee-decision', 'response', 'clarification', 'ignored-turn', 'error', 'engagement-exit', 'task-updated']);
const VOICE_KINDS = new Set([
  'authorized', 'awaiting-gap', 'tts-requested', 'tts-failed', 'spoken',
  'playback-started', 'playback-completed', 'playback-stopped', 'playback-blocked', 'playback-failed',
  'echo-suppressed', 'stop-command', 'barge-in', 'speech-discarded', 'speech-denied', 'speech-unsynthesizable',
  'stopped-all', 'delivery-error',
  // forwarded Turn Manager events (see delivery.js's turnManager.subscribe -> emit spread)
  'turn-started', 'turn-state', 'authorization-attached', 'turn-cancelled', 'turn-completed', 'turn-error', 'late-result-discarded',
]);

function agentRow(e) {
  const base = { at: e.at ?? 0, source: 'agent', kind: e.type, agentTurnId: e.turnId ?? null };
  switch (e.type) {
    case 'addressee-decision':
      return { ...base, transcriptId: e.transcriptId ?? null, speaker: e.speaker ?? null, text: e.text ?? null,
        decision: e.decision, addressedToRoma: e.addressedToRoma, confidence: e.confidence, reasonCode: e.reasonCode, engagementActive: e.engagementActive };
    case 'response':
    case 'clarification':
      return { ...base, text: e.text ?? null, reasonSummary: e.reasonSummary ?? null, spokenApproved: e.spokenApproved ?? null,
        speechReason: e.speechReason ?? null, authorizationId: e.authorizationId ?? null };
    case 'ignored-turn':
      return { ...base, reasonSummary: e.reasonSummary ?? null };
    case 'error':
      return { ...base, stage: e.stage ?? null, message: e.message ?? null };
    case 'engagement-exit':
      return { ...base, reason: e.reason ?? null };
    case 'task-updated':
      return { ...base, taskGoal: e.taskState?.goal ?? null };
    default:
      return base;
  }
}

function voiceRow(e) {
  const base = { at: e.at ?? 0, source: 'voice', kind: e.type, authorizationId: e.authorizationId ?? null, voiceTurnId: e.turnId ?? null };
  switch (e.type) {
    case 'authorized':
      return { ...base, sourceType: e.sourceType ?? null, delivery: e.delivery ?? null, unprompted: e.unprompted ?? null, policyReason: e.policyReason ?? null, text: e.text ?? null };
    case 'tts-requested':
      return { ...base, provider: e.provider ?? null, model: e.model ?? null, voice: e.voice ?? null };
    case 'tts-failed':
      return { ...base, code: e.code ?? null, message: e.message ?? null };
    case 'spoken':
      return { ...base, provider: e.provider ?? null, model: e.model ?? null, voice: e.voice ?? null, ttsLatencyMs: e.ttsLatencyMs ?? null };
    case 'playback-started':
      return { ...base, startLatencyMs: e.startLatencyMs ?? null };
    case 'playback-blocked':
      return { ...base, reason: e.reason ?? null };
    case 'echo-suppressed':
      return { ...base, similarity: e.similarity ?? null };
    case 'speech-discarded':
    case 'turn-cancelled':
      return { ...base, reason: e.reason ?? null };
    case 'speech-denied':
      return { ...base, reason: e.reason ?? null };
    case 'late-result-discarded':
      return { ...base, kind2: e.kind ?? null, totalDiscarded: e.totalDiscarded ?? null };
    case 'turn-state':
      return { ...base, state: e.state ?? null };
    case 'turn-started':
      return { ...base, turnSource: e.source ?? null };
    default:
      return base;
  }
}

/**
 * @param {Array<object>} agentEvents
 * @param {Array<object>} deliveryEvents
 * @param {{ limit?: number }} [options]
 * @returns {Array<object>} time-ordered, bounded trace rows
 */
export function buildDiagnosticTrace(agentEvents = [], deliveryEvents = [], { limit = 120 } = {}) {
  const rows = [];
  for (const e of agentEvents) if (AGENT_KINDS.has(e.type)) rows.push(agentRow(e));
  for (const e of deliveryEvents) if (VOICE_KINDS.has(e.type)) rows.push(voiceRow(e));
  rows.sort((a, b) => a.at - b.at);
  return rows.slice(-limit);
}
