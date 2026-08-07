// Structured vision-analysis result schema + validation. Pure and shared: the
// server validates every provider response before returning it, the client
// re-validates before handing anything to the agent, and the mock provider is
// held to the same shape. Malformed model output becomes a clear tool failure —
// never a payload the agent might act on.

const MAX_TEXT_CHARS = 600;
const MAX_OBSERVATIONS = 20;
const MAX_VISIBLE_TEXT = 20;

// Embedded into the vision prompt so the model knows the exact shape to return.
export const VISION_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Direct answer to the question, grounded ONLY in what is visible.' },
    description: { type: 'string', description: 'One or two sentences describing the overall scene.' },
    target: {
      type: ['object', 'null'],
      properties: {
        label: { type: 'string' },
        found: { type: 'boolean' },
        confidence: { type: 'number' },
        position: { type: ['string', 'null'] },
      },
      required: ['label', 'found', 'confidence', 'position'],
    },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, position: { type: ['string', 'null'] }, confidence: { type: 'number' } },
        required: ['label', 'position', 'confidence'],
      },
    },
    visibleText: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: ['string', 'null'], description: 'What you are unsure about, or null.' },
    requiresAnotherFrame: { type: 'boolean', description: 'True if a different frame/angle would materially help.' },
  },
  required: ['answer', 'description', 'target', 'observations', 'visibleText', 'uncertainty', 'requiresAnotherFrame'],
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function boundedString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS - 1)}…` : value;
}

/** Validate + bound a raw vision result. Never throws. */
export function validateVisionResult(raw) {
  if (!isPlainObject(raw)) return { ok: false, result: null, errors: ['vision result must be a JSON object'] };
  const errors = [];

  if (typeof raw.answer !== 'string' || !raw.answer.trim()) errors.push('answer must be a non-empty string');

  let target = null;
  if (raw.target !== null && raw.target !== undefined) {
    if (!isPlainObject(raw.target) || typeof raw.target.label !== 'string') {
      errors.push('target must be null or an object with a string label');
    } else {
      target = {
        label: boundedString(raw.target.label),
        found: Boolean(raw.target.found),
        confidence: clampConfidence(raw.target.confidence),
        position: typeof raw.target.position === 'string' ? boundedString(raw.target.position) : null,
      };
    }
  }

  let observations = [];
  if (raw.observations !== undefined && raw.observations !== null) {
    if (!Array.isArray(raw.observations)) errors.push('observations must be an array');
    else {
      observations = raw.observations
        .filter((o) => isPlainObject(o) && typeof o.label === 'string')
        .slice(0, MAX_OBSERVATIONS)
        .map((o) => ({
          label: boundedString(o.label),
          position: typeof o.position === 'string' ? boundedString(o.position) : null,
          confidence: clampConfidence(o.confidence),
        }));
    }
  }

  const visibleText = Array.isArray(raw.visibleText)
    ? raw.visibleText.filter((t) => typeof t === 'string').slice(0, MAX_VISIBLE_TEXT).map((t) => boundedString(t))
    : [];

  if (errors.length) return { ok: false, result: null, errors };

  return {
    ok: true,
    errors: [],
    result: {
      answer: boundedString(raw.answer.trim()),
      description: boundedString(raw.description ?? ''),
      target,
      observations,
      visibleText,
      uncertainty: typeof raw.uncertainty === 'string' && raw.uncertainty.trim() ? boundedString(raw.uncertainty) : null,
      requiresAnotherFrame: Boolean(raw.requiresAnotherFrame),
    },
  };
}
