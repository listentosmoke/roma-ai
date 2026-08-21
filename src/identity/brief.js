// The person brief — what you know about someone, at the moment you see them.
//
// This is the thing that separates "Roma recognised a face" from "Roma is
// useful". Recognition already works; a person id on its own tells you
// nothing. A brief pulls together what is ALREADY in the database — the person
// record, your relationship, what you've said about them, what is still open
// between you — and puts it in one place.
//
// Nothing here infers, scores, or asks a model anything. It is a read across
// stores that already hold the answers, which is why it is fast enough to run
// the moment a face resolves.

const MAX_MEMORIES = 6;
const MAX_OPEN_ITEMS = 5;
const MAX_RELATIONSHIPS = 4;

/** Memory types that describe something still owed, in either direction. */
const OPEN_TYPES = new Set(['commitment', 'goal', 'task']);

/**
 * Every way a memory can be *about* a person: they are its subject, they were
 * mentioned in it, or they were the one speaking when it was recorded.
 */
export function memoryMentionsPerson(memory, personId) {
  if (!memory || !personId) return false;
  if (memory.speakerEntityId === personId) return true;
  if (memory.subjectId === personId) return true;
  if (Array.isArray(memory.subjectEntityIds) && memory.subjectEntityIds.includes(personId)) return true;
  if (Array.isArray(memory.mentionedEntityIds) && memory.mentionedEntityIds.includes(personId)) return true;
  return false;
}

/**
 * Rank what to surface first. Importance leads, because a brief is only useful
 * if the first line is the one that matters; recency breaks ties, since an old
 * fact about someone is usually less actionable than a recent one.
 */
function byRelevance(a, b) {
  const importance = (b.importance ?? 0) - (a.importance ?? 0);
  if (Math.abs(importance) > 0.05) return importance;
  return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
}

function relativeDay(from, to) {
  if (!from || !to) return null;
  const days = Math.floor((to - from) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Assemble everything known about one person.
 *
 * @param {object} deps
 * @param {object} deps.identityRepository person records, relationships, evidence
 * @param {object} [deps.memoryRepository]  optional — without it the brief is
 *   just the person record, which is still better than an id
 * @returns {object|null} null when there is no such person
 */
export function buildPersonBrief(personId, { identityRepository, memoryRepository = null, now = Date.now() } = {}) {
  const person = identityRepository?.getPerson?.(personId) ?? null;
  if (!person) return null;

  const relationships = (identityRepository.listRelationships?.({ entityId: personId }) ?? [])
    .filter((relationship) => relationship.status === 'active')
    .slice(0, MAX_RELATIONSHIPS)
    .map((relationship) => ({
      type: relationship.type,
      label: relationship.label,
      otherEntityId: relationship.fromEntityId === personId ? relationship.toEntityId : relationship.fromEntityId,
      confidence: relationship.confidence,
    }));

  const about = memoryRepository
    ? memoryRepository.searchStructured({ status: 'active' }).filter((memory) => memoryMentionsPerson(memory, personId))
    : [];

  // Open items are what you still owe each other — the first thing you want
  // to be reminded of when someone walks in.
  const open = about
    .filter((memory) => OPEN_TYPES.has(memory.type))
    .sort(byRelevance)
    .slice(0, MAX_OPEN_ITEMS)
    .map((memory) => ({ memoryId: memory.memoryId, type: memory.type, summary: memory.summary, importance: memory.importance }));

  const openIds = new Set(open.map((item) => item.memoryId));
  const knownFor = about
    .filter((memory) => !openIds.has(memory.memoryId))
    .sort(byRelevance)
    .slice(0, MAX_MEMORIES)
    .map((memory) => ({ memoryId: memory.memoryId, type: memory.type, summary: memory.summary, importance: memory.importance }));

  const lastMentionedAt = about.reduce((latest, memory) => Math.max(latest, memory.updatedAt ?? memory.createdAt ?? 0), 0) || null;

  return {
    personId,
    displayName: person.displayName,
    identityStatus: person.identityStatus,
    confidence: person.confidence,
    roles: person.roles ?? [],
    aliases: (person.aliases ?? []).map((alias) => alias.alias),
    relationships,
    open,
    knownFor,
    counts: {
      memories: about.length,
      open: open.length,
      relationships: relationships.length,
      faceProfiles: (person.faceProfileIds ?? []).length,
      voiceProfiles: (person.voiceProfileIds ?? []).length,
    },
    lastSeenAt: person.lastObservedAt ?? null,
    lastSeen: relativeDay(person.lastObservedAt, now),
    lastMentionedAt,
    lastMentioned: relativeDay(lastMentionedAt, now),
    // A brief is only as good as what is in it. Saying so lets the caller —
    // and the agent — avoid implying knowledge that does not exist.
    thin: about.length === 0 && relationships.length === 0,
  };
}

/**
 * Render a brief for the agent's context.
 *
 * Deliberately terse and factual. This goes into a prompt, so every line is
 * quoted data about a person, never an instruction about how to behave toward
 * them — what to *do* with it stays the model's judgment under the same gate
 * as everything else.
 */
export function formatPersonBrief(brief, { heading = 'WHO THIS IS' } = {}) {
  if (!brief) return '';
  const lines = [`${heading}: ${brief.displayName}${brief.roles.length ? ` (${brief.roles.join(', ')})` : ''}`];

  if (brief.identityStatus !== 'confirmed') lines.push(`- Identity is ${brief.identityStatus}, not confirmed — do not assert it as certain.`);
  if (brief.relationships.length) {
    lines.push(`- Relationship: ${brief.relationships.map((r) => `${r.type}${r.label ? ` (${r.label})` : ''}`).join(', ')}`);
  }
  if (brief.lastSeen) lines.push(`- Last seen: ${brief.lastSeen}`);

  if (brief.open.length) {
    lines.push('- Still open with them:');
    for (const item of brief.open) lines.push(`  · ${item.summary}`);
  }
  if (brief.knownFor.length) {
    lines.push('- What you know about them:');
    for (const item of brief.knownFor) lines.push(`  · ${item.summary}`);
  }
  if (brief.thin) lines.push('- Nothing recorded about them yet beyond the name.');

  return lines.join('\n');
}

/**
 * Briefs for everyone the camera can currently see, plus whoever is speaking.
 * Bounded hard: a crowded room must not turn into an unbounded prompt.
 */
export function buildBriefsForPresent({ personIds = [], identityRepository, memoryRepository = null, now = Date.now(), limit = 3 } = {}) {
  const unique = [...new Set(personIds.filter(Boolean))].slice(0, limit);
  return unique
    .map((personId) => buildPersonBrief(personId, { identityRepository, memoryRepository, now }))
    .filter(Boolean);
}
