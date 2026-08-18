// Deterministic Speech Gate — the ONLY component that can authorize speech.
// Models (reactive agent or Opportunity Engine) may recommend speaking; this
// gate makes the final call with plain code: budgets, cooldowns, and user
// preferences that no model output can bypass.
//
// Both paths share ONE gate instance:
//   - reactive agent direct answers   → requestSpeech({ prompted: true })
//   - proactive/unsolicited output    → requestSpeech({ prompted: false, ... })
//
// Prompted speech (the user addressed Roma) is allowed when the user enables
// it, and is intentionally not charged against the unprompted budget.

import { SPEECH_BUDGET } from './preferences.js';

export function createSpeechGate({
  maxUnpromptedPerMinute = SPEECH_BUDGET.maxUnpromptedPerMinute,
  minMsBetweenSpoken = SPEECH_BUDGET.minMsBetweenSpoken,
  now = Date.now,
} = {}) {
  const spokenAt = []; // unprompted approvals, epoch ms
  let lastSpokenAt = 0; // any approval (prompted or not)

  function withinBudget(at) {
    const cutoff = at - 60000;
    while (spokenAt.length && spokenAt[0] < cutoff) spokenAt.shift();
    return spokenAt.length < maxUnpromptedPerMinute;
  }

  return {
    /**
     * @param {{ prompted?: boolean, preferences?: object, urgent?: boolean, someoneSpeaking?: boolean }} request
     * @returns {{ approved: boolean, reason: string }}
     */
    requestSpeech({ prompted = false, preferences = {}, urgent = false, someoneSpeaking = false } = {}) {
      const at = now();

      if (prompted) {
        if (preferences.directAnswersMaySpeak === false) return { approved: false, reason: 'direct spoken answers are disabled in preferences' };
        lastSpokenAt = at;
        return { approved: true, reason: 'user directly addressed Roma' };
      }

      // Unsolicited speech: every condition below is deterministic policy.
      if (!preferences.spokenSuggestionsEnabled) return { approved: false, reason: 'spoken suggestions are disabled in preferences' };
      if (someoneSpeaking) return { approved: false, reason: 'someone is currently speaking' };
      if (at - lastSpokenAt < minMsBetweenSpoken) return { approved: false, reason: `Roma spoke less than ${Math.round(minMsBetweenSpoken / 1000)}s ago` };
      if (!withinBudget(at)) return { approved: false, reason: 'unprompted speech budget for this minute is used up' };
      if (!urgent) return { approved: false, reason: 'suggestion is not time-critical enough to speak unprompted' };

      spokenAt.push(at);
      lastSpokenAt = at;
      return { approved: true, reason: 'time-critical suggestion within the speech budget' };
    },

    stats: () => ({ unpromptedLastMinute: spokenAt.length, lastSpokenAt }),
  };
}
