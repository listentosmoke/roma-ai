// Speech-text preparation — the last transform before synthesis. Turns a
// user-facing text (which may contain Markdown, or in a bug case JSON/debug
// fragments) into a clean, natural, bounded utterance. Pure and unit-tested.
//
// Rules (from the spec):
//  - strip Markdown formatting (**bold**, _italic_, `code`, links, headings)
//  - never speak JSON blobs or internal event fields
//  - normalize punctuation/whitespace for natural speech
//  - enforce a configurable maximum length
//  - empty/whitespace-only text is NOT synthesizable (returns ok:false)

function stripMarkdown(text) {
  return text
    // fenced/inline code
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // images ![alt](url) and links [text](url) -> visible text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // bold/italic/strikethrough markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // headings / blockquotes / list bullets at line starts
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '');
}

// A crude but effective guard: text that is actually a JSON object/array or a
// key:value debug fragment must never be spoken.
function looksLikeStructuredData(text) {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try { JSON.parse(trimmed); return true; } catch { /* not valid JSON — fall through */ }
  }
  // e.g. `"decision":"respond"` or `authorizationId: speech_auth_1`
  if (/["']?\b(decision|authorizationId|turnId|reason_summary|deliveryRecommendation)\b["']?\s*[:=]/.test(trimmed)) return true;
  return false;
}

function normalizePunctuation(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1') // no space before punctuation
    .replace(/([,.;:!?]){2,}/g, '$1') // collapse repeats
    .trim();
}

/**
 * @param {string} rawText
 * @param {{ maxLength?: number }} [options]
 * @returns {{ ok: boolean, text: string, reason?: string, truncated?: boolean }}
 */
export function prepareSpeechText(rawText, { maxLength = 320 } = {}) {
  if (typeof rawText !== 'string') return { ok: false, text: '', reason: 'not a string' };
  if (looksLikeStructuredData(rawText)) return { ok: false, text: '', reason: 'refused to speak structured/debug data' };

  let text = normalizePunctuation(stripMarkdown(rawText));
  if (!text) return { ok: false, text: '', reason: 'empty after cleanup' };

  let truncated = false;
  if (text.length > maxLength) {
    // Cut at the last sentence boundary within the limit, else a word boundary.
    const slice = text.slice(0, maxLength);
    const lastSentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    const cut = lastSentence > maxLength * 0.5 ? lastSentence + 1 : slice.lastIndexOf(' ');
    text = (cut > 0 ? slice.slice(0, cut) : slice).trim();
    truncated = true;
  }

  return { ok: true, text, truncated };
}
