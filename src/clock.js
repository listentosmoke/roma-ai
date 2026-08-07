// Shared wall clock for aligning audio and video. Everything in the perception
// stack (scene state, frames, events, transcript segments) is stamped with epoch
// milliseconds from now(). Deepgram reports stream-relative SECONDS per word/turn;
// convert those with toEpochMs(sessionStartMs, seconds) so a transcript line and a
// video frame can be compared directly.

export const now = () => Date.now();

export function toEpochMs(sessionStartMs, streamSeconds) {
  return Math.round(sessionStartMs + (streamSeconds ?? 0) * 1000);
}

export function ageMs(timestampMs, at = now()) {
  return Math.max(0, at - (timestampMs ?? at));
}

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60000)} min`;
}
