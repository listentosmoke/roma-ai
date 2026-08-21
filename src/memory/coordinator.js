// Top-level Memory API — combines the repository, writer, and retriever into
// the handful of operations the rest of the app actually needs: write a
// completed interaction, retrieve for the next one, and the explicit
// remember/recall/forget/correct/explain operations. This is what
// scripts/simulate-memory.mjs, the memory test suite, and src/useMemory.js all
// talk to; none of them touch repository/writer/retriever internals directly.
//
// Every mutating or model-assisted call emits an event (subscribe()) so the
// dev Memory panel and diagnostics can show exactly what happened — no hidden
// reasoning, only structured outcomes and reason codes.

import { writeInteraction as writerWriteInteraction, proposeCandidates, applyCandidate } from './writer.js';
import { ingestDocument as ingest } from './ingest.js';
import { retrieve as retrieverRetrieve } from './retriever.js';

const MIN_UNIQUE_MARGIN = 0.15;

function pickTarget(candidates) {
  if (!candidates.length) return { outcome: 'not_found', candidates: [] };
  if (candidates.length === 1) return { outcome: 'unique', target: candidates[0], candidates };
  const [top, second] = candidates;
  if (top.relevanceScore - second.relevanceScore > MIN_UNIQUE_MARGIN) return { outcome: 'unique', target: top, candidates };
  return { outcome: 'ambiguous', candidates };
}

function historyChain(repository, memoryId, depth = 0) {
  if (!memoryId || depth > 10) return [];
  const memory = repository.get(memoryId);
  if (!memory) return [];
  return [memory, ...memory.supersedes.flatMap((id) => historyChain(repository, id, depth + 1))];
}

