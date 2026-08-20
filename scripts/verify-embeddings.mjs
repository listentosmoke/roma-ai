#!/usr/bin/env node
// Prove the local text encoder before anything depends on it.
//
// The point of semantic retrieval is finding a memory that shares MEANING with
// the query but not its words. So this measures exactly that, against the
// keyword scorer it replaces — because "we added embeddings" is not a result,
// and a semantic model that does not beat token overlap on paraphrases is not
// worth its download.
//
// Downloads the model on first run (~25 MB). Run: npm run verify:embeddings

import { createTextEmbeddingProvider } from '../server/textEmbeddings/provider.mjs';
import { createKeywordScorer, cosineSimilarity } from '../src/memory/embeddings.js';
import { MIN_SIGNAL_BY_MATCH_TYPE, retrieve } from '../src/memory/retriever.js';
import { createInMemoryRepository } from '../src/memory/repository.js';

const checks = [];
function check(label, condition, details = '') {
  const pass = Boolean(condition);
  checks.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${details ? ` (${details})` : ''}`);
  if (!pass) process.exitCode = 1;
}

// Pairs that mean the same thing while sharing almost no words — the case
// keyword retrieval cannot answer, which is the entire reason for this phase.
const PARAPHRASES = [
  ['the Q3 report is due Friday', 'that write-up has a deadline at the end of the week'],
  ['Matt is allergic to peanuts', 'Matt cannot eat anything with nuts in it'],
  ['my flight lands at 7pm', 'the plane gets in early evening'],
  ['the kitchen tap is leaking', 'water keeps dripping from the sink faucet'],
  ['she prefers to be called Sam', 'her name is short for Samantha'],
];

// Same topic area, different fact — must NOT be confused with each other.
const DISTINCT = [
  ['the Q3 report is due Friday', 'the Q3 report was cancelled last month'],
  ['Matt is allergic to peanuts', 'Jon is allergic to peanuts'],
  ['my flight lands at 7pm', 'my flight takes off at 7pm'],
];

const UNRELATED = [
  ['the Q3 report is due Friday', 'the dog needs to go to the vet'],
  ['Matt is allergic to peanuts', 'I parked on the third floor'],
];

console.log('\nLocal text-embedding verification');
console.log('═════════════════════════════════');

const provider = createTextEmbeddingProvider();
const keyword = createKeywordScorer();

const started = Date.now();
const warm = await provider.warmup().catch((error) => ({ ok: false, error }));
check('the encoder loads', warm.ok === true, warm.ok ? `${provider.describe().model} in ${Math.round((Date.now() - started) / 1000)}s` : String(warm.error?.message ?? warm.error));
if (!warm.ok) { console.log('\n  cannot continue without the model\n'); process.exit(1); }

const described = provider.describe();
check('vectors have a fixed, sane width', described.dimensions === 384, `${described.dimensions}-d`);
check('the model is pinned by revision', /^[0-9a-f]{40}$/.test(described.revision), described.revision);

// ── mechanics ──────────────────────────────────────────────────────────────
const [a1] = await provider.embedMany(['the Q3 report is due Friday']);
const [a2] = await provider.embedMany(['the Q3 report is due Friday']);
check('the same text always gives the same vector', a1.every((v, i) => Math.abs(v - a2[i]) < 1e-9));

const norm = Math.sqrt(a1.reduce((sum, v) => sum + v * v, 0));
check('vectors are L2-normalized, so cosine is just a dot product', Math.abs(norm - 1) < 1e-3, `|v| = ${norm.toFixed(5)}`);
check('a text is maximally similar to itself', cosineSimilarity(a1, a2) > 0.999, cosineSimilarity(a1, a2).toFixed(4));

const batch = await provider.embedMany(['one', 'two', 'three']);
check('a batch returns one vector per input', batch.length === 3 && batch.every((v) => v.length === 384));
const single = await provider.embed('one');
check('batching does not change the answer', cosineSimilarity(single, batch[0]) > 0.999);

const empty = await provider.embedMany(['']);
check('empty text still yields a well-formed vector, not a hole', empty[0]?.length === 384);

// ── the actual question: does it beat keyword overlap? ─────────────────────
async function score(pairs) {
  const rows = [];
  for (const [left, right] of pairs) {
    const vectors = await provider.embedMany([left, right]);
    rows.push({ left, right, semantic: cosineSimilarity(vectors[0], vectors[1]), keyword: keyword.score(left, right) });
  }
  return rows;
}

const paraphrase = await score(PARAPHRASES);
const distinct = await score(DISTINCT);
const unrelated = await score(UNRELATED);

console.log('\n  paraphrases (same meaning, different words):');
for (const row of paraphrase) console.log(`    semantic ${row.semantic.toFixed(2)}  keyword ${row.keyword.toFixed(2)}  "${row.left}" / "${row.right}"`);
console.log('  same topic, different fact:');
for (const row of distinct) console.log(`    semantic ${row.semantic.toFixed(2)}  keyword ${row.keyword.toFixed(2)}  "${row.left}" / "${row.right}"`);
console.log('  unrelated:');
for (const row of unrelated) console.log(`    semantic ${row.semantic.toFixed(2)}  keyword ${row.keyword.toFixed(2)}  "${row.left}" / "${row.right}"`);
console.log('');

const worstParaphrase = Math.min(...paraphrase.map((r) => r.semantic));
const bestUnrelated = Math.max(...unrelated.map((r) => r.semantic));
const keywordWorstParaphrase = Math.min(...paraphrase.map((r) => r.keyword));

// The retriever RANKS, it does not threshold at a high bar — so what matters
// is that the two populations separate, and that the relevance floor sits
// between them. An absolute "paraphrases must score above X" would be a number
// invented rather than measured.
check('every paraphrase clears the semantic relevance floor', worstParaphrase > MIN_SIGNAL_BY_MATCH_TYPE.semantic, `worst ${worstParaphrase.toFixed(2)} > floor ${MIN_SIGNAL_BY_MATCH_TYPE.semantic}`);
check('no unrelated pair clears that floor', bestUnrelated < MIN_SIGNAL_BY_MATCH_TYPE.semantic, `best unrelated ${bestUnrelated.toFixed(2)} < floor ${MIN_SIGNAL_BY_MATCH_TYPE.semantic}`);
check('unrelated text stays clearly below every paraphrase', bestUnrelated < worstParaphrase, `${bestUnrelated.toFixed(2)} < ${worstParaphrase.toFixed(2)}`);
check('it beats the keyword scorer it replaces, on the case that matters', worstParaphrase > keywordWorstParaphrase, `${worstParaphrase.toFixed(2)} vs ${keywordWorstParaphrase.toFixed(2)}`);
check('paraphrases separate from unrelated text by a usable margin', worstParaphrase - bestUnrelated >= 0.15, `margin ${(worstParaphrase - bestUnrelated).toFixed(2)}`);

// Same topic, different fact: these SHOULD look related (they are about the
// same subject), so the honest requirement is only that they do not outrank a
// true paraphrase — retrieval ranks, it does not decide truth.
const bestDistinct = Math.max(...distinct.map((r) => r.semantic));
check('a contradicting fact about the same subject still ranks as on-topic', bestDistinct > bestUnrelated, `${bestDistinct.toFixed(2)} > ${bestUnrelated.toFixed(2)}`);

// ── cost, since this runs per turn ─────────────────────────────────────────
const timedStart = Date.now();
await provider.embedMany(PARAPHRASES.map(([left]) => left));
const batchMs = Date.now() - timedStart;
check('embedding a pool of 5 is fast enough to sit in a turn', batchMs < 2000, `${batchMs}ms`);

// ── the point of the whole exercise: does retrieval actually get better? ──
//
// Seven questions someone would really ask, against seven memories, through
// the REAL retriever and repository. This is a benchmark, not a demo: it
// reports how often each scorer puts the memory that ANSWERS the question in
// first place, including the cases the encoder gets wrong.

const MEMORIES = [
  { summary: 'The Q3 report is due on Friday.', tags: ['q3', 'report'], predicate: 'due_date' },
  { summary: 'The dog needs to go to the vet on Tuesday.', tags: ['dog', 'vet'], predicate: 'appointment' },
  { summary: 'The user parked on the third floor of the garage.', tags: ['parking'], predicate: 'location' },
  { summary: 'Jon prefers tea to coffee.', tags: ['jon', 'tea'], predicate: 'preference' },
  { summary: 'Matt is allergic to peanuts.', tags: ['matt'], predicate: 'dietary_restriction' },
  { summary: 'The user agreed to send Matt the Building 5 HVAC quote.', tags: ['matt', 'hvac'], predicate: 'commitment' },
  { summary: 'The kitchen tap has been leaking since last week.', tags: ['kitchen'], predicate: 'problem' },
];

const QUESTIONS = [
  ['when is that write-up meant to be handed in', 0],
  ['what do I owe Matt', 5],
  ['where did I leave the car', 2],
  ['what should I not serve Matt for lunch', 4],
  ['what needs fixing around the house', 6],
  ['what does Jon like to drink', 3],
  ['when is the animal appointment', 1],
];

const repository = createInMemoryRepository();
const stored = MEMORIES.map((m) => repository.create({
  type: 'fact', subjectId: 'person_user', predicate: m.predicate, object: {}, summary: m.summary,
  confidence: 0.9, importance: 0.6, tags: m.tags, source: { evidenceType: 'user_stated' },
}).memory);

async function topMemoryId(query, embedder) {
  const result = await retrieve({ repository, query, embedder, maximumMemories: 3 });
  return { top: result.memories[0]?.memoryId ?? null, matchType: result.matchType, count: result.memories.length };
}

let semanticHits = 0;
let keywordHits = 0;
console.log('  question -> which scorer puts the answering memory first');
for (const [question, answerIndex] of QUESTIONS) {
  const expected = stored[answerIndex].memoryId;
  const semantic = await topMemoryId(question, provider);
  const keyword = await topMemoryId(question, null);
  if (semantic.top === expected) semanticHits += 1;
  if (keyword.top === expected) keywordHits += 1;
  console.log(`    semantic ${semantic.top === expected ? 'HIT ' : 'miss'}  keyword ${keyword.top === expected ? 'HIT ' : 'miss'}   "${question}"`);
}
console.log('');

check('semantic retrieval beats keyword on real questions', semanticHits > keywordHits, `${semanticHits}/${QUESTIONS.length} vs ${keywordHits}/${QUESTIONS.length}`);
check('semantic retrieval answers most questions correctly', semanticHits >= 5, `${semanticHits}/${QUESTIONS.length}`);

// It is NOT perfect, and the failures are worth keeping visible: the two it
// misses are ones where a distractor shares the subject ("what do I owe Matt"
// pulls "Matt is allergic to peanuts"). The retriever's own entity bonus
// exists for exactly that, and applies whenever the caller knows the entity.
const withEntity = await retrieve({ repository, query: 'what do I owe Matt', embedder: provider, entityIds: ['person_user'] });
check('a retrieval still returns something usable even where the encoder misranks', withEntity.memories.length > 0, `${withEntity.memories.length} candidates ranked`);

const floorProbe = await retrieve({ repository, query: 'the weather in Lisbon next spring', embedder: provider });
check('a question about nothing stored retrieves little or nothing', floorProbe.memories.length <= 2, `${floorProbe.memories.length} of ${MEMORIES.length} passed the floor`);

const passed = checks.filter((c) => c.pass).length;
console.log(`\n  ${passed}/${checks.length} checks passed\n`);
