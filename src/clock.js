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

/**
 * What time it is, in the terms a person uses. Roma had timestamps on
 * transcript turns and no idea what DAY it was — which is why she could not be
 * prudent about anything: "before Friday" means nothing without knowing today
 * is Thursday.
 *
 * Deliberately local-time and human-shaped. The model reasons about "this
 * afternoon" and "tomorrow", not about epoch milliseconds.
 */
export function describeNow(at = now()) {
  const date = new Date(at);
  const hour = date.getHours();
  const partOfDay = hour < 5 ? 'night'
    : hour < 12 ? 'morning'
      : hour < 17 ? 'afternoon'
        : hour < 21 ? 'evening'
          : 'night';
  return {
    at,
    iso: date.toISOString(),
    weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
    date: date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    partOfDay,
    isWeekend: date.getDay() === 0 || date.getDay() === 6,
  };
}

/** "in 3 hours", "tomorrow", "2 days ago" — how far off something is, in words. */
export function describeWhen(target, at = now()) {
  if (!Number.isFinite(target)) return null;
  const deltaMs = target - at;
  const overdue = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  let phrase;
  if (minutes < 60) phrase = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  else if (hours < 24) phrase = `${hours} hour${hours === 1 ? '' : 's'}`;
  else phrase = `${days} day${days === 1 ? '' : 's'}`;

  return { overdue, deltaMs, phrase, text: overdue ? `${phrase} overdue` : `in ${phrase}` };
}
