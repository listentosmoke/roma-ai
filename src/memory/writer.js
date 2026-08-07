// Memory Writer — model-assisted extraction followed by DETERMINISTIC
// validation and storage decisions. The model may propose a candidate; this
// module (application code) decides whether it is structurally valid and
// eligible for storage. Nothing here executes a model's proposal blindly:
//
//   - evidence-authority is enforced in code (evidenceRank), not by the model
//   - Roma's own text can never become user/fact/preference/commitment/goal/
//     relationship evidence, regardless of what the model proposes
//   - true duplicates are always merged, even if the model said "store"
//   - a correction may only supersede a memory whose own evidence is no more
//     authoritative than the new evidence

import { validateCandidateResponse, evidenceRank, TYPES_REQUIRING_NON_GENERATED_EVIDENCE, MEMORY_CANDIDATE_JSON_SCHEMA } from './schema.js';
import { assembleExtractionContext } from './prompt.js';
import { createKeywordScorer } from './embeddings.js';

const keywordScorer = createKeywordScorer();

/** Bounded "existing related memories" list handed to the model for dedup/supersession context. */
function relatedForPrompt(repository, userText, limit = 6) {
  const active = repository.searchStructured({ status: 'active' });
  return active
    .map((m) => ({ memory: m, score: keywordScorer.score(userText ?? '', `${m.summary} ${m.tags.join(' ')}`) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => ({ memoryId: memory.memoryId, type: memory.type, subjectId: memory.subjectId, predicate: memory.predicate, summary: memory.summary, status: memory.status, confidence: memory.confidence }));
}

/**
 * @param {{ interactionPackage: object, repository: object, provider: { infer: Function }, now?: Function, signal?: AbortSignal }} args
 */
export async function proposeCandidates({ interactionPackage, repository, provider, now = Date.now, signal }) {
  const related = relatedForPrompt(repository, interactionPackage.userText ?? interactionPackage.explicitText ?? '');
  const context = assembleExtractionContext({ interactionPackage, relatedMemories: related });
  const startedAt = now();
  const result = await provider.infer({ ...context, schema: MEMORY_CANDIDATE_JSON_SCHEMA, signal });
  const validation = validateCandidateResponse(result.decisionRaw);
  return { candidates: validation.candidates, errors: validation.errors, latencyMs: result.latencyMs ?? now() - startedAt, related };
}

function buildRecordFields(candidate, interactionPackage, now) {
  return {
    type: candidate.type,
    subjectId: candidate.subjectId,
    predicate: candidate.predicate,
    object: candidate.object,
    summary: candidate.summary,
    confidence: candidate.confidence,
    importance: candidate.importance,
    tags: candidate.tags,
    validFrom: now,
    source: {
      interactionId: interactionPackage.interactionId ?? null,
      turnIds: interactionPackage.turnIds ?? [],
      transcriptIds: interactionPackage.transcriptIds ?? [],
      sceneEventIds: interactionPackage.sceneEventIds ?? [],
      speakerId: interactionPackage.speakerId ?? null,
      evidenceType: candidate.evidenceType,
      extractionMethod: interactionPackage.explicitRequest ? 'explicit_request' : 'memory_writer',
      model: interactionPackage.model ?? null,
    },
  };
}

/**
 * Apply ONE validated candidate against the repository. Never trusts the
 * model's `action` blindly — dedup, evidence-authority, and the
 * Roma-generated-evidence rule are all re-checked here in code.
 */
export function applyCandidate(candidate, { repository, interactionPackage, now = Date.now() }) {
  // Roma's own words can never become durable user/fact-like evidence.
  if (candidate.evidenceType === 'roma_generated' && TYPES_REQUIRING_NON_GENERATED_EVIDENCE.includes(candidate.type)) {
    return { action: 'discard', memory: null, reasonCode: 'roma_generated_not_user_evidence' };
  }

  const dedupMatch = repository.findRelated({ type: candidate.type, subjectId: candidate.subjectId, predicate: candidate.predicate })[0] ?? null;

  if (candidate.action === 'discard') {
    return { action: 'discard', memory: null, reasonCode: candidate.reasonCode };
  }

  if (candidate.action === 'supersede') {
    const old = candidate.supersedesMemoryId ? repository.get(candidate.supersedesMemoryId) : (dedupMatch ?? null);
    if (!old) {
      // Nothing to supersede — fall through to a plain store instead of losing the evidence.
      const created = repository.create(buildRecordFields(candidate, interactionPackage, now));
      return created.ok
        ? { action: 'store', memory: created.memory, reasonCode: 'supersede_target_missing_stored_new' }
        : { action: 'discard', memory: null, reasonCode: 'validation_failed', errors: created.errors };
    }
    // Contradictory/weaker evidence must never overwrite a more authoritative
    // existing memory — this is how "explicit correction outranks inference"
    // and "unconfirmed evidence does not overwrite a confirmed fact" hold.
    if (evidenceRank(candidate.evidenceType) < evidenceRank(old.source.evidenceType)) {
      return { action: 'discard', memory: null, reasonCode: 'insufficient_evidence_to_supersede' };
    }
    const created = repository.create({ ...buildRecordFields(candidate, interactionPackage, now), supersedes: [old.memoryId] });
    if (!created.ok) return { action: 'discard', memory: null, reasonCode: 'validation_failed', errors: created.errors };
    repository.supersede(old.memoryId, created.memory.memoryId);
    return { action: 'supersede', memory: created.memory, supersededId: old.memoryId, reasonCode: candidate.reasonCode };
  }

  // 'store' or 'merge': a true duplicate is ALWAYS merged, even if the model
  // said "store" — repeated evidence strengthens an existing memory rather
  // than multiplying records.
  if (dedupMatch) {
    const strongerConfidence = Math.min(1, Math.max(dedupMatch.confidence, candidate.confidence) + 0.05);
    const patch = {
      confidence: strongerConfidence,
      importance: Math.max(dedupMatch.importance, candidate.importance),
      tags: [...new Set([...dedupMatch.tags, ...candidate.tags])],
      source: {
        ...dedupMatch.source,
        turnIds: [...new Set([...dedupMatch.source.turnIds, ...(interactionPackage.turnIds ?? [])])],
        transcriptIds: [...new Set([...dedupMatch.source.transcriptIds, ...(interactionPackage.transcriptIds ?? [])])],
      },
    };
    const updated = repository.update(dedupMatch.memoryId, patch);
    return updated.ok
      ? { action: 'merge', memory: updated.memory, reasonCode: candidate.reasonCode }
      : { action: 'discard', memory: null, reasonCode: 'validation_failed', errors: updated.errors };
  }

  const created = repository.create(buildRecordFields(candidate, interactionPackage, now));
  return created.ok
    ? { action: 'store', memory: created.memory, reasonCode: candidate.reasonCode }
    : { action: 'discard', memory: null, reasonCode: 'validation_failed', errors: created.errors };
}

/**
 * Top-level Memory Writer entry point: propose + apply for one bounded,
 * completed interaction. `interactionPackage.completed` must be true (an
 * incomplete/cancelled interaction is skipped, never partially stored).
 */
export async function writeInteraction({ interactionPackage, repository, provider, now = Date.now, signal }) {
  if (interactionPackage.completed === false) {
    return { skipped: true, reason: 'interaction did not complete', candidates: [], applied: [] };
  }
  const { candidates, errors, latencyMs } = await proposeCandidates({ interactionPackage, repository, provider, now, signal });
  const applied = candidates.map((candidate) => ({ candidate, ...applyCandidate(candidate, { repository, interactionPackage, now: now() }) }));
  return { skipped: false, candidates, applied, errors, latencyMs };
}
