// Episodic/semantic memory schema + validation. Pure and dependency-free, like
// agent/schema.js — every stored memory and every model-proposed candidate is
// validated here before it can touch the repository. Invalid or out-of-bounds
// data fails safely (never thrown, never partially trusted).

export const MEMORY_TYPES = ['episode', 'fact', 'preference', 'goal', 'commitment', 'relationship', 'procedure', 'correction', 'summary'];

export const MEMORY_STATUS = ['active', 'superseded', 'contradicted', 'deleted'];

// Evidence types, ordered LOWEST to HIGHEST authority. A candidate may only
// supersede/contradict an existing memory whose own evidence rank is <= its
// rank (see writer.js) — this is how "explicit user correction outranks
// inference" and "Roma's own text is never user evidence" are enforced in code,
// not left to model judgment.
export const EVIDENCE_TYPES = [
  'roma_generated',
  'inferred',
  'visually_observed',
  'other_speaker_stated',
  'tool_result',
  'user_stated',
  'user_confirmed',
  'user_corrected',
];

export function evidenceRank(evidenceType) {
  const index = EVIDENCE_TYPES.indexOf(evidenceType);
  return index === -1 ? 0 : index;
}

// Model-generated content (Roma's own answers/suggestions) must never silently
// become a durable fact/preference/commitment/goal/relationship about the user
// or anyone else — those types require real evidence, not Roma's own words.
export const TYPES_REQUIRING_NON_GENERATED_EVIDENCE = ['fact', 'preference', 'commitment', 'goal', 'relationship'];

export const SCHEMA_VERSION = 1;

const MAX_SUMMARY_CHARS = 300;
const MAX_TAG_CHARS = 40;
const MAX_TAGS = 8;
const MAX_OBJECT_KEYS = 10;
const MAX_OBJECT_VALUE_CHARS = 200;
const MAX_ID_CHARS = 100;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text, max) {
  return typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp01(value, fallback = 0) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, n));
}

// Strict structured-output mode (Groq/OpenAI) forbids free-form maps, so open
// key/value data (the memory's `object`) travels as {name, value} pair arrays
// on the wire — same convention as agent/schema.js's KEY_VALUE_PAIRS.
const KEY_VALUE_PAIRS = {
  type: 'array',
  description: 'Key/value pairs, each as {"name": ..., "value": ...}.',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
};

function pairsToObject(value) {
  if (isPlainObject(value)) return value;
  if (Array.isArray(value)) {
    const object = {};
    for (const pair of value) {
      if (isPlainObject(pair) && typeof pair.name === 'string') object[pair.name] = pair.value;
    }
    return object;
  }
  return null;
}

function normalizeObjectField(value) {
  const map = pairsToObject(value) ?? {};
  const out = {};
  for (const key of Object.keys(map).slice(0, MAX_OBJECT_KEYS)) {
    const v = map[key];
    out[key] = typeof v === 'string' ? truncate(v, MAX_OBJECT_VALUE_CHARS) : v;
  }
  return out;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((t) => typeof t === 'string' && t.trim()).slice(0, MAX_TAGS).map((t) => truncate(t.trim().toLowerCase(), MAX_TAG_CHARS));
}

// ── candidate schema (what the Memory Writer's model call proposes) ──────────

export const MEMORY_CANDIDATE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discard', 'store', 'merge', 'supersede'] },
          type: { type: 'string', enum: MEMORY_TYPES },
          subject_id: { type: 'string' },
          predicate: { type: 'string' },
          object: KEY_VALUE_PAIRS,
          summary: { type: 'string' },
          confidence: { type: 'number' },
          importance: { type: 'number' },
          evidence_type: { type: 'string', enum: EVIDENCE_TYPES },
          supersedes_memory_id: { type: ['string', 'null'] },
          reason_code: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['action', 'type', 'subject_id', 'predicate', 'object', 'summary', 'confidence', 'importance', 'evidence_type', 'supersedes_memory_id', 'reason_code', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

/** Validate one raw candidate object. Never throws. */
export function validateCandidate(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, candidate: null, errors: ['candidate must be an object'] };

  if (!['discard', 'store', 'merge', 'supersede'].includes(raw.action)) errors.push('candidate.action must be discard|store|merge|supersede');
  if (!MEMORY_TYPES.includes(raw.type)) errors.push(`candidate.type must be one of: ${MEMORY_TYPES.join(', ')}`);
  if (typeof raw.subject_id !== 'string' || !raw.subject_id.trim()) errors.push('candidate.subject_id must be a non-empty string');
  if (typeof raw.predicate !== 'string' || !raw.predicate.trim()) errors.push('candidate.predicate must be a non-empty string');
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) errors.push('candidate.summary must be a non-empty string');
  if (!EVIDENCE_TYPES.includes(raw.evidence_type)) errors.push(`candidate.evidence_type must be one of: ${EVIDENCE_TYPES.join(', ')}`);
  if (raw.supersedes_memory_id != null && typeof raw.supersedes_memory_id !== 'string') errors.push('candidate.supersedes_memory_id must be a string or null');
  if (raw.action === 'supersede' && !raw.supersedes_memory_id) errors.push('action "supersede" requires supersedes_memory_id');

  if (errors.length) return { ok: false, candidate: null, errors };

  return {
    ok: true,
    errors: [],
    candidate: {
      action: raw.action,
      type: raw.type,
      subjectId: truncate(raw.subject_id.trim(), MAX_ID_CHARS),
      predicate: truncate(raw.predicate.trim(), MAX_ID_CHARS),
      object: normalizeObjectField(raw.object),
      summary: truncate(raw.summary.trim(), MAX_SUMMARY_CHARS),
      confidence: clamp01(raw.confidence, 0.5),
      importance: clamp01(raw.importance, 0.4),
      evidenceType: raw.evidence_type,
      supersedesMemoryId: raw.supersedes_memory_id ?? null,
      reasonCode: typeof raw.reason_code === 'string' ? truncate(raw.reason_code.trim(), 80) : 'unspecified',
      tags: normalizeTags(raw.tags),
    },
  };
}

