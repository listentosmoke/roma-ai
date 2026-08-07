// Memory Retriever — ranks a bounded, relevant slice of the repository for one
// turn's context assembly. Combines keyword/semantic relevance, structured
// entity/goal/scene matching, recency, importance, confidence, and a small
// penalty for memories retrieved very recently (so the same fact isn't
// re-injected turn after turn). Never returns the whole database: a memory
// must show at least ONE real relevance signal to be included at all — broad
// importance/recency alone is not enough.

import { createKeywordScorer } from './embeddings.js';

const keywordScorer = createKeywordScorer();
const RECENT_USE_WINDOW_MS = 2 * 60 * 1000;
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SIGNAL = 0.05;
const CHARS_PER_TOKEN = 4;
const TOKEN_OVERHEAD = 8;

function estimateTokens(memory) {
  return Math.ceil((memory.summary?.length ?? 0) / CHARS_PER_TOKEN) + TOKEN_OVERHEAD;
}

function recencyWeight(memory, at) {
  const age = Math.max(0, at - (memory.updatedAt ?? memory.createdAt ?? at));
  return Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);
}

async function textRelevance(memory, queryText, { embedder, repository }) {
  if (embedder && repository?.searchSemantic) {
    // Caller pre-computes semantic scores in bulk (see retrieve()) for
    // efficiency; this per-memory path is only the keyword fallback.
    return null;
  }
  if (!queryText) return 0;
  return keywordScorer.score(queryText, `${memory.summary} ${memory.tags.join(' ')} ${memory.subjectId} ${memory.predicate}`);
}

/**
 * @param {{
 *   repository: object, query?: string, currentTurnId?: string|number,
 *   interactionId?: string, speakerIds?: string[], entityIds?: string[],
 *   currentGoals?: string[], sceneTags?: string[], time?: number,
 *   maximumMemories?: number, tokenBudget?: number, embedder?: object|null,
 *   includeHistorical?: boolean, signal?: AbortSignal,
 * }} params
 * @returns {Promise<{ memories: Array, matchType: string, interactionId: string|null, aborted: boolean }>}
 */
export async function retrieve({
  repository,
  query = '',
  currentTurnId = null,
  interactionId = null,
  speakerIds = [],
  entityIds = [],
  currentGoals = [],
  sceneTags = [],
  time = Date.now(),
  maximumMemories = 8,
  tokenBudget = 1200,
  embedder = null,
  includeHistorical = false,
  signal,
  isStillCurrent = () => true,
} = {}) {
  const pool = includeHistorical ? repository.searchStructured({ includeInactive: true }) : repository.searchStructured({ status: 'active' });

  let semanticScores = null;
  let matchType = 'keyword';
  if (embedder && query) {
    const results = await repository.searchSemantic({ text: query, embedder, candidates: pool });
    semanticScores = new Map(results.map((r) => [r.memory.memoryId, r.score]));
    matchType = 'semantic';
  } else if (!query) {
    matchType = 'structured';
  }

  if (signal?.aborted || !isStillCurrent()) return { memories: [], matchType, interactionId, aborted: true };

  const scored = [];
  for (const memory of pool) {
    const textScore = semanticScores ? (semanticScores.get(memory.memoryId) ?? 0) : await textRelevance(memory, query, { embedder, repository });
    const entityBonus = entityIds.includes(memory.subjectId) ? 0.25 : 0;
    const speakerBonus = memory.source?.speakerId && speakerIds.includes(memory.source.speakerId) ? 0.15 : 0;
    const goalBonus = currentGoals.some((g) => memory.tags.includes(g) || memory.predicate === g) ? 0.15 : 0;
    const sceneBonus = sceneTags.some((t) => memory.tags.includes(t)) ? 0.1 : 0;
    const relevanceSignal = textScore > MIN_SIGNAL || entityBonus > 0 || speakerBonus > 0 || goalBonus > 0 || sceneBonus > 0;
    if (!relevanceSignal) continue;

    const recentlyUsed = memory.lastAccessedAt != null && time - memory.lastAccessedAt < RECENT_USE_WINDOW_MS;
    const score = textScore * 0.4 + entityBonus + speakerBonus + goalBonus + sceneBonus
      + recencyWeight(memory, time) * 0.15 + memory.importance * 0.2 + memory.confidence * 0.15
      - (recentlyUsed ? 0.15 : 0);

    const reasons = [];
    if (textScore > MIN_SIGNAL) reasons.push(matchType === 'semantic' ? 'semantic_match' : 'keyword_match');
    if (entityBonus) reasons.push('entity_match');
    if (speakerBonus) reasons.push('speaker_match');
    if (goalBonus) reasons.push('goal_match');
    if (sceneBonus) reasons.push('scene_tag_match');
    if (recentlyUsed) reasons.push('recently_used_penalty');

    scored.push({
      memoryId: memory.memoryId,
      memory,
      relevanceScore: +Math.max(0, score).toFixed(3),
      retrievalReason: reasons.join('+') || 'weak_signal',
      confidence: memory.confidence,
      provenanceSummary: `${memory.source.evidenceType} · ${memory.source.extractionMethod}${memory.source.interactionId ? ` · ${memory.source.interactionId}` : ''}`,
      estimatedTokenCost: estimateTokens(memory),
    });
  }

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const selected = [];
  let tokensUsed = 0;
  for (const entry of scored) {
    if (selected.length >= maximumMemories) break;
    if (tokensUsed + entry.estimatedTokenCost > tokenBudget) continue;
    selected.push(entry);
    tokensUsed += entry.estimatedTokenCost;
  }

  if (signal?.aborted || !isStillCurrent()) return { memories: [], matchType, interactionId, aborted: true };
  if (selected.length) repository.markAccessed(selected.map((e) => e.memoryId));

  return { memories: selected, matchType: selected.length ? matchType : 'none', interactionId, currentTurnId, aborted: false };
}
