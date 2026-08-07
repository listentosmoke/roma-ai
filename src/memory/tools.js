// Memory tools — additive entries in the SAME tool registry the reactive agent
// already uses (agent/tools.js's createToolRegistry). No change to the agent
// decision schema is needed: the model recognizes an explicit memory request
// exactly like any other request and issues a normal `tool_call` decision,
// then (per the existing bounded follow-up mechanism) turns the tool result
// into a `respond`/`clarify`. Registering these is the only integration point.

/**
 * @param {ReturnType<typeof import('../agent/tools.js').createToolRegistry>} registry
 * @param {{ memory: ReturnType<typeof import('./coordinator.js').createMemoryCoordinator> }} deps
 */
export function registerMemoryTools(registry, { memory }) {
  registry.register({
    name: 'remember_this',
    description: 'Store an explicit memory the user asked you to remember (e.g. "remember that I need to send Matt the quote"). Pass their exact statement as text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute({ text }, context) {
      if (!memory) return { ok: false, note: 'Memory is not available.' };
      const result = await memory.remember(text, { interactionId: context?.interactionId ?? null, turnId: context?.turnId ?? null, speakerId: context?.speaker ?? null });
      return { stored: result.stored, applied: result.applied };
    },
  });

  registry.register({
    name: 'recall_memories',
    description: 'Search stored memories relevant to a question (e.g. "what did Matt say about the quote?"). Returns a short ranked list, not the whole memory database.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute({ query }, context) {
      if (!memory) return { ok: false, note: 'Memory is not available.' };
      const result = await memory.recall(query, { currentTurnId: context?.turnId ?? null, speakerIds: context?.speaker ? [context.speaker] : [] });
      return {
        matchType: result.matchType,
        memories: result.memories.map((m) => ({ memoryId: m.memoryId, summary: m.memory.summary, type: m.memory.type, confidence: m.confidence, relevanceScore: m.relevanceScore })),
      };
    },
  });

  registry.register({
    name: 'forget_memory',
    description: 'Delete a memory the user wants forgotten (e.g. "forget the Matt quote thing"). If more than one memory could match, this returns candidates instead of deleting anything — ask the user which one and call this again once they clarify.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute({ query }) {
      if (!memory) return { ok: false, note: 'Memory is not available.' };
      return memory.forget(query);
    },
  });

  registry.register({
    name: 'correct_memory',
    description: 'Correct or replace an earlier memory (e.g. "actually, Matt can\'t meet Fridays anymore"). Finds the best matching prior memory and supersedes it with the corrected text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, corrected_text: { type: 'string' } }, required: ['query', 'corrected_text'] },
    async execute({ query, corrected_text: correctedText }, context) {
      if (!memory) return { ok: false, note: 'Memory is not available.' };
      return memory.correct(query, correctedText, { interactionId: context?.interactionId ?? null, turnId: context?.turnId ?? null, speakerId: context?.speaker ?? null });
    },
  });

  registry.register({
    name: 'explain_memory',
    description: 'Explain why/how a specific memory was remembered — its evidence and provenance (e.g. "why do you think that?" or "show why you remembered that"). Pass the memory ID from a previous recall_memories result.',
    inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
    async execute({ memory_id: memoryId }) {
      if (!memory) return { ok: false, note: 'Memory is not available.' };
      return memory.explain(memoryId);
    },
  });
}