/** Validate the top-level { candidates: [...] } model response. Never throws. */
export function validateCandidateResponse(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.candidates)) {
    return { ok: false, candidates: [], errors: ['response must be { candidates: [...] }'] };
  }
  const candidates = [];
  const errors = [];
  for (const item of raw.candidates.slice(0, 8)) {
    const result = validateCandidate(item);
    if (result.ok) candidates.push(result.candidate);
    else errors.push(...result.errors);
  }
  return { ok: true, candidates, errors };
}

// ── durable memory record ─────────────────────────────────────────────────────

/**
 * Validate + normalize a full memory record before it is written to the
 * repository. `raw` is expected to already carry generated fields (memoryId,
 * timestamps) — this is the last line of defense against a malformed or
 * over-large record reaching storage.
 */
export function validateMemory(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, memory: null, errors: ['memory must be an object'] };
  if (typeof raw.memoryId !== 'string' || !raw.memoryId) errors.push('memory.memoryId must be a non-empty string');
  if (!MEMORY_TYPES.includes(raw.type)) errors.push(`memory.type must be one of: ${MEMORY_TYPES.join(', ')}`);
  if (typeof raw.subjectId !== 'string' || !raw.subjectId.trim()) errors.push('memory.subjectId must be a non-empty string');
  if (typeof raw.predicate !== 'string' || !raw.predicate.trim()) errors.push('memory.predicate must be a non-empty string');
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) errors.push('memory.summary must be a non-empty string');
  if (!MEMORY_STATUS.includes(raw.status ?? 'active')) errors.push(`memory.status must be one of: ${MEMORY_STATUS.join(', ')}`);
  if (!isPlainObject(raw.source)) errors.push('memory.source must be an object');
  else if (!EVIDENCE_TYPES.includes(raw.source.evidenceType)) errors.push(`memory.source.evidenceType must be one of: ${EVIDENCE_TYPES.join(', ')}`);

  if (errors.length) return { ok: false, memory: null, errors };

  const now = Date.now();
  return {
    ok: true,
    errors: [],
    memory: {
      memoryId: raw.memoryId,
      schemaVersion: SCHEMA_VERSION,
      type: raw.type,
      subjectId: truncate(raw.subjectId.trim(), MAX_ID_CHARS),
      predicate: truncate(raw.predicate.trim(), MAX_ID_CHARS),
      object: normalizeObjectField(raw.object),
      summary: truncate(raw.summary.trim(), MAX_SUMMARY_CHARS),
      status: raw.status ?? 'active',
      importance: clamp01(raw.importance, 0.4),
      confidence: clamp01(raw.confidence, 0.5),
      sensitivity: raw.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
      validFrom: Number.isFinite(raw.validFrom) ? raw.validFrom : now,
      validUntil: Number.isFinite(raw.validUntil) ? raw.validUntil : null,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      lastAccessedAt: Number.isFinite(raw.lastAccessedAt) ? raw.lastAccessedAt : null,
      source: {
        interactionId: raw.source.interactionId ?? null,
        turnIds: Array.isArray(raw.source.turnIds) ? raw.source.turnIds.slice(0, 20) : [],
        transcriptIds: Array.isArray(raw.source.transcriptIds) ? raw.source.transcriptIds.slice(0, 20) : [],
        sceneEventIds: Array.isArray(raw.source.sceneEventIds) ? raw.source.sceneEventIds.slice(0, 20) : [],
        speakerId: raw.source.speakerId ?? null,
        evidenceType: raw.source.evidenceType,
        extractionMethod: raw.source.extractionMethod ?? 'memory_writer',
        model: raw.source.model ?? null,
      },
      supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.slice(0, 10) : [],
      supersededBy: raw.supersededBy ?? null,
      contradicts: Array.isArray(raw.contradicts) ? raw.contradicts.slice(0, 10) : [],
      tags: normalizeTags(raw.tags),
      // Optional stable-entity links (identity phase, additive/backward-
      // compatible — see identity/coordinator.js's relinkMemoriesForInteraction
      // and mergePeople). A memory written before entity resolution existed,
      // or one whose speaker was never resolved, simply has these as
      // empty/null; nothing here changes how such a memory validates or
      // retrieves. The original transient speakerId (source.speakerId, above)
      // is NEVER overwritten when a link is added — both are kept.
      subjectEntityIds: Array.isArray(raw.subjectEntityIds) ? raw.subjectEntityIds.filter((v) => typeof v === 'string').slice(0, 20) : [],
      objectEntityIds: Array.isArray(raw.objectEntityIds) ? raw.objectEntityIds.filter((v) => typeof v === 'string').slice(0, 20) : [],
      mentionedEntityIds: Array.isArray(raw.mentionedEntityIds) ? raw.mentionedEntityIds.filter((v) => typeof v === 'string').slice(0, 20) : [],
      speakerEntityId: typeof raw.speakerEntityId === 'string' ? raw.speakerEntityId : null,
    },
  };
}
