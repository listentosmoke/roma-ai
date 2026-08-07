// Entity Resolution / Voice Identity schema + validation. Pure and
// dependency-free, like memory/schema.js — every stored person, evidence
// record, and relationship is validated here before it can touch the
// repository. Invalid or out-of-bounds data fails safely (never thrown,
// never partially trusted).
//
// SENSITIVITY NOTE (read before using `sensitivity` anywhere): this field is
// metadata only. It is NOT an enforced access-control or retrieval boundary
// in this phase — nothing in this codebase currently restricts who/what can
// read a 'sensitive' or 'biometric'-tagged record. Enforcement is deferred to
// a future secure server database + real-time server agent integration phase
// (see IDENTITY.md "Deferred sensitivity enforcement").

export const SCHEMA_VERSION = 1;

export const ENTITY_TYPES = ['person'];

// Overall record lifecycle (mirrors memory's MEMORY_STATUS convention).
export const PERSON_STATUS = ['active', 'merged', 'deleted'];

// Identity confidence/dispute state — distinct from `status`. A person can be
// `status: 'active'` while `identityStatus` moves through provisional ->
// candidate -> confirmed (or disputed) as evidence accumulates.
export const IDENTITY_STATUS = ['provisional', 'candidate', 'confirmed', 'disputed', 'merged', 'deleted'];

export const ALIAS_TYPES = ['name', 'nickname', 'role', 'spelling', 'other'];

// Ordered LOWEST to HIGHEST authority, same convention as memory's
// EVIDENCE_TYPES/evidenceRank: a correction/rejection can only invalidate a
// resolution whose own evidence rank is <= its rank. `future_face_match` is
// SCHEMA SUPPORT ONLY — nothing in this codebase produces it (see
// IDENTITY.md "Facial-recognition extension points"); it is parked near
// voice_match's authority tier for when a real face provider exists.
export const IDENTITY_EVIDENCE_TYPES = [
  'memory_context',
  'relationship_context',
  'name_mention',
  'diarization_continuity',
  'tool_verified_identity',
  'future_face_match',
  'explicit_self_identification',
  'voice_match',
  'voice_enrollment',
  'explicit_user_attribution',
  'manual_confirmation',
  'manual_rejection',
  'correction',
];

export function identityEvidenceRank(evidenceType) {
  const index = IDENTITY_EVIDENCE_TYPES.indexOf(evidenceType);
  return index === -1 ? 0 : index;
}

export const EVIDENCE_DECISIONS = ['resolved', 'candidate', 'rejected', 'confirmed', 'corrected', 'enrolled', 'context_only'];

export const RESOLUTION_OUTCOMES = ['resolved', 'provisional', 'ambiguous', 'unknown', 'rejected', 'cancelled', 'stale'];

export const RELATIONSHIP_TYPES = ['self', 'family', 'friend', 'works_with', 'reports_to', 'client', 'contractor', 'service_provider', 'owns', 'member_of', 'knows', 'custom'];

export const RELATIONSHIP_DIRECTIONS = ['directed', 'undirected'];

// Same convention/values as memory's MEMORY_STATUS.
export const RELATIONSHIP_STATUS = ['active', 'superseded', 'contradicted', 'deleted'];

// Metadata only — see file header. 'biometric' exists so voice-derived
// evidence can be labeled distinctly from ordinary 'sensitive' data; neither
// value is enforced.
export const SENSITIVITY_LEVELS = ['normal', 'sensitive', 'biometric'];

const MAX_NAME_CHARS = 120;
const MAX_ALIASES = 20;
const MAX_ROLES = 8;
const MAX_ROLE_CHARS = 60;
const MAX_ATTR_KEYS = 10;
const MAX_ATTR_VALUE_CHARS = 200;
const MAX_ID_LIST = 50;
const MAX_LABEL_CHARS = 120;
const MAX_REASON_CHARS = 80;

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

function normalizeSensitivity(value, fallback = 'normal') {
  return SENSITIVITY_LEVELS.includes(value) ? value : fallback;
}

function normalizeIdList(value, max = MAX_ID_LIST) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && v))].slice(0, max);
}

