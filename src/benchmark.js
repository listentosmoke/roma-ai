const WORD_BOUNDARY = /[\s]+/;

export const BENCHMARK_PRESETS = [
  {
    id: 'clean-dictation',
    name: 'Clean dictation',
    durationSeconds: 14,
    reference:
      'Roma AI measures speech recognition quality with word error rate character error rate latency and speaker turn counts.',
    hypothesis:
      'Roma AI measures speech recognition quality with word error rate character error rate latency and speaker turn count.',
    referenceSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 14000, text: 'Roma AI measures speech recognition quality with word error rate character error rate latency and speaker turn counts.' },
    ],
    hypothesisSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 14000, text: 'Roma AI measures speech recognition quality with word error rate character error rate latency and speaker turn count.' },
    ],
  },
  {
    id: 'noisy-meeting',
    name: 'Noisy meeting turn',
    durationSeconds: 22,
    reference:
      'Speaker one asked whether the prototype could export benchmarks before the next customer review on Friday morning. Speaker two said the backend should diarize speakers instead of guessing in the browser.',
    hypothesis:
      'Speaker one asked whether the prototype can export benchmark before the next customer review Friday morning. Speaker two said the backend should diarize speaker instead of guessing in browser.',
    referenceSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 10800, text: 'Speaker one asked whether the prototype could export benchmarks before the next customer review on Friday morning.' },
      { speaker: 'Speaker 2', startedAt: 11200, endedAt: 22000, text: 'Speaker two said the backend should diarize speakers instead of guessing in the browser.' },
    ],
    hypothesisSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 9800, text: 'Speaker one asked whether the prototype can export benchmark before the next customer review Friday morning.' },
      { speaker: 'Speaker 2', startedAt: 9800, endedAt: 22000, text: 'Speaker two said the backend should diarize speaker instead of guessing in browser.' },
    ],
  },
  {
    id: 'technical-terms',
    name: 'Technical terms',
    durationSeconds: 18,
    reference:
      'The browser uses the Web Speech API while the benchmark reports substitutions insertions deletions and real time factor.',
    hypothesis:
      'The browser uses the web speech API while the benchmark reports substitution insertions deletions and real time factor.',
    referenceSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 18000, text: 'The browser uses the Web Speech API while the benchmark reports substitutions insertions deletions and real time factor.' },
    ],
    hypothesisSegments: [
      { speaker: 'Speaker 1', startedAt: 0, endedAt: 18000, text: 'The browser uses the web speech API while the benchmark reports substitution insertions deletions and real time factor.' },
    ],
  },
];

export function normalizeTranscript(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeWords(text) {
  const normalized = normalizeTranscript(text);
  return normalized ? normalized.split(WORD_BOUNDARY) : [];
}

export function tokenizeCharacters(text) {
  return [...normalizeTranscript(text).replace(/\s/g, '')];
}

export function editDistance(referenceTokens, hypothesisTokens) {
  const rows = referenceTokens.length + 1;
  const cols = hypothesisTokens.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let col = 0; col < cols; col += 1) matrix[0][col] = col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const substitutionCost = referenceTokens[row - 1] === hypothesisTokens[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + substitutionCost,
      );
    }
  }

  let row = referenceTokens.length;
  let col = hypothesisTokens.length;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let correct = 0;

  while (row > 0 || col > 0) {
    if (
      row > 0 &&
      col > 0 &&
      matrix[row][col] === matrix[row - 1][col - 1] &&
      referenceTokens[row - 1] === hypothesisTokens[col - 1]
    ) {
      correct += 1;
      row -= 1;
      col -= 1;
    } else if (
      row > 0 &&
      col > 0 &&
      matrix[row][col] === matrix[row - 1][col - 1] + 1
    ) {
      substitutions += 1;
      row -= 1;
      col -= 1;
    } else if (col > 0 && matrix[row][col] === matrix[row][col - 1] + 1) {
      insertions += 1;
      col -= 1;
    } else {
      deletions += 1;
      row -= 1;
    }
  }

  return {
    distance: matrix[referenceTokens.length][hypothesisTokens.length],
    substitutions,
    insertions,
    deletions,
    correct,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return numerator ? 1 : 0;
  return numerator / denominator;
}

function toMilliseconds(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return number > 0 && number < 1000 ? number * 1000 : number;
}

function normalizeSegment(segment) {
  return {
    speaker: String(segment.speaker ?? segment.label ?? 'unknown'),
    startedAt: Math.max(0, toMilliseconds(segment.startedAt ?? segment.start ?? segment.startMs)),
    endedAt: Math.max(0, toMilliseconds(segment.endedAt ?? segment.end ?? segment.endMs)),
    text: String(segment.text ?? ''),
  };
}

function overlapMs(left, right) {
  return Math.max(0, Math.min(left.endedAt, right.endedAt) - Math.max(left.startedAt, right.startedAt));
}

function durationMs(segments) {
  return segments.reduce((total, segment) => total + Math.max(0, segment.endedAt - segment.startedAt), 0);
}

