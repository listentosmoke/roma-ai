// Direct-address guard — the deterministic backstop for "Roma answers when
// Roma is asked".
//
// WHY THIS EXISTS. The glasses reframe taught the model that most speech it
// hears is not for it. That is correct and necessary, but it also made the
// model occasionally ignore turns that plainly WERE for it — including
// wake-word requests and follow-ups inside an active interaction. Being asked
// and staying silent is the one failure mode a wearable assistant cannot have,
// so it does not stay a matter of model judgment alone.
//
// WHAT THIS DOES NOT DO. It never fabricates an answer, never chooses what to
// say, and never bypasses the Speech Gate. It only detects a decision that
// contradicts observable, deterministic facts and asks the model ONCE more,
// with the contradiction stated plainly. If the model ignores again, that
// stands — a second refusal is treated as a real judgment (the user may have
// said "Roma" while talking about the weather).
//
// This mirrors how the rest of the system already works: the model proposes,
// deterministic code checks it against facts it cannot see or fake.

/** Decisions that mean Roma actually engaged with the turn. */
const ENGAGED_DECISIONS = new Set(['respond', 'clarify', 'tool_call', 'inspect_vision']);

export const DIRECT_ADDRESS_REASONS = ['wake_word_ignored', 'engagement_follow_up_ignored', 'analysis_contradicts_decision', 'engineering_work_not_dispatched'];

// Phrases that describe work Roma physically cannot do itself: reading a
// codebase, running tests, touching a database, debugging. Matching one is NOT
// a decision — it only triggers a SECOND LOOK, exactly as the wake word does
// for direct address. The model still decides whether to dispatch, and a
// considered refusal stands. This exists because the live conversational model
// is small and must choose among ~30 tools; missing a dispatch means the
// wearer is told a job is happening when nothing is running, which is the one
// outcome worse than saying "I can't".
const ENGINEERING_WORK_RE = /\b(run|running|rerun) (the )?(tests?|test suite|build|migration)|\b(fix|debug|investigate|profile|refactor|implement) (the |that |this )?\w+|\btest suite\b|\bunit tests?\b|\bthe (code|codebase|repo|repository|database|migration|build)\b|\bquery the (database|db)\b|\bcheck (the )?(logs?|database|db|tests?)\b/i;

// Only tools that actually START or STOP work count as handling the request.
// `check_task_status` deliberately does NOT: the model calling it and then
// answering means it looked at existing tasks instead of starting the one the
// wearer asked for — exactly the case this check exists to catch (observed in
// a lab run, 2026-07-29).
const TASK_TOOL_NAMES = new Set(['dispatch_server_task', 'answer_task_question', 'cancel_server_task']);

/**
 * Did the wearer ask for engineering work that was never handed to the server
 * agent? Only applies when the turn was aimed at Roma and no task tool ran.
 */
export function checkEngineeringDispatch({ decision, text, toolResults = [] } = {}) {
  const outcome = decision?.decision;
  if (outcome !== 'respond' && outcome !== 'clarify') return { inconsistent: false, reasonCode: null, evidence: null };
  if (decision?.turnAnalysis?.addressedTo && decision.turnAnalysis.addressedTo !== 'roma') return { inconsistent: false, reasonCode: null, evidence: null };
  if (toolResults.some((result) => TASK_TOOL_NAMES.has(result?.name))) return { inconsistent: false, reasonCode: null, evidence: null };
  if (!ENGINEERING_WORK_RE.test(String(text ?? ''))) return { inconsistent: false, reasonCode: null, evidence: null };
  return {
    inconsistent: true,
    reasonCode: 'engineering_work_not_dispatched',
    evidence: 'the wearer appears to be asking for engineering work (code, tests, database, or debugging) but no background task was started',
  };
}

/**
 * Does this decision contradict deterministic evidence that the turn was for Roma?
 *
 * @param {{
 *   decision: { decision: string, turnAnalysis?: { addressedTo?: string } },
 *   text: string,
 *   hasWakeWord: boolean,
 *   engagementActive: boolean,
 * }} input
 * @returns {{ inconsistent: boolean, reasonCode: string|null, evidence: string|null }}
 */
export function checkDirectAddress({ decision, hasWakeWord = false, engagementActive = false } = {}) {
  const outcome = decision?.decision;
  // Only a bare `ignore` can be inconsistent. `update_task` is a deliberate
  // silent action, and every engaged decision already answers the turn.
  if (outcome !== 'ignore') return { inconsistent: false, reasonCode: null, evidence: null };

  // The model's own analysis says the turn was aimed at Roma, yet it chose to
  // do nothing. That is self-contradictory regardless of the other signals.
  if (decision?.turnAnalysis?.addressedTo === 'roma') {
    return {
      inconsistent: true,
      reasonCode: 'analysis_contradicts_decision',
      evidence: 'you recorded addressed_to="roma" but chose to ignore the turn',
    };
  }

  if (hasWakeWord) {
    return {
      inconsistent: true,
      reasonCode: 'wake_word_ignored',
      evidence: 'the wearer said your name in this turn',
    };
  }

  if (engagementActive) {
    return {
      inconsistent: true,
      reasonCode: 'engagement_follow_up_ignored',
      evidence: 'you and the wearer are mid-conversation (an interaction window is open), so a follow-up does not need your name',
    };
  }

  return { inconsistent: false, reasonCode: null, evidence: null };
}

/**
 * The correction appended to the retry's context. Deliberately states the
 * contradiction and the two legitimate outcomes — it does NOT tell the model
 * what to say, and it explicitly preserves the model's right to ignore again
 * when the mention genuinely was not a request.
 */
export function buildCorrectionNote(evidence) {
  return [
    'DIRECT-ADDRESS CHECK (deterministic, from the system — not from a person):',
    `Your previous decision for this same turn was "ignore", but ${evidence}.`,
    'Reconsider this one turn. If it is a request, a question, or a follow-up meant for you — including a request to remember, recall, correct, or forget something — answer it (respond/clarify) or call the appropriate tool.',
    'If it genuinely was not meant for you (for example your name appeared while people were talking about you, or someone else was being addressed), answer "ignore" again and say so in reason_summary. Do not invent a response to satisfy this check.',
  ].join('\n');
}

/** The correction appended when engineering work looks undispatched. Same discipline: it never dictates an answer. */
export function buildDispatchCorrectionNote(evidence) {
  return [
    'DISPATCH CHECK (deterministic, from the system — not from a person):',
    `You answered directly, but ${evidence}.`,
    'You cannot read code, run tests, query databases, or debug anything yourself. If this really is such a job, call dispatch_server_task now and tell the wearer it has started — do not describe the work as though you had done it.',
    'If it is genuinely something you can answer from what you already know, or it is not an engineering job at all, keep your answer and say why in reason_summary. Do not start a task just to satisfy this check.',
  ].join('\n');
}

/** True when a re-inferred decision actually resolved the contradiction. */
export function correctionSucceeded(decision) {
  return ENGAGED_DECISIONS.has(decision?.decision);
}
