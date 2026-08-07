import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothSpeakers, createSegmenter } from '../src/engine/segmenter.js';

const speakers = (words) => words.map((w) => w.speaker);
const w = (speaker, word, start = 0) => ({ speaker, word, punctuated_word: word, start, end: start + 1 });

test('reassigns an isolated single-word speaker flip to its neighbors', () => {
  const words = [0, 0, 1, 0, 0].map((speaker) => ({ speaker }));
  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 0, 0, 0]);
});

test('keeps a genuine two-word turn (e.g. a backchannel)', () => {
  const words = [0, 0, 1, 1, 0, 0].map((speaker) => ({ speaker }));
  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 1, 1, 0, 0]);
});

test('splits a two-word boundary island when it contains a sentence end plus backchannel', () => {
  const words = [w(1, 'detail'), w(1, 'oriented'), w(0, 'grandmother.'), w(0, 'Yes.'), w(1, 'Who')];
  assert.deepEqual(speakers(smoothSpeakers(words)), [1, 1, 1, 0, 1]);
});

test('keeps short interjection endings and lead-ins with the interjecting speaker', () => {
  const words = [
    w(0, 'kids.'),
    w(1, 'That'),
    w(1, 'was'),
    w(1, 'a'),
    w(1, 'good'),
    w(0, 'story.'),
    w(0, 'And'),
    w(0, 'then'),
    w(0, 'his'),
    w(0, 'wife'),
    w(0, 'died.'),
    w(0, 'Oh,'),
    w(1, "that's"),
    w(1, 'the'),
    w(1, 'bad'),
    w(1, 'part.'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
});

test('moves a stranded reply starter after a bridge word to the replying speaker', () => {
  const words = [
    w(0, 'father.'),
    w(0, 'So'),
    w(0, 'This'),
    w(1, 'was'),
    w(1, 'in'),
    w(1, 'Pittsburgh.'),
    w(1, 'Right?'),
    w(0, 'They'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 1, 1, 1, 1, 1, 0]);
});

test('reassigns a short mid-sentence island to surrounding same-speaker words', () => {
  const words = [
    w(0, "We're"),
    w(0, 'getting'),
    w(1, 'a'),
    w(1, 'little'),
    w(1, 'ahead'),
    w(0, 'of'),
    w(0, 'ourselves.'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 0, 0, 0, 0, 0]);
});

test('does not treat a lowercase mid-sentence island as owning the sentence end', () => {
  const words = [
    w(0, "We're"),
    w(0, 'getting'),
    w(0, 'a'),
    w(1, 'little'),
    w(1, 'ahead'),
    w(1, 'of'),
    w(0, 'ourselves.'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 0, 0, 0, 0, 0]);
});

test('keeps a follow-up question with the previous questioning speaker', () => {
  const words = [
    w(1, 'Was'),
    w(1, 'it'),
    w(1, 'her'),
    w(1, 'sister?'),
    w(0, 'The'),
    w(0, 'original'),
    w(0, "woman's"),
    w(0, 'sister?'),
    w(0, 'One'),
    w(0, 'legend'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
});

test('moves a stranded reply verb to the following short reply', () => {
  const words = [
    w(0, 'sister'),
    w(0, 'Adds'),
    w(1, 'to'),
    w(1, 'the'),
    w(1, 'drama.'),
    w(0, 'But'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 1, 1, 1, 1, 0]);
});

test('moves an isolated lowercase question to the following speaker', () => {
  const words = [
    w(1, 'what?'),
    w(0, 'Like,'),
    w(0, 'I'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 0, 0]);
});

test('keeps a new question with its speaker and splits a following first-person answer', () => {
  const words = [
    w(0, 'nails?'),
    w(1, 'You'),
    w(1, 'raised'),
    w(1, 'your'),
    w(1, 'hands'),
    w(1, 'and'),
    w(1, 'asked'),
    w(1, 'that?'),
    w(1, 'I'),
    w(1, 'asked'),
    w(0, 'that'),
    w(0, 'question.'),
  ];

  assert.deepEqual(speakers(smoothSpeakers(words)), [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
});

test('segmenter merges same-speaker words and splits on speaker change', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s));
  // Speaker 0 talks, 1 interjects two words, 0 resumes — over two ingest calls.
  segmenter.ingest([w(0, 'hello'), w(0, 'there'), w(1, 'oh'), w(1, 'yeah')]);
  segmenter.ingest([w(0, 'anyway'), w(0, 'so')]);
  segmenter.flush();
  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[0].text, 'hello there');
  assert.equal(segments[2].text, 'anyway so');
});

test('segmenter leaves speaker count unlimited by default', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s));
  segmenter.ingest([w(0, 'one'), w(1, 'two'), w(2, 'three')]);
  segmenter.flush();
  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 3']);
});

