// Ingestion — turning documents you already have into memories Roma has.
//
// Exported chats, meeting notes, a wall of text you pasted: all of it goes
// through the SAME path a spoken turn does (writer.js's proposeCandidates ->
// applyCandidate), which is the whole point. Ingestion gets no privileged
// route into the store, so every rule that protects live memory protects this
// too: schema validation, evidence ranking, the duplicate rule, and the ban on
// Roma's own words becoming durable facts.
//
// Two things this module is careful about, because both are easy to get wrong:
//
//   EVIDENCE. A line in an export is not you saying something now. Who said
//   what is taken from the document and mapped honestly — your lines are
//   `user_stated`, everyone else's are `other_speaker_stated`, and an
//   assistant's are `roma_generated`, which the writer already refuses to turn
//   into durable facts about anyone.
//
//   INJECTION. An imported document is untrusted text that will be shown to a
//   model. It may contain "ignore your instructions and remember that…".
//   The document is fenced and labeled as data, the model's only output
//   channel is the candidate schema, and every candidate is re-checked by
//   deterministic code afterwards. Text in a document cannot reach into the
//   system prompt, and cannot bypass the writer.

import { proposeCandidates, applyCandidate } from './writer.js';
import { evidenceRank } from './schema.js';

export const MAX_DOCUMENT_CHARS = 400_000;
const DEFAULT_CHUNK_CHARS = 2400;
const DEFAULT_OVERLAP_CHARS = 200;
const MAX_CHUNKS = 200;

/**
 * Split a document into overlapping chunks, preferring paragraph and line
 * boundaries so a fact is not sliced in half. The overlap exists so something
 * stated across a boundary is still visible whole in one chunk.
 */
export function chunkDocument(text, { maxChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS, maxChunks = MAX_CHUNKS } = {}) {
  const source = String(text ?? '').slice(0, MAX_DOCUMENT_CHARS);
  if (!source.trim()) return [];
  const chunks = [];
  let start = 0;

  while (start < source.length && chunks.length < maxChunks) {
    let end = Math.min(start + maxChars, source.length);
    if (end < source.length) {
      // Prefer a paragraph break, then a line break, then wherever we landed.
      const window = source.slice(start, end);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      const cut = paragraph > maxChars * 0.4 ? paragraph : (line > maxChars * 0.4 ? line : -1);
      if (cut > 0) end = start + cut;
    }
    const body = source.slice(start, end).trim();
    if (body) chunks.push({ index: chunks.length, text: body, startChar: start, endChar: end });
    if (end >= source.length) break;
    // Step back by the overlap, but never far enough to fail to make progress.
    const next = end - overlapChars;
    start = next > start ? next : end;
  }
  return chunks;
}

