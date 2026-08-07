// User-configurable assistance preferences + assistance-mode interpretations.
// Follows the repo's local-config pattern (module defaults), with optional
// localStorage persistence in the browser — no account system.
//
// The MODE_POLICIES table is the deterministic interpretation of quiet /
// balanced / proactive: score thresholds and rate limits the model can never
// override. "Proactive" means a lower bar and more visual suggestions — NOT
// more speech; unsolicited speech stays separately controlled by
// spokenSuggestionsEnabled + the speech budget.

export const ASSISTANCE_MODES = ['quiet', 'balanced', 'proactive'];

export const DEFAULT_PREFERENCES = {
  proactiveAssistanceEnabled: true,
  conversationCoachingEnabled: true,
  planningSuggestionsEnabled: true,
  // Glasses reframe: Roma speaks into the wearer's own near-ear speaker, which
  // is private in a way a room speaker is not. Assistance the wearer cannot
  // hear is assistance that did not happen — so spoken suggestions are ON by
  // default. Every hard limit still applies: the deterministic Speech Gate
  // owns the budget (1 unprompted/minute, >=20s spacing) and the Gap Detector
  // waits for a real pause, so "spoken" never means "interrupts".
  spokenSuggestionsEnabled: true,
  directAnswersMaySpeak: true,
  // Delivery target for suggestions raised while a conversation is happening
  // around the wearer. Acts as the ceiling always, and (when spoken
  // suggestions are enabled) as the deterministic target — see policy.js.
  // Set to 'visual_only' for a fully silent posture.
  conversationDelivery: 'speak_when_convenient',
  assistanceMode: 'balanced',
  minimumSuggestionConfidence: 0.78,
  // Selective Voice Delivery: genuine user speech during Roma's playback stops it.
  bargeInEnabled: true,
};

// Older stored preferences (and older tests) used publicConversationSuggestions
// for the same knob. Read it as conversationDelivery so an existing profile
// keeps its chosen posture instead of silently gaining speech.
export function normalizePreferences(preferences = {}) {
  const merged = { ...DEFAULT_PREFERENCES, ...preferences };
  if (preferences.conversationDelivery === undefined && typeof preferences.publicConversationSuggestions === 'string') {
    merged.conversationDelivery = preferences.publicConversationSuggestions;
  }
  return merged;
}

// Deterministic per-mode policy (enforced in policy.js, never by the model).
export const MODE_POLICIES = {
  quiet: {
    scoreThreshold: 0.9,
    maxVisiblePerMinute: 1,
    allowPlanningProposals: false, // direct responses + very rare high-value only
  },
  balanced: {
    scoreThreshold: 0.72,
    maxVisiblePerMinute: 4,
    allowPlanningProposals: true,
  },
  proactive: {
    scoreThreshold: 0.55,
    maxVisiblePerMinute: 8,
    allowPlanningProposals: true,
  },
};

// Speech budget — hard limits on unsolicited speech regardless of mode.
export const SPEECH_BUDGET = {
  maxUnpromptedPerMinute: 1,
  minMsBetweenSpoken: 20000,
  maxActiveSuggestions: 5,
};

const STORAGE_KEY = 'roma.assistancePreferences';

export function loadPreferences() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFERENCES };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return normalizePreferences(stored ?? {});
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch { /* storage may be unavailable */ }
}

export function modePolicy(preferences) {
  return MODE_POLICIES[preferences?.assistanceMode] ?? MODE_POLICIES.balanced;
}
