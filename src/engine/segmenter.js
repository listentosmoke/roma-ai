// Turn segmentation from Deepgram's word-level diarization output. This is the
// diarization "brain" of the app and is deliberately pure / dependency-free so it
// runs identically in the browser engine and in the Node streaming test harness
// (scripts/stream-test.mjs) — meaning the harness exercises the REAL logic.
//
// Deepgram streams finalized words, each tagged with a speaker index. We keep one
// open segment and close it when the speaker changes, when it grows too long, or
// when the caller signals a pause (UtteranceEnd) / end of stream.

export const MAX_SEGMENT_WORDS = 60;

const BACKCHANNEL_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'right', 'sure', 'mhmm', 'mhm', 'mmhmm', 'uh-huh', 'uhhuh']);
const LEAD_IN_WORDS = new Set(['oh']);
const STRANDED_REPLY_STARTERS = new Set(['this', 'that', 'who', 'adds']);
const BRIDGE_WORDS = new Set(['so', 'and', 'but']);
const FOLLOW_UP_QUESTION_STARTERS = new Set(['the', 'that', 'original']);
const SHORT_REPLY_MAX_WORDS = 8;

export function speakerLabel(index) {
  return `Speaker ${(Number.isFinite(index) ? index : 0) + 1}`;
}

function speakerIndex(value) {
  const index = Number(value);
  return Number.isFinite(index) ? index : 0;
}

function wordText(word) {
  return word?.punctuated_word ?? word?.word ?? '';
}

