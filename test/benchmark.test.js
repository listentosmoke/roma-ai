import test from 'node:test';
import assert from 'node:assert/strict';
import {
  benchmarkTranscript,
  editDistance,
  formatPercent,
  normalizeTranscript,
  scoreDiarization,
  summarizeBenchmarkCases,
  tokenizeWords,
} from '../src/benchmark.js';

test('normalizes punctuation, case, and accents for STT scoring', () => {
  assert.equal(normalizeTranscript('Café, ROMA!  AI...'), 'cafe roma ai');
  assert.deepEqual(tokenizeWords('Hello, hello?'), ['hello', 'hello']);
});

test('computes Levenshtein edit operations used by WER', () => {
  const edits = editDistance(['the', 'quick', 'fox'], ['the', 'slow', 'quick', 'foxes']);
  assert.equal(edits.substitutions, 1);
  assert.equal(edits.insertions, 1);
  assert.equal(edits.deletions, 0);
  assert.equal(edits.correct, 2);
  assert.equal(edits.distance, 2);
});

test('benchmarks transcripts with WER, CER, accuracy, real-time factor, and DER', () => {
  const metrics = benchmarkTranscript({
    reference: 'the quick brown fox',
    hypothesis: 'the quick fox',
    audioDurationSeconds: 10,
    processingSeconds: 2,
    referenceSegments: [{ speaker: 'A', startedAt: 0, endedAt: 10000, text: 'the quick brown fox' }],
    hypothesisSegments: [{ speaker: 'A', startedAt: 0, endedAt: 9000, text: 'the quick fox' }],
  });

  assert.equal(metrics.referenceWordCount, 4);
  assert.equal(metrics.hypothesisWordCount, 3);
  assert.equal(metrics.wordEdits.deletions, 1);
  assert.equal(metrics.wer, 0.25);
  assert.equal(metrics.accuracy, 0.75);
  assert.equal(metrics.realTimeFactor, 0.2);
  assert.equal(metrics.diarization.der, 0.1);
  assert.ok(metrics.cer > 0);
});

test('scores speaker confusion for diarization output', () => {
  const metrics = scoreDiarization({
    referenceSegments: [
      { speaker: 'A', startedAt: 0, endedAt: 1000 },
      { speaker: 'B', startedAt: 1000, endedAt: 2000 },
    ],
    hypothesisSegments: [
      { speaker: 'speaker_0', startedAt: 0, endedAt: 1000 },
      { speaker: 'speaker_0', startedAt: 1000, endedAt: 2000 },
    ],
  });

  assert.equal(metrics.speakerConfusionMs, 1000);
  assert.equal(metrics.der, 0.5);
});

test('summarizes built-in benchmark fixtures', () => {
  const summary = summarizeBenchmarkCases();
  assert.equal(summary.results.length, 3);
  assert.ok(summary.totalReferenceWords > 0);
  assert.ok(summary.averageWer > 0);
  assert.ok(summary.averageDer >= 0);
  assert.match(formatPercent(summary.averageWer), /%$/);
});
