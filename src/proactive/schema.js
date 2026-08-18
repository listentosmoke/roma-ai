// Opportunity Engine output schema + validation. Pure and dependency-free, same
// discipline as agent/schema.js: the strict-mode JSON schema is handed to the
// model provider, and validateOpportunities() is the single gate every provider
// output (including mocks) passes through. Invalid opportunities are dropped —
// they can never trigger speech or external action.
//
// IMPORTANT: the model only PROPOSES. `deliveryRecommendation`, `urgency`, etc.
// are inputs to the deterministic intervention policy (policy.js), which makes
// the final call — a model recommendation of "speak_now" carries no authority.

export const OPPORTUNITY_TYPES = [
  'conversation_coaching',
  'missing_information',
  'clarification_opportunity',
  'follow_up',
  'planning',
  'task_proposal',
  'reminder_proposal',
  'risk_or_concern',
  'general_assistance',
  'direct_response',
];

export const DELIVERY_MODES = ['silent', 'visual_only', 'notification', 'speak_when_convenient', 'speak_now', 'ask_permission'];
export const URGENCY_LEVELS = ['low', 'medium', 'high'];
export const TIME_SENSITIVITIES = ['immediate', 'soon', 'anytime'];

export const MAX_OPPORTUNITIES_PER_EVALUATION = 3;
const MAX_CONTENT_CHARS = 240;
const MAX_REASON_CHARS = 240;
const MAX_ENTITIES = 8;
const MAX_STEPS = 8;
const DEFAULT_EXPIRES_MS = 20000;
const MAX_EXPIRES_MS = 10 * 60 * 1000;

// Strict structured-output mode forbids free-form maps, so open key/value data
// travels as {name, value} pair arrays (same convention as agent/schema.js).
const KEY_VALUE_PAIRS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
};

export const OPPORTUNITY_EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    opportunities: {
      type: 'array',
      description: `At most ${MAX_OPPORTUNITIES_PER_EVALUATION} genuinely useful opportunities; an empty array is the normal result.`,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: OPPORTUNITY_TYPES },
          content: { type: 'string', description: 'One short, specific, immediately useful sentence.' },
          suggestedPhrase: { type: ['string', 'null'], description: 'Optional exact phrase the user could say.' },
          confidence: { type: 'number' },
          usefulness: { type: 'number' },
          urgency: { type: 'string', enum: URGENCY_LEVELS },
          timeSensitivity: { type: 'string', enum: TIME_SENSITIVITIES },
          reasonSummary: { type: 'string', description: 'Brief operational reason — not chain-of-thought.' },
          relatedEntities: KEY_VALUE_PAIRS,
          deliveryRecommendation: { type: 'string', enum: DELIVERY_MODES },
          expiresInMs: { type: ['number', 'null'] },
          requiresPermission: { type: 'boolean' },
          backgroundTaskProposal: {
            type: ['object', 'null'],
            properties: {
              goal: { type: 'string' },
              category: { type: 'string' },
              reason: { type: 'string' },
              estimatedSteps: { type: 'array', items: { type: 'string' } },
              requiredCapabilities: { type: 'array', items: { type: 'string' } },
            },
            required: ['goal', 'category', 'reason', 'estimatedSteps', 'requiredCapabilities'],
            additionalProperties: false,
          },
        },
        required: [
          'type', 'content', 'suggestedPhrase', 'confidence', 'usefulness', 'urgency', 'timeSensitivity',
          'reasonSummary', 'relatedEntities', 'deliveryRecommendation', 'expiresInMs', 'requiresPermission',
          'backgroundTaskProposal',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['opportunities'],
  additionalProperties: false,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function bounded(text, max) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function pairsToEntities(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((pair) => isPlainObject(pair) && typeof pair.name === 'string')
    .slice(0, MAX_ENTITIES)
    .map((pair) => ({ name: bounded(pair.name, 60), value: bounded(String(pair.value ?? ''), 120) }));
}

function validateOne(raw, errors) {
  if (!isPlainObject(raw)) { errors.push('opportunity must be an object'); return null; }
  if (!OPPORTUNITY_TYPES.includes(raw.type)) { errors.push(`unknown opportunity type "${raw.type}"`); return null; }
  const content = bounded(raw.content, MAX_CONTENT_CHARS);
  if (!content) { errors.push('opportunity content must be a non-empty string'); return null; }

  let proposal = null;
  if (raw.backgroundTaskProposal !== null && raw.backgroundTaskProposal !== undefined) {
    const p = raw.backgroundTaskProposal;
    if (!isPlainObject(p) || !bounded(p.goal, 200)) { errors.push('backgroundTaskProposal must have a goal'); return null; }
    proposal = {
      goal: bounded(p.goal, 200),
      category: bounded(p.category, 60) || 'general',
      reason: bounded(p.reason, MAX_REASON_CHARS),
      estimatedSteps: Array.isArray(p.estimatedSteps) ? p.estimatedSteps.filter((s) => typeof s === 'string').slice(0, MAX_STEPS).map((s) => bounded(s, 120)) : [],
      requiredCapabilities: Array.isArray(p.requiredCapabilities) ? p.requiredCapabilities.filter((c) => typeof c === 'string').slice(0, 8) : [],
    };
  }

  const expiresRaw = Number(raw.expiresInMs);
  const expiresInMs = Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.min(expiresRaw, MAX_EXPIRES_MS) : DEFAULT_EXPIRES_MS;

  return {
    type: raw.type,
    content,
    suggestedPhrase: typeof raw.suggestedPhrase === 'string' && raw.suggestedPhrase.trim() ? bounded(raw.suggestedPhrase, MAX_CONTENT_CHARS) : null,
    confidence: clamp01(raw.confidence),
    usefulness: clamp01(raw.usefulness),
    urgency: URGENCY_LEVELS.includes(raw.urgency) ? raw.urgency : 'low',
    timeSensitivity: TIME_SENSITIVITIES.includes(raw.timeSensitivity) ? raw.timeSensitivity : 'anytime',
    reasonSummary: bounded(raw.reasonSummary, MAX_REASON_CHARS),
    relatedEntities: pairsToEntities(raw.relatedEntities),
    deliveryRecommendation: DELIVERY_MODES.includes(raw.deliveryRecommendation) ? raw.deliveryRecommendation : 'visual_only',
    expiresInMs,
    requiresPermission: Boolean(raw.requiresPermission) || Boolean(proposal),
    backgroundTaskProposal: proposal,
  };
}

/**
 * Validate a raw evaluation. Never throws. Individually invalid opportunities
 * are dropped (with errors recorded); a structurally invalid top level fails
 * the whole evaluation. An empty opportunities list is a NORMAL result.
 */
export function validateOpportunities(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.opportunities)) {
    return { ok: false, opportunities: [], errors: ['evaluation must be an object with an opportunities array'] };
  }
  const errors = [];
  const opportunities = [];
  for (const entry of raw.opportunities.slice(0, MAX_OPPORTUNITIES_PER_EVALUATION)) {
    const valid = validateOne(entry, errors);
    if (valid) opportunities.push(valid);
  }
  if (raw.opportunities.length > MAX_OPPORTUNITIES_PER_EVALUATION) {
    errors.push(`evaluation returned more than ${MAX_OPPORTUNITIES_PER_EVALUATION} opportunities; extras dropped`);
  }
  return { ok: true, opportunities, errors };
}