export function createMemoryCoordinator({ repository, provider, now = Date.now, embedder = null } = {}) {
  // `embedder` may be a live getter, because the real one is only available
  // after the server reports which model it holds — and the coordinator is
  // built synchronously, before that answer arrives. Passing an object still
  // works exactly as before.
  const currentEmbedder = typeof embedder === 'function' ? embedder : () => embedder;
  const listeners = new Set();
  function emit(event) {
    const full = { at: now(), ...event };
    for (const listener of listeners) listener(full);
    return full;
  }

  function applySummary(applied) {
    return applied.map((a) => ({
      action: a.action,
      reasonCode: a.reasonCode,
      memoryId: a.memory?.memoryId ?? null,
      summary: a.memory?.summary ?? a.candidate?.summary ?? null,
      type: a.candidate?.type ?? a.memory?.type ?? null,
    }));
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /** Automatic write boundary — called once per completed agent-involved interaction. */
    /**
     * Ingest a document you already have — an exported chat, notes, anything
     * pasted. Goes through the same writer as a spoken turn (see
     * memory/ingest.js), so it can store nothing a conversation could not.
     */
    async ingestDocument({ text, title = null, userSpeaker = null, assistantSpeakers, onProgress = null } = {}, { signal } = {}) {
      const result = await ingest({ text, title, userSpeaker, assistantSpeakers, repository, provider, now, onProgress, signal });
      emit({
        type: 'memory-ingested',
        documentId: result.documentId,
        title: result.title,
        chunks: result.chunks,
        stored: result.stored,
        merged: result.merged,
        discarded: result.discarded,
        errors: result.errors,
      });
      return result;
    },

    async writeInteraction(interactionPackage, { signal } = {}) {
      const result = await writerWriteInteraction({ interactionPackage, repository, provider, now, signal });
      if (result.skipped) { emit({ type: 'memory-write-skipped', reason: result.reason, interactionId: interactionPackage.interactionId }); return result; }
      for (const applied of result.applied) {
        emit({
          type: `memory-${applied.action}`,
          interactionId: interactionPackage.interactionId,
          memoryId: applied.memory?.memoryId ?? null,
          candidateType: applied.candidate.type,
          summary: applied.memory?.summary ?? applied.candidate.summary,
          reasonCode: applied.reasonCode,
          confidence: applied.candidate.confidence,
        });
      }
      return { ...result, applied: applySummary(result.applied) };
    },

    /** Retrieval for the NEXT turn's context assembly. Never bypasses the agent/Speech Gate — output is context only. */
    async retrieve(query) {
      const result = await retrieverRetrieve({ repository, embedder: currentEmbedder(), ...query });
      emit({
        type: 'memory-retrieved',
        query: query.query ?? '',
        turnId: query.currentTurnId ?? null,
        interactionId: query.interactionId ?? null,
        matchType: result.matchType,
        count: result.memories.length,
        memoryIds: result.memories.map((m) => m.memoryId),
      });
      return result;
    },

    /** Explicit "remember that…" — always attempts to store (no ambiguity to resolve). */
    async remember(text, { interactionId = null, turnId = null, speakerId = null, signal } = {}) {
      const result = await writerWriteInteraction({
        interactionPackage: { interactionId, turnIds: turnId != null ? [turnId] : [], transcriptIds: [], userText: text, agentResponse: null, toolResults: [], speakerId, explicitRequest: true, explicitText: text, completed: true },
        repository, provider, now, signal,
      });
      for (const applied of result.applied ?? []) {
        emit({ type: `memory-${applied.action}`, memoryId: applied.memory?.memoryId ?? null, summary: applied.memory?.summary ?? applied.candidate.summary, reasonCode: applied.reasonCode, explicit: true });
      }
      return { stored: (result.applied ?? []).some((a) => ['store', 'merge', 'supersede'].includes(a.action)), applied: applySummary(result.applied ?? []) };
    },

    /** Explicit "what do you remember about…?" — thin wrapper over retrieve() with a generous budget. */
    async recall(query, options = {}) {
      return this.retrieve({ query, maximumMemories: 5, tokenBudget: 600, ...options });
    },

    /** Explicit "forget that…" — deletes only when a single candidate is clearly the best match; otherwise returns bounded candidates for disambiguation. */
    async forget(query, options = {}) {
      const result = await retrieverRetrieve({ repository, embedder: currentEmbedder(), query, maximumMemories: 5, includeHistorical: false, ...options });
      const pick = pickTarget(result.memories);
      if (pick.outcome === 'not_found') { emit({ type: 'memory-forget-not-found', query }); return { outcome: 'not_found' }; }
      if (pick.outcome === 'ambiguous') {
        emit({ type: 'memory-forget-ambiguous', query, candidateIds: pick.candidates.map((c) => c.memoryId) });
        return { outcome: 'ambiguous', candidates: pick.candidates.map((c) => ({ memoryId: c.memoryId, summary: c.memory.summary, relevanceScore: c.relevanceScore })) };
      }
      const deleted = repository.delete(pick.target.memoryId);
      emit({ type: 'memory-deleted', memoryId: pick.target.memoryId, summary: pick.target.memory.summary, reason: 'explicit forget request' });
      return { outcome: 'deleted', memoryId: pick.target.memoryId, summary: pick.target.memory.summary, deleted };
    },

    /**
     * Explicit "correct that…" — supersedes the best match with `correctedText`.
     * Evidence is forced to user_corrected (the highest authority rank), so a
     * genuine user correction always outranks whatever produced the original
     * memory, per the evidence-authority rule in writer.js.
     */
    async correct(query, correctedText, { interactionId = null, turnId = null, speakerId = null, signal } = {}) {
      const found = await retrieverRetrieve({ repository, embedder: currentEmbedder(), query, maximumMemories: 5, ...{} });
      const pick = pickTarget(found.memories);
      if (pick.outcome === 'ambiguous') {
        emit({ type: 'memory-correct-ambiguous', query, candidateIds: pick.candidates.map((c) => c.memoryId) });
        return { outcome: 'ambiguous', candidates: pick.candidates.map((c) => ({ memoryId: c.memoryId, summary: c.memory.summary })) };
      }
      const targetId = pick.outcome === 'unique' ? pick.target.memoryId : null;

      // propose-only (NOT writeInteraction, which would also apply/store the
      // model's raw proposal) — this method applies exactly once, below, with
      // the forced correction fields. Calling writeInteraction here would
      // double-store: once for the model's own guess, once for the forced one.
      const proposed = await proposeCandidates({
        interactionPackage: { interactionId, turnIds: turnId != null ? [turnId] : [], transcriptIds: [], userText: correctedText, agentResponse: null, toolResults: [], speakerId, explicitRequest: true, explicitText: correctedText, completed: true },
        repository, provider, now, signal,
      });
      // Force the correction to target the resolved memory with the highest
      // evidence authority, regardless of what the model itself proposed.
      const candidates = (proposed.candidates ?? []).map((c) => (targetId ? { ...c, action: 'supersede', supersedesMemoryId: targetId, evidenceType: 'user_corrected' } : { ...c, evidenceType: 'user_corrected' }));
      const applied = candidates.map((candidate) => ({ candidate, ...applyCandidate(candidate, { repository, interactionPackage: { interactionId, speakerId }, now: now() }) }));
      for (const a of applied) emit({ type: `memory-${a.action}`, memoryId: a.memory?.memoryId ?? null, summary: a.memory?.summary ?? a.candidate.summary, reasonCode: a.reasonCode, explicit: true, correction: true });
      return { outcome: applied.length ? 'corrected' : 'no_change', applied: applySummary(applied), targetId };
    },

    /** "Show why you remembered that." — provenance + supersession history, no raw prompts. */
    explain(memoryIdOrQuery) {
      const direct = repository.get(memoryIdOrQuery);
      const memory = direct ?? null;
      if (!memory) return { found: false };
      const chain = historyChain(repository, memory.memoryId).slice(1); // exclude self
      emit({ type: 'memory-explained', memoryId: memory.memoryId });
      return {
        found: true,
        memoryId: memory.memoryId,
        summary: memory.summary,
        type: memory.type,
        status: memory.status,
        confidence: memory.confidence,
        importance: memory.importance,
        evidenceType: memory.source.evidenceType,
        extractionMethod: memory.source.extractionMethod,
        interactionId: memory.source.interactionId,
        supersedes: chain.map((m) => ({ memoryId: m.memoryId, summary: m.summary, status: m.status })),
        supersededBy: memory.supersededBy,
      };
    },

    list(filters = {}) { return repository.searchStructured(filters); },
    get(memoryId) { return repository.get(memoryId); },
    counts() {
      const all = repository.exportAll();
      const byType = {};
      for (const m of all) byType[m.type] = (byType[m.type] ?? 0) + 1;
      return { total: all.length, active: all.filter((m) => m.status === 'active').length, byType };
    },
    deleteMemory(memoryId) {
      const memory = repository.get(memoryId);
      const deleted = repository.delete(memoryId);
      if (deleted) emit({ type: 'memory-deleted', memoryId, summary: memory?.summary ?? null, reason: 'manual delete' });
      return deleted;
    },
    deleteBySource(interactionId) {
      // Captured BEFORE deletion so the event can carry which memories were
      // removed — fixes the known gap where a bulk deleteBySource left
      // identity's person<->memory links dangling (identity/coordinator.js's
      // attachMemoryLifecycle listens for this exact `memoryIds` field).
      const memoryIds = repository.exportAll().filter((m) => m.source.interactionId === interactionId).map((m) => m.memoryId);
      const count = repository.deleteBySource(interactionId);
      emit({ type: 'memory-deleted-by-source', interactionId, count, memoryIds });
      return count;
    },
    clearAll() {
      repository.clearAll();
      emit({ type: 'memory-cleared-all' });
    },
    exportAll() { return repository.exportAll(); },
    embedderStatus() { const active = currentEmbedder(); return { configured: Boolean(active), name: active?.name ?? null, model: active?.model ?? null, dimensions: active?.dimensions ?? null }; },
  };
}
