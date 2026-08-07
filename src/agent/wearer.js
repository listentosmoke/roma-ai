// Wearer resolution — WHO is wearing the glasses, decided deterministically in
// code, never by the model.
//
// Roma's microphone and camera are worn by one person. That person is the
// center of every interaction: other people mostly speak TO them, not to Roma.
// Knowing which diarized speaker label is the wearer is what lets the rest of
// the system tell "someone is asking the wearer a question" apart from
// "someone is asking Roma a question" apart from "two other people are
// talking".
//
// Evidence, strongest first:
//   1. `confirmed`  — the identity subsystem has a person record whose role
//                     includes 'wearer' and the resolver mapped this session's
//                     speaker label to that person.
//   2. `assumed`    — no identity evidence, but one label dominates close-mic
//                     speech: the wearer's own voice hits the glasses mic
//                     loudest and most often. A label must clear BOTH a share
//                     threshold and a minimum sample count before it is
//                     assumed, so a single loud sentence from a stranger never
//                     captures the wearer slot.
//   3. `unknown`    — not enough evidence. Downstream must treat the wearer as
//                     unresolved rather than guessing (mirrors the identity
//                     subsystem's ambiguous-speaker discipline).
//
// This module is pure (no browser/Node globals, injected clock) so the runtime,
// tests, and the virtual lab all exercise the same code.

export const WEARER_CONFIDENCE = ['confirmed', 'assumed', 'unknown'];

const DEFAULT_OPTIONS = {
  minSamples: 3, // observed turns before a label may be assumed
  // Clear majority of close-mic turns, not a bare plurality: an even two-way
  // conversation must resolve to "unknown" rather than coin-flipping a wearer.
  // The level filter below already restricts this to close speech, where the
  // wearer's own voice genuinely dominates.
  minShare: 0.6,
  windowSize: 40, // bounded observation ring
  minLevelForClose: 0.12, // mic level above which a turn counts as "close"
};

export function createWearerResolver(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const observations = []; // { speaker, level, at } bounded ring
  let confirmed = null; // { speaker, personId, displayName }
  let named = null; // { speaker, personId, displayName } — a name for an already-resolved wearer

  function record({ speaker, level = null, at = Date.now() }) {
    if (!speaker) return;
    observations.push({ speaker, level: typeof level === 'number' ? level : null, at });
    while (observations.length > config.windowSize) observations.shift();
  }

  /** Explicit, auditable: the identity subsystem resolved this label to the wearer person record. */
  function confirm({ speaker, personId, displayName = null }) {
    if (!speaker || !personId) return false;
    confirmed = { speaker, personId, displayName };
    return true;
  }

  /**
   * Attach a name to the speaker we ALREADY believe is the wearer.
   *
   * This never promotes anyone: if the wearer is unknown, or this label is not
   * the wearer, nothing happens. It exists because the identity subsystem
   * resolves speaker labels to person records independently, and knowing the
   * wearer is called "Alex" is what lets Roma understand that "Hey Alex, can
   * you…" is aimed at a person rather than at itself.
   */
  function nameWearer({ speaker, personId = null, displayName = null }) {
    if (!speaker || !displayName) return false;
    const current = resolve();
    if (current.confidence === 'unknown' || current.speaker !== speaker) return false;
    named = { speaker, personId, displayName };
    return true;
  }

  function clearConfirmation() { confirmed = null; }

  function assumedSpeaker() {
    const close = observations.filter((o) => o.level === null || o.level >= config.minLevelForClose);
    if (close.length < config.minSamples) return null;
    const counts = new Map();
    for (const observation of close) counts.set(observation.speaker, (counts.get(observation.speaker) ?? 0) + 1);
    let best = null;
    for (const [speaker, count] of counts) {
      if (!best || count > best.count) best = { speaker, count };
    }
    if (!best) return null;
    return best.count / close.length >= config.minShare ? best.speaker : null;
  }

  /**
   * @returns {{ speaker: string|null, confidence: 'confirmed'|'assumed'|'unknown', personId: string|null, displayName: string|null }}
   */
  function resolve() {
    if (confirmed) return { speaker: confirmed.speaker, confidence: 'confirmed', personId: confirmed.personId, displayName: confirmed.displayName };
    const assumed = assumedSpeaker();
    if (assumed) {
      // A name learned from identity applies only to the SAME label we still
      // believe is the wearer — it never survives the wearer changing.
      const nameMatches = named && named.speaker === assumed;
      return {
        speaker: assumed,
        confidence: 'assumed',
        personId: nameMatches ? named.personId : null,
        displayName: nameMatches ? named.displayName : null,
      };
    }
    return { speaker: null, confidence: 'unknown', personId: null, displayName: null };
  }

  /** Is this speaker label the wearer? `null` when the wearer is unresolved — callers must not treat that as "no". */
  function isWearer(speaker) {
    const current = resolve();
    if (current.confidence === 'unknown' || !speaker) return null;
    return current.speaker === speaker;
  }

  return {
    record,
    confirm,
    nameWearer,
    clearConfirmation,
    resolve,
    isWearer,
    observationCount: () => observations.length,
    reset() { observations.length = 0; confirmed = null; named = null; },
  };
}

/**
 * Render the wearer block for context assembly. Returns '' when nothing is
 * known — the prompt then explicitly says the wearer is unidentified rather
 * than inventing one.
 */
export function formatWearerContext(state) {
  if (!state || state.confidence === 'unknown') {
    return 'WEARER: unidentified so far (you cannot yet tell which voice belongs to the person wearing the glasses).';
  }
  const name = state.displayName ? ` (${state.displayName})` : '';
  const qualifier = state.confidence === 'confirmed'
    ? 'confirmed by identity evidence'
    : 'assumed from close-microphone speech — treat as likely, not certain';
  return `WEARER: ${state.speaker}${name} — ${qualifier}.`;
}