function normalizeString(value, max) {
  return typeof value === 'string' ? truncate(value.trim(), max) : '';
}

export function normalizeAliasText(alias) {
  return typeof alias === 'string' ? alias.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function normalizeAlias(raw) {
  if (!isPlainObject(raw) || typeof raw.alias !== 'string' || !raw.alias.trim()) return null;
  const alias = truncate(raw.alias.trim(), MAX_NAME_CHARS);
  return {
    alias,
    normalizedAlias: normalizeAliasText(alias),
    type: ALIAS_TYPES.includes(raw.type) ? raw.type : 'name',
    confidence: clamp01(raw.confidence, 0.7),
    sourceEvidenceIds: normalizeIdList(raw.sourceEvidenceIds, 10),
  };
}

function normalizeAliases(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeAlias).filter(Boolean).slice(0, MAX_ALIASES);
}

function normalizeRoles(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((r) => typeof r === 'string' && r.trim()))].slice(0, MAX_ROLES).map((r) => truncate(r.trim(), MAX_ROLE_CHARS));
}

function normalizeAttributes(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of Object.keys(value).slice(0, MAX_ATTR_KEYS)) {
    const v = value[key];
    out[key] = typeof v === 'string' ? truncate(v, MAX_ATTR_VALUE_CHARS) : v;
  }
  return out;
}

// ── Person ────────────────────────────────────────────────────────────────

/**
 * Validate + normalize a full person record before it is written to the
 * repository. Never throws — invalid input fails with `{ ok: false, errors }`.
 */
export function validatePerson(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, person: null, errors: ['person must be an object'] };
  if (typeof raw.personId !== 'string' || !raw.personId) errors.push('person.personId must be a non-empty string');
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) errors.push('person.displayName must be a non-empty string');
  if (!PERSON_STATUS.includes(raw.status ?? 'active')) errors.push(`person.status must be one of: ${PERSON_STATUS.join(', ')}`);
  if (!IDENTITY_STATUS.includes(raw.identityStatus)) errors.push(`person.identityStatus must be one of: ${IDENTITY_STATUS.join(', ')}`);

  if (errors.length) return { ok: false, person: null, errors };

  const now = Date.now();
  return {
    ok: true,
    errors: [],
    person: {
      personId: raw.personId,
      schemaVersion: SCHEMA_VERSION,
      entityType: 'person',
      displayName: normalizeString(raw.displayName, MAX_NAME_CHARS),
      status: raw.status ?? 'active',
      identityStatus: raw.identityStatus,
      aliases: normalizeAliases(raw.aliases),
      roles: normalizeRoles(raw.roles),
      attributes: normalizeAttributes(raw.attributes),
      voiceProfileIds: normalizeIdList(raw.voiceProfileIds, 10),
      faceProfileIds: normalizeIdList(raw.faceProfileIds, 10), // reserved — see IDENTITY.md; never populated in this phase
      relationshipIds: normalizeIdList(raw.relationshipIds),
      linkedMemoryIds: normalizeIdList(raw.linkedMemoryIds, 200),
      confidence: clamp01(raw.confidence, 0.5),
      sensitivity: normalizeSensitivity(raw.sensitivity),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      lastObservedAt: Number.isFinite(raw.lastObservedAt) ? raw.lastObservedAt : null,
      mergedInto: raw.mergedInto ?? null,
      supersedes: normalizeIdList(raw.supersedes, 20),
      sourceEvidenceIds: normalizeIdList(raw.sourceEvidenceIds, 100),
      provisionalReason: typeof raw.provisionalReason === 'string' ? truncate(raw.provisionalReason, 200) : null,
    },
  };
}

// ── Identity evidence ────────────────────────────────────────────────────