test('segmenter aliases phantom speakers when maxSpeakers is set', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Question?'), w(1, 'Answer'), w(1, 'starts')]);
  segmenter.ingest([w(2, 'quoted'), w(2, 'story'), w(2, 'keeps'), w(2, 'going'), w(2, 'with'), w(2, 'the'), w(2, 'same'), w(2, 'speaker'), w(2, 'voice.')]);
  segmenter.ingest([w(0, 'She'), w(0, 'remembered'), w(0, 'the'), w(0, 'tin'), w(2, 'bucket.'), w(1, 'And')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  assert.equal(segments[1].text, 'Answer starts quoted story keeps going with the same speaker voice.');
  assert.equal(segments[2].text, 'She remembered the tin bucket.');
});

test('segmenter maps short extra-speaker replies to the other known speaker', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Main'), w(0, 'speaker.')]);
  segmenter.ingest([w(1, 'Known'), w(1, 'other')]);
  segmenter.ingest([w(0, 'More'), w(0, 'main'), w(0, 'speech.')]);
  segmenter.ingest([w(2, 'That'), w(2, 'was'), w(2, 'good.')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  assert.equal(segments[3].text, 'That was good.');
});

test('segmenter treats a short extra-speaker reply as complete when the next word ends it', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Main.'), w(1, 'Other'), w(1, 'seed'), w(0, 'had'), w(0, 'kids.'), w(2, 'That'), w(2, 'was'), w(2, 'a'), w(2, 'good'), w(0, 'story.'), w(0, 'Then')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[3].text, 'That was a good story.');
});

test('segmenter keeps lowercase phantom quote fragments with the current speaker', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Start.'), w(1, 'Other'), w(1, 'voice?'), w(0, 'She'), w(0, 'said,'), w(0, 'like,'), w(2, 'what?'), w(2, 'What'), w(2, 'is'), w(2, 'it?'), w(0, 'Like,'), w(0, 'I')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[2].text, 'She said, like, what? What is it? Like, I');
});

test('segmenter keeps the final word that completes a six-word reply', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Vague.'), w(1, 'Excuse'), w(1, 'me,'), w(1, 'maam.'), w(1, 'Will'), w(1, 'you'), w(1, 'marry'), w(0, 'me?'), w(0, 'Basically.')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[1].text, 'Excuse me, maam. Will you marry me?');
});

test('segmenter smooths follow-up questions across ingest boundaries', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Nope.'), w(1, 'Was'), w(1, 'it'), w(1, 'her'), w(1, 'sister?')]);
  segmenter.ingest([w(0, 'The'), w(0, 'original'), w(0, "woman's"), w(0, 'sister?'), w(0, 'One')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[1].text, "Was it her sister? The original woman's sister?");
});

test('segmenter smooths stranded reply starters across ingest boundaries', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'the'), w(0, "woman's"), w(0, 'sister')]);
  segmenter.ingest([w(0, 'Adds'), w(1, 'to'), w(1, 'the'), w(1, 'drama.'), w(0, 'But')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.equal(segments[1].text, 'Adds to the drama.');
});

test('segmenter uses the open turn as context for a sentence-end plus backchannel chunk', () => {
  const segments = [];
  const segmenter = createSegmenter((s) => segments.push(s), { maxSpeakers: 2 });

  segmenter.ingest([w(0, 'Question?')]);
  segmenter.ingest([w(1, 'a'), w(1, 'detail'), w(1, 'oriented')]);
  segmenter.ingest([w(0, 'grandmother.'), w(0, 'Yes.')]);
  segmenter.ingest([w(1, 'Who'), w(1, 'remembered')]);
  segmenter.flush();

  assert.deepEqual(segments.map((s) => s.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  assert.equal(segments[1].text, 'a detail oriented grandmother.');
  assert.equal(segments[2].text, 'Yes.');
});
