// Deterministic stop-phrase detection. When the user says "stop", "be quiet",
// "never mind", etc. while Roma is thinking / waiting to speak / synthesizing /
// speaking, we cancel IMMEDIATELY — without waiting for a full LLM inference.
// The phrase can still be forwarded to the reactive agent afterward if more
// interpretation is warranted.

import { DEFAULT_STOP_PHRASES } from './config.js';

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the utterance is (or clearly starts with) a stop command. We match
 * short utterances exactly and also catch a leading "roma, stop" / "stop talking
 * please". We intentionally do NOT match "stop" buried mid-sentence in a long
 * turn ("...don't stop the car...") to avoid false cancellation.
 *
 * @param {string} text
 * @param {string[]} [phrases]
 */
export function isStopPhrase(text, phrases = DEFAULT_STOP_PHRASES) {
  const normalized = normalize(text);
  if (!normalized) return false;
  // Strip a leading wake-word address so "roma stop" counts.
  const stripped = normalized.replace(/^(roma|hey roma|ok roma)\s+/, '');
  const candidates = [normalized, stripped];

  for (const candidate of candidates) {
    for (const phrase of phrases) {
      const p = normalize(phrase);
      if (!p) continue;
      if (candidate === p) return true;
      // "stop talking please", "stop now", "cancel that" — a short utterance that
      // BEGINS with the phrase (guard against long unrelated sentences).
      if (candidate.startsWith(`${p} `) && candidate.split(' ').length <= p.split(' ').length + 2) return true;
    }
  }
  return false;
}