export function validateEvidence(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, evidence: null, errors: ['evidence must be an object'] };
  if (typeof raw.evidenceId !== 'string' || !raw.evidenceId) errors.push('evidence.evidenceId must be a non-empty string');
  if (!IDENTITY_EVIDENCE_TYPES.includes(raw.evidenceType)) errors.push(`evidence.evidenceType must be one of: ${IDENTITY_EVIDENCE_TYPES.join(', ')}`);
  if (raw.decision != null && !EVIDENCE_DECISIONS.includes(raw.decision)) errors.push(`evidence.decision must be one of: ${EVIDENCE_DECISIONS.join(', ')}`);

  if (errors.length) return { ok: false, evidence: null, errors };

  const now = Date.now();
  return {
    ok: true,
    errors: [],
    evidence: {
      evidenceId: raw.evidenceId,
      schemaVersion: SCHEMA_VERSION,
      evidenceType: raw.evidenceType,
      personId: raw.personId ?? null,
      speakerLabel: raw.speakerLabel ?? null,
      sessionId: raw.sessionId ?? null,
      interactionId: raw.interactionId ?? null,
      turnId: raw.turnId ?? null,
      transcriptIds: normalizeIdList(raw.transcriptIds, 20),
      voiceSampleRef: raw.voiceSampleRef ?? null,
      provider: typeof raw.provider === 'string' ? truncate(raw.provider, 80) : null,
      providerModel: typeof raw.providerModel === 'string' ? truncate(raw.providerModel, 80) : null,
      score: raw.score != null ? clamp01(raw.score, 0) : null,
      confidence: raw.confidence != null ? clamp01(raw.confidence, 0.5) : null,
      quality: raw.quality != null ? clamp01(raw.quality, 0) : null,
      decision: raw.decision ?? 'context_only',
      reasonCode: normalizeString(raw.reasonCode ?? 'unspecified', MAX_REASON_CHARS),
      confirmedBy: raw.confirmedBy ?? null,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
      // Voice-derived evidence defaults to 'biometric' unless the caller says
      // otherwise — see file header: labeling only, not an access boundary.
      sensitivity: normalizeSensitivity(raw.sensitivity, raw.evidenceType === 'voice_match' || raw.evidenceType === 'voice_enrollment' ? 'biometric' : 'normal'),
    },
  };
}

// ── Relationship ─────────────────────────────────────────────────────────

export function validateRelationship(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, relationship: null, errors: ['relationship must be an object'] };
  if (typeof raw.relationshipId !== 'string' || !raw.relationshipId) errors.push('relationship.relationshipId must be a non-empty string');
  if (typeof raw.fromEntityId !== 'string' || !raw.fromEntityId) errors.push('relationship.fromEntityId must be a non-empty string');
  if (typeof raw.toEntityId !== 'string' || !raw.toEntityId) errors.push('relationship.toEntityId must be a non-empty string');
  if (!RELATIONSHIP_TYPES.includes(raw.type)) errors.push(`relationship.type must be one of: ${RELATIONSHIP_TYPES.join(', ')}`);
  if (!RELATIONSHIP_STATUS.includes(raw.status ?? 'active')) errors.push(`relationship.status must be one of: ${RELATIONSHIP_STATUS.join(', ')}`);

  if (errors.length) return { ok: false, relationship: null, errors };

  const now = Date.now();
  return {
    ok: true,
    errors: [],
    relationship: {
      relationshipId: raw.relationshipId,
      schemaVersion: SCHEMA_VERSION,
      fromEntityId: raw.fromEntityId,
      toEntityId: raw.toEntityId,
      type: raw.type,
      label: raw.label != null ? normalizeString(raw.label, MAX_LABEL_CHARS) : null,
      direction: RELATIONSHIP_DIRECTIONS.includes(raw.direction) ? raw.direction : 'directed',
      status: raw.status ?? 'active',
      confidence: clamp01(raw.confidence, 0.6),
      sensitivity: normalizeSensitivity(raw.sensitivity),
      validFrom: Number.isFinite(raw.validFrom) ? raw.validFrom : now,
      validUntil: Number.isFinite(raw.validUntil) ? raw.validUntil : null,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      sourceEvidenceIds: normalizeIdList(raw.sourceEvidenceIds, 50),
      linkedMemoryIds: normalizeIdList(raw.linkedMemoryIds, 100),
      supersedes: normalizeIdList(raw.supersedes, 10),
      contradicts: normalizeIdList(raw.contradicts, 10),
    },
  };
}
