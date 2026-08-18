// Context Compiler — the read side of the perception system. Turns the full
// structured Live Scene State into a COMPACT, agent-facing text snapshot at the
// moment the main agent is about to think. The full state stays in the scene
// store (outside the model); only this small block enters an inference, and it is
// attached ephemerally — never persisted into conversation history.
//
// Pure and dependency-free so tests and the Node simulation compile snapshots
// identical to the browser's.

import { now, formatAge } from '../clock.js';

/** Scene data older than this is flagged so the agent doesn't trust a dead feed. */
export const STALE_AFTER_MS = 10000;

export function isStale(state, at = now(), staleAfterMs = STALE_AFTER_MS) {
  return !state?.updatedAt || at - state.updatedAt > staleAfterMs;
}

/**
 * @param {object|null} state — sceneStore.getState()
 * @param {{ at?: number, maxObjects?: number, maxEvents?: number, eventWindowMs?: number }} [options]
 * @returns {string} compact snapshot, or '' when there is nothing useful to attach
 */
export function compileSceneSnapshot(state, { at = now(), maxObjects = 8, maxEvents = 3, eventWindowMs = 60000 } = {}) {
  if (!state || !state.updatedAt) return '';

  const lines = ['Current visual context:'];
  const { label, summary } = state.scene ?? {};
  lines.push(`- Scene: ${label ?? 'unknown'}${summary ? ` — ${summary}` : ''}`);

  const visible = (state.objects ?? [])
    .filter((o) => o.visibility === 'visible')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  if (visible.length) {
    const shown = visible.slice(0, maxObjects).map((o) => `${o.label} (${o.position})`);
    const extra = visible.length - shown.length;
    lines.push(`- Visible objects: ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  } else {
    lines.push('- Visible objects: none detected');
  }

  const missing = (state.objects ?? []).filter((o) => o.visibility === 'missing').slice(0, 3);
  if (missing.length) {
    lines.push(`- Recently out of view: ${missing.map((o) => `${o.label} (last seen ${formatAge(at - o.lastSeenAt)} ago)`).join(', ')}`);
  }

  const people = state.people ?? [];
  if (people.length) {
    const parts = people.map((p) => (p.identity ? `${p.identity} (${Math.round((p.confidence ?? 0) * 100)}%)` : 'unidentified person'));
    lines.push(`- People present: ${parts.join(', ')}`);
  }

  const events = (state.recentEvents ?? []).filter((e) => at - e.at <= eventWindowMs).slice(-maxEvents);
  if (events.length) {
    lines.push(`- Recent events: ${events.map((e) => `${e.message} (${formatAge(at - e.at)} ago)`).join('; ')}`);
  }

  const age = at - state.updatedAt;
  lines.push(`- Scene state updated ${formatAge(age)} ago${isStale(state, at) ? ' (STALE — treat as possibly outdated)' : ''}`);

  return lines.join('\n');
}