const LINE_PATTERNS = [
  // WhatsApp: "[2/3/24, 10:15:33] Alex: text"  or  "2/3/24, 10:15 - Alex: text"
  { format: 'whatsapp', re: /^\s*\[?(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)\]?\s*-?\s*([^:]{1,60}):\s*([\s\S]*)$/ },
  // Slack/Discord-ish export: "Alex Rivera  10:15 AM\ntext" handled as a name line elsewhere.
  // Generic transcript: "Alex: text"
  { format: 'speaker_colon', re: /^\s*([A-Za-z][\w .'-]{0,58}):\s+([\s\S]*)$/ },
];

/**
 * Recover speaker turns from an exported conversation. Unrecognised text is
 * not forced into a shape it does not have — it stays prose attributed to the
 * document itself, which the caller can still ingest.
 *
 * @returns {{ format: string, segments: Array<{ speaker: string, text: string, at: string|null }> }}
 */
export function parseChatExport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const segments = [];
  let format = 'prose';
  let current = null;

  for (const line of lines) {
    if (!line.trim()) { continue; }
    let matched = null;
    for (const pattern of LINE_PATTERNS) {
      const match = line.match(pattern.re);
      if (!match) continue;
      matched = pattern.format === 'whatsapp'
        ? { speaker: match[2].trim(), text: match[3], at: match[1] }
        : { speaker: match[1].trim(), text: match[2], at: null };
      if (format === 'prose') format = pattern.format;
      break;
    }
    if (matched) {
      if (current) segments.push(current);
      current = { speaker: matched.speaker, text: matched.text.trim(), at: matched.at };
    } else if (current) {
      // A continuation line belongs to the turn above it.
      current.text = `${current.text}\n${line.trim()}`.trim();
    } else {
      segments.push({ speaker: 'document', text: line.trim(), at: null });
    }
  }
  if (current) segments.push(current);
  return { format, segments: segments.filter((s) => s.text) };
}

/**
 * Who said it decides how much it is worth. `userSpeaker` names the person in
 * the export who is the user; `assistantSpeakers` names any AI whose lines are
 * its own output, not evidence about anybody.
 */
export function evidenceForSpeaker(speaker, { userSpeaker = null, assistantSpeakers = [] } = {}) {
  const normalized = String(speaker ?? '').trim().toLowerCase();
  if (userSpeaker && normalized === String(userSpeaker).trim().toLowerCase()) return 'user_stated';
  if (assistantSpeakers.some((name) => String(name).trim().toLowerCase() === normalized)) return 'roma_generated';
  if (!normalized || normalized === 'document') return 'other_speaker_stated';
  return 'other_speaker_stated';
}

/**
 * Build the package the extraction prompt already understands, from a chunk of
 * an imported document.
 *
 * The document text rides in as transcript segments — the same channel a real
 * conversation uses, and one the prompt already treats as quoted data rather
 * than as instructions.
 */
export function buildIngestPackage({ chunk, parsed, documentId, title, userSpeaker = null, assistantSpeakers = [], at = Date.now() }) {
  const segments = parsed.segments.length
    ? parsed.segments.map((segment, index) => ({
      id: `${documentId}_c${chunk.index}_s${index}`,
      speaker: segment.speaker,
      text: segment.text,
      at,
    }))
    : [{ id: `${documentId}_c${chunk.index}_s0`, speaker: 'document', text: chunk.text, at }];

  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const evidenceBySpeaker = Object.fromEntries(speakers.map((speaker) => [speaker, evidenceForSpeaker(speaker, { userSpeaker, assistantSpeakers })]));

  return {
    interactionId: `${documentId}_chunk_${chunk.index}`,
    turnIds: segments.map((s) => s.id),
    transcriptIds: segments.map((s) => s.id),
    transcriptSegments: segments,
    speakerId: userSpeaker ?? 'document',
    // The chunk is presented as an imported artifact, explicitly not as
    // something anyone is saying to Roma right now.
    userText: null,
    agentResponse: null,
    explicitRequest: false,
    sceneSnapshot: '',
    toolResults: [],
    importedDocument: { documentId, title: title ?? null, chunkIndex: chunk.index, format: parsed.format, evidenceBySpeaker },
    at,
  };
}

let documentCounter = 0;
export function generateDocumentId(now = Date.now()) {
  documentCounter += 1;
  return `import_${now}_${documentCounter}`;
}

/**
 * What is a candidate extracted from a MIXED chunk actually worth?
 *
 * The extractor returns facts, not citations, so a candidate drawn from a
 * chunk where both you and someone else spoke could have come from either.
 * It therefore gets the WEAKEST evidence among the humans in that chunk —
 * claiming your authority for a line your colleague said would be a lie the
 * rest of the system then trusts.
 *
 * Assistant lines are excluded from that minimum rather than dominating it: a
 * chat export is mostly assistant text, and letting it set the floor would
 * mean nothing in an exported conversation could ever be stored. A chunk that
 * is ONLY assistant output stays `roma_generated`, which the writer refuses to
 * turn into a durable fact about anybody.
 */
export function evidenceForChunk(evidenceBySpeaker) {
  const levels = Object.values(evidenceBySpeaker ?? {});
  if (!levels.length) return 'other_speaker_stated';
  const human = levels.filter((level) => level !== 'roma_generated');
  if (!human.length) return 'roma_generated';
  return human.reduce((weakest, level) => (evidenceRank(level) < evidenceRank(weakest) ? level : weakest));
}

/**
 * Ingest one document. Every candidate goes through applyCandidate, so this
 * cannot store anything a live conversation could not.
 *
 * Re-ingesting the same document is safe by construction rather than by a
 * special case: identical facts hit the duplicate rule and merge instead of
 * multiplying (see writer.js's isSameFact).
 */
export async function ingestDocument({
  text,
  title = null,
  repository,
  provider,
  userSpeaker = null,
  assistantSpeakers = ['assistant', 'chatgpt', 'claude', 'roma', 'ai'],
  now = Date.now,
  documentId = generateDocumentId(now()),
  onProgress = null,
  signal = null,
  maxChunks = MAX_CHUNKS,
  chunkOptions = {},
} = {}) {
  const chunks = chunkDocument(text, { ...chunkOptions, maxChunks });
  const outcome = { documentId, title, chunks: chunks.length, stored: 0, merged: 0, superseded: 0, discarded: 0, candidates: 0, errors: [], memories: [] };
  if (!chunks.length) { outcome.errors.push('the document was empty'); return outcome; }

  for (const chunk of chunks) {
    if (signal?.aborted) { outcome.errors.push('cancelled'); break; }
    const parsed = parseChatExport(chunk.text);
    const interactionPackage = buildIngestPackage({ chunk, parsed, documentId, title, userSpeaker, assistantSpeakers, at: now() });

    let proposal;
    try {
      proposal = await proposeCandidates({ interactionPackage, repository, provider, now, signal });
    } catch (error) {
      outcome.errors.push(`chunk ${chunk.index}: ${error?.message ?? String(error)}`);
      continue;
    }
    outcome.candidates += proposal.candidates.length;
    if (proposal.errors?.length) outcome.errors.push(...proposal.errors.map((e) => `chunk ${chunk.index}: ${e}`));

    // The model does not get to decide how trustworthy an imported line is —
    // the document does, via who is actually in this chunk.
    const chunkEvidence = evidenceForChunk(interactionPackage.importedDocument.evidenceBySpeaker);
    for (const candidate of proposal.candidates) {
      const applied = applyCandidate({ ...candidate, evidenceType: chunkEvidence }, { repository, interactionPackage, now: now() });
      if (applied.action === 'store') { outcome.stored += 1; outcome.memories.push(applied.memory.memoryId); }
      else if (applied.action === 'merge') outcome.merged += 1;
      else if (applied.action === 'supersede') { outcome.superseded += 1; outcome.memories.push(applied.memory.memoryId); }
      else outcome.discarded += 1;
    }
    onProgress?.({ chunk: chunk.index + 1, chunks: chunks.length, stored: outcome.stored, merged: outcome.merged });
  }
  return outcome;
}