function endsSentence(word) {
  return /[.!?]["')\]]?$/.test(wordText(word).trim());
}

function endsQuestion(word) {
  return /\?["')\]]?$/.test(wordText(word).trim());
}

function normalizedToken(word) {
  return wordText(word).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
}

function isBackchannel(word) {
  return BACKCHANNEL_WORDS.has(normalizedToken(word));
}

function isLeadIn(word) {
  return LEAD_IN_WORDS.has(normalizedToken(word));
}

function isStrandedReplyStarter(word) {
  return STRANDED_REPLY_STARTERS.has(normalizedToken(word));
}

function isFollowUpQuestionStarter(word) {
  return FOLLOW_UP_QUESTION_STARTERS.has(normalizedToken(word));
}

function startsLikelyTurn(word) {
  const text = wordText(word).trim();
  return isLeadIn(word) || isStrandedReplyStarter(word) || isBackchannel(word) || /^[A-Z0-9]/.test(text);
}

function hasNearbySentenceBoundaryBefore(words, index) {
  return (
    endsSentence(words[index - 1])
    || (BRIDGE_WORDS.has(normalizedToken(words[index - 1])) && endsSentence(words[index - 2]))
  );
}

function firstSentenceLength(words, start, end) {
  for (let i = start; i < end; i += 1) {
    if (endsSentence(words[i])) return i - start + 1;
  }
  return 0;
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

// Reassign an isolated single-word speaker flip to its surrounding speaker.
// Deepgram's streaming diarization frequently mislabels one boundary word,
// causing speaker ping-pong; a run of ≥2 words is kept as a genuine brief turn.
export function smoothSpeakers(words) {
  const smoothed = words.map((word) => ({ ...word }));
  for (let i = 1; i < smoothed.length - 1; i += 1) {
    if (smoothed[i].speaker !== smoothed[i - 1].speaker && smoothed[i - 1].speaker === smoothed[i + 1].speaker) {
      smoothed[i].speaker = smoothed[i - 1].speaker;
    }
  }

  let start = 1;
  while (start < smoothed.length - 1) {
    const runSpeaker = smoothed[start].speaker;
    let end = start + 1;
    while (end < smoothed.length && smoothed[end].speaker === runSpeaker) end += 1;

    const previousSpeaker = smoothed[start - 1]?.speaker;
    const nextSpeaker = smoothed[end]?.speaker;
    const runLength = end - start;
    const firstSentenceWords = firstSentenceLength(smoothed, start, end);
    if (
      runLength === 2
      && previousSpeaker === nextSpeaker
      && runSpeaker !== previousSpeaker
      && endsSentence(smoothed[start])
      && isBackchannel(smoothed[start + 1])
    ) {
      smoothed[start].speaker = previousSpeaker;
    }

    if (
      runLength >= 3
      && runLength <= 4
      && previousSpeaker === nextSpeaker
      && runSpeaker !== previousSpeaker
      && smoothed.slice(start, end).every((word) => wordText(word))
      && !smoothed.slice(start, end).some(endsSentence)
      && !(endsSentence(smoothed[end]) && startsLikelyTurn(smoothed[start]))
      && !isBackchannel(smoothed[start])
      && !isLeadIn(smoothed[start])
    ) {
      for (let i = start; i < end; i += 1) smoothed[i].speaker = previousSpeaker;
    }

    if (
      firstSentenceWords >= 2
      && firstSentenceWords <= SHORT_REPLY_MAX_WORDS
      && firstSentenceWords < runLength
      && previousSpeaker !== undefined
      && previousSpeaker !== runSpeaker
      && isFollowUpQuestionStarter(smoothed[start])
      && endsQuestion(smoothed[start + firstSentenceWords - 1])
      && endsQuestion(smoothed[start - 1])
    ) {
      for (let i = start; i < start + firstSentenceWords; i += 1) smoothed[i].speaker = previousSpeaker;
    }

    if (
      firstSentenceWords >= 2
      && firstSentenceWords < runLength
      && nextSpeaker !== undefined
      && nextSpeaker !== runSpeaker
      && endsQuestion(smoothed[start + firstSentenceWords - 1])
      && normalizedToken(smoothed[start + firstSentenceWords]) === 'i'
    ) {
      for (let i = start + firstSentenceWords; i < end; i += 1) smoothed[i].speaker = nextSpeaker;
    }

    start = end;
  }

  start = 0;
  while (start < smoothed.length) {
    const runSpeaker = smoothed[start].speaker;
    let end = start + 1;
    while (end < smoothed.length && smoothed[end].speaker === runSpeaker) end += 1;

    const previousRunStart = start - 1;
    let previousStart = previousRunStart;
    while (previousStart > 0 && smoothed[previousStart - 1].speaker === smoothed[previousRunStart]?.speaker) previousStart -= 1;
    const previousLength = previousRunStart >= 0 ? previousRunStart - previousStart + 1 : 0;
    const nextSpeaker = smoothed[end]?.speaker;
    let nextEnd = end + 1;
    while (nextEnd < smoothed.length && smoothed[nextEnd].speaker === nextSpeaker) nextEnd += 1;
    const nextLength = nextSpeaker === undefined ? 0 : nextEnd - end;

    if (
      previousLength > 0
      && previousLength <= SHORT_REPLY_MAX_WORDS
      && smoothed[previousRunStart].speaker !== runSpeaker
      && startsLikelyTurn(smoothed[previousStart])
      && !endsSentence(smoothed[previousRunStart])
      && endsSentence(smoothed[start])
    ) {
      smoothed[start].speaker = smoothed[previousRunStart].speaker;
    }

    if (
      end - start === 1
      && nextSpeaker !== undefined
      && nextLength <= SHORT_REPLY_MAX_WORDS
      && nextSpeaker !== runSpeaker
      && isLeadIn(smoothed[start])
      && !endsSentence(smoothed[start])
    ) {
      smoothed[start].speaker = nextSpeaker;
    }

    if (
      end - start === 1
      && nextSpeaker !== undefined
      && nextSpeaker !== runSpeaker
      && nextLength <= 3
      && endsQuestion(smoothed[start])
      && !startsLikelyTurn(smoothed[start])
    ) {
      smoothed[start].speaker = nextSpeaker;
    }

    if (
      nextSpeaker !== undefined
      && nextLength <= SHORT_REPLY_MAX_WORDS
      && nextSpeaker !== runSpeaker
      && end - start >= 2
      && (isLeadIn(smoothed[end - 1]) || isStrandedReplyStarter(smoothed[end - 1]))
      && !endsSentence(smoothed[end - 1])
      && (hasNearbySentenceBoundaryBefore(smoothed, end - 1) || endsSentence(smoothed[nextEnd - 1]))
    ) {
      smoothed[end - 1].speaker = nextSpeaker;
    }

    start = end;
  }

  return smoothed;
}

/**
 * @param {(segment: {speaker:string, text:string, startedAt:number, endedAt:number}) => void} onSegment
 * @param {{ maxSegmentWords?: number, maxSpeakers?: number }} [options]
 */
export function createSegmenter(onSegment, { maxSegmentWords = MAX_SEGMENT_WORDS, maxSpeakers } = {}) {
  const speakerLimit = isFinitePositive(maxSpeakers) ? maxSpeakers : Infinity;
  const trustedSpeakers = new Set();
  const speakerAliases = new Map();
  const speakerWordCounts = new Map();
  let current = null; // { speaker, speakerIndex, words: [] }

  function emit() {
    if (!current || !current.words.length) { current = null; return; }
    const { speaker, words } = current;
    current = null;
    const text = words.map((word) => word.punctuated_word ?? word.word ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (text) onSegment({ speaker, text, startedAt: words[0].start ?? 0, endedAt: words[words.length - 1].end ?? 0 });
  }

  function rememberSpeaker(index, wordCount) {
    trustedSpeakers.add(index);
    speakerWordCounts.set(index, (speakerWordCounts.get(index) ?? 0) + wordCount);
  }

  function mostUsedTrustedSpeaker() {
    let best = undefined;
    let bestCount = -1;
    for (const index of trustedSpeakers) {
      const count = speakerWordCounts.get(index) ?? 0;
      if (count > bestCount) {
        best = index;
        bestCount = count;
      }
    }
    return best;
  }

  function alternateTrustedSpeaker(contextSpeaker) {
    let best = undefined;
    let bestCount = -1;
    for (const index of trustedSpeakers) {
      if (index === contextSpeaker) continue;
      const count = speakerWordCounts.get(index) ?? 0;
      if (count > bestCount) {
        best = index;
        bestCount = count;
      }
    }
    return best;
  }

  function isShortReplyRun(run, nextWord) {
    return run.length >= 2 && run.length <= SHORT_REPLY_MAX_WORDS && (endsSentence(run[run.length - 1]) || endsSentence(nextWord));
  }

  function chooseAliasTarget(contextSpeaker, run, nextWord) {
    if (contextSpeaker !== undefined && isShortReplyRun(run, nextWord) && startsLikelyTurn(run[0])) {
      return alternateTrustedSpeaker(contextSpeaker) ?? contextSpeaker;
    }
    return contextSpeaker ?? mostUsedTrustedSpeaker() ?? 0;
  }

  function isContinuationRun(run, contextSpeaker, aliasTarget, contextLastWord) {
    return (
      run.length === 1
      && contextSpeaker !== undefined
      && contextSpeaker !== aliasTarget
      && contextLastWord
      && !endsSentence(contextLastWord)
    );
  }

  function normalizeSpeakerRuns(rawWords) {
    const normalized = [];
    let contextSpeaker = current?.speakerIndex;
    let contextLastWord = current?.words.at(-1);

    for (let i = 0; i < rawWords.length;) {
      const rawSpeaker = speakerIndex(rawWords[i].speaker);
      let end = i + 1;
      while (end < rawWords.length && speakerIndex(rawWords[end].speaker) === rawSpeaker) end += 1;

      const run = rawWords.slice(i, end);
      if (
        run.length === 2
        && contextSpeaker !== undefined
        && rawSpeaker !== contextSpeaker
        && (trustedSpeakers.has(rawSpeaker) || trustedSpeakers.size < speakerLimit)
        && endsSentence(run[0])
        && !isBackchannel(run[0])
        && isBackchannel(run[1])
      ) {
        rememberSpeaker(rawSpeaker, 1);
        const firstWord = { ...run[0], speaker: contextSpeaker };
        const secondWord = { ...run[1], speaker: rawSpeaker };
        normalized.push(firstWord, secondWord);
        contextSpeaker = rawSpeaker;
        contextLastWord = secondWord;
        i = end;
        continue;
      }

      let target = rawSpeaker;

      if (trustedSpeakers.has(rawSpeaker)) {
        rememberSpeaker(rawSpeaker, run.length);
      } else if (trustedSpeakers.size < speakerLimit) {
        rememberSpeaker(rawSpeaker, run.length);
      } else {
        const aliasTarget = speakerAliases.get(rawSpeaker) ?? chooseAliasTarget(contextSpeaker, run, rawWords[end]);
        if (!speakerAliases.has(rawSpeaker)) speakerAliases.set(rawSpeaker, aliasTarget);
        target = isContinuationRun(run, contextSpeaker, aliasTarget, contextLastWord) ? contextSpeaker : aliasTarget;
      }

      for (const word of run) {
        const nextWord = { ...word, speaker: target };
        normalized.push(nextWord);
        contextSpeaker = target;
        contextLastWord = nextWord;
      }

      i = end;
    }

    return normalized;
  }

  return {
    // Fold finalized words into the open segment; a real speaker change (after
    // smoothing) closes the previous turn immediately.
    ingest(rawWords) {
      const normalized = normalizeSpeakerRuns(rawWords);
      const contextWord = current?.words.at(-1);
      const words = contextWord ? smoothSpeakers([contextWord, ...normalized]).slice(1) : smoothSpeakers(normalized);
      for (const word of words) {
        const index = speakerIndex(word.speaker);
        const speaker = speakerLabel(index);
        if (current && current.speaker !== speaker) emit();
        if (!current) current = { speaker, speakerIndex: index, words: [] };
        current.speakerIndex = index;
        current.words.push(word);
        if (current.words.length >= maxSegmentWords) emit();
      }
    },
    // Close the current turn (call on UtteranceEnd / stop).
    flush() { emit(); },
  };
}