function scoreSpeakerMapping(referenceSegments, hypothesisSegments) {
  const pairOverlaps = new Map();

  for (const reference of referenceSegments) {
    for (const hypothesis of hypothesisSegments) {
      const overlap = overlapMs(reference, hypothesis);
      if (!overlap) continue;
      const key = `${hypothesis.speaker}\u0000${reference.speaker}`;
      pairOverlaps.set(key, (pairOverlaps.get(key) ?? 0) + overlap);
    }
  }

  const hypothesisSpeakers = [...new Set(hypothesisSegments.map((segment) => segment.speaker))];
  const referenceSpeakers = [...new Set(referenceSegments.map((segment) => segment.speaker))];
  const usedReferenceSpeakers = new Set();
  const mapping = new Map();

  for (const hypothesisSpeaker of hypothesisSpeakers) {
    let bestReferenceSpeaker = null;
    let bestOverlap = -1;

    for (const referenceSpeaker of referenceSpeakers) {
      if (usedReferenceSpeakers.has(referenceSpeaker)) continue;
      const overlap = pairOverlaps.get(`${hypothesisSpeaker}\u0000${referenceSpeaker}`) ?? 0;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestReferenceSpeaker = referenceSpeaker;
      }
    }

    if (bestReferenceSpeaker) {
      mapping.set(hypothesisSpeaker, bestReferenceSpeaker);
      usedReferenceSpeakers.add(bestReferenceSpeaker);
    }
  }

  return mapping;
}

export function scoreDiarization({ referenceSegments = [], hypothesisSegments = [] }) {
  const reference = referenceSegments.map(normalizeSegment).filter((segment) => segment.endedAt > segment.startedAt);
  const hypothesis = hypothesisSegments.map(normalizeSegment).filter((segment) => segment.endedAt > segment.startedAt);
  const referenceDurationMs = durationMs(reference);
  const hypothesisDurationMs = durationMs(hypothesis);
  const mapping = scoreSpeakerMapping(reference, hypothesis);
  const boundaries = [...new Set(reference.flatMap((segment) => [segment.startedAt, segment.endedAt]).concat(hypothesis.flatMap((segment) => [segment.startedAt, segment.endedAt])))].sort((a, b) => a - b);

  let missedSpeechMs = 0;
  let falseAlarmMs = 0;
  let speakerConfusionMs = 0;

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const span = end - start;
    if (span <= 0) continue;

    const referenceActive = reference.find((segment) => segment.startedAt < end && segment.endedAt > start);
    const hypothesisActive = hypothesis.find((segment) => segment.startedAt < end && segment.endedAt > start);

    if (referenceActive && !hypothesisActive) missedSpeechMs += span;
    if (!referenceActive && hypothesisActive) falseAlarmMs += span;
    if (referenceActive && hypothesisActive && mapping.get(hypothesisActive.speaker) !== referenceActive.speaker) {
      speakerConfusionMs += span;
    }
  }

  const diarizationErrorMs = missedSpeechMs + falseAlarmMs + speakerConfusionMs;

  return {
    der: rate(diarizationErrorMs, referenceDurationMs),
    referenceDurationMs,
    hypothesisDurationMs,
    missedSpeechMs,
    falseAlarmMs,
    speakerConfusionMs,
    speakerMapping: Object.fromEntries(mapping),
  };
}

export function benchmarkTranscript({
  reference,
  hypothesis,
  audioDurationSeconds = 0,
  processingSeconds = 0,
  referenceSegments = [],
  hypothesisSegments = [],
}) {
  const referenceWords = tokenizeWords(reference);
  const hypothesisWords = tokenizeWords(hypothesis);
  const referenceCharacters = tokenizeCharacters(reference);
  const hypothesisCharacters = tokenizeCharacters(hypothesis);
  const wordEdits = editDistance(referenceWords, hypothesisWords);
  const characterEdits = editDistance(referenceCharacters, hypothesisCharacters);
  const errorWords = wordEdits.substitutions + wordEdits.insertions + wordEdits.deletions;
  const errorCharacters = characterEdits.substitutions + characterEdits.insertions + characterEdits.deletions;

  return {
    wer: rate(errorWords, referenceWords.length),
    cer: rate(errorCharacters, referenceCharacters.length),
    accuracy: 1 - rate(errorWords, referenceWords.length),
    realTimeFactor: audioDurationSeconds > 0 && processingSeconds > 0 ? processingSeconds / audioDurationSeconds : null,
    referenceWordCount: referenceWords.length,
    hypothesisWordCount: hypothesisWords.length,
    wordEdits,
    characterEdits,
    diarization: scoreDiarization({ referenceSegments, hypothesisSegments }),
  };
}

export function summarizeBenchmarkCases(cases = BENCHMARK_PRESETS) {
  const results = cases.map((testCase) => ({
    ...testCase,
    metrics: benchmarkTranscript({
      reference: testCase.reference,
      hypothesis: testCase.hypothesis,
      audioDurationSeconds: testCase.durationSeconds,
      processingSeconds: testCase.processingSeconds ?? testCase.durationSeconds,
      referenceSegments: testCase.referenceSegments,
      hypothesisSegments: testCase.hypothesisSegments,
    }),
  }));

  const totals = results.reduce(
    (aggregate, result) => {
      aggregate.referenceWords += result.metrics.referenceWordCount;
      aggregate.errors +=
        result.metrics.wordEdits.substitutions + result.metrics.wordEdits.insertions + result.metrics.wordEdits.deletions;
      aggregate.referenceDurationMs += result.metrics.diarization.referenceDurationMs;
      aggregate.diarizationErrorMs +=
        result.metrics.diarization.missedSpeechMs +
        result.metrics.diarization.falseAlarmMs +
        result.metrics.diarization.speakerConfusionMs;
      return aggregate;
    },
    { referenceWords: 0, errors: 0, referenceDurationMs: 0, diarizationErrorMs: 0 },
  );

  return {
    results,
    averageWer: rate(totals.errors, totals.referenceWords),
    averageDer: rate(totals.diarizationErrorMs, totals.referenceDurationMs),
    totalReferenceWords: totals.referenceWords,
    totalReferenceDurationMs: totals.referenceDurationMs,
  };
}

export function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
