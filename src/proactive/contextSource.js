// Future context-source interface — texts, calendars, notes, email, device
// state will eventually plug in behind this contract:
//
//   source.getRelevantContext({ query, entities, timeRange, limit, signal })
//     -> Promise<Array<{ source, summary, at?, relevance? }>>
//
// Nothing real is connected in this phase (no vector search, no permanent
// memory). The Opportunity Engine works with zero sources configured; the mock
// exists so tests and future integrations have a fixed shape to build against.

export function createMockContextSource(name, items = []) {
  return {
    name,
    async getRelevantContext({ query = '', entities = [], limit = 5 } = {}) {
      const terms = [query, ...entities.map((e) => `${e.value ?? e}`)].join(' ').toLowerCase().split(/\s+/).filter(Boolean);
      const scored = items
        .map((item) => ({
          item,
          hits: terms.filter((term) => `${item.summary ?? ''} ${item.content ?? ''}`.toLowerCase().includes(term)).length,
        }))
        .filter(({ hits }) => terms.length === 0 || hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, limit)
        .map(({ item }) => ({ source: name, ...item }));
      return scored;
    },
  };
}

/** Query all configured sources, tolerating individual failures. */
export async function gatherContext(sources = [], request = {}) {
  if (!sources.length) return [];
  const results = await Promise.allSettled(sources.map((source) => source.getRelevantContext(request)));
  return results.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
}
