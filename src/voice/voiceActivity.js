// Lightweight voice-activity interface. We do NOT build a neural VAD — instead
// we derive speech-start / speech-continue / speech-end / silence events from
// signals the pipeline already produces: the mic level meter (audio.js), the
// Deepgram interim transcript, and finalized segments. A consumer subscribes:
//
//   voiceActivity.subscribe(event => { event.type, at, durationMs?, speaker?,
//                                       confidence?, romaSpeaking })
//
// The gap detector and barge-in logic consume these events. The controller also
// tracks whether Roma is currently playing audio, so its own output is not
// mistaken for user speech.

export const VA_EVENTS = { START: 'speech-start', CONTINUE: 'speech-continue', END: 'speech-end', SILENCE: 'silence' };

/**
 * @param {{ now?: () => number, levelThreshold?: number, silenceHangoverMs?: number }} [options]
 */
export function createVoiceActivity({ now = Date.now, levelThreshold = 0.06, silenceHangoverMs = 300 } = {}) {
  const listeners = new Set();
  let speaking = false;
  let speechStartedAt = 0;
  let lastVoiceAt = 0;
  let lastSpeaker = null;
  let romaSpeaking = false;
  let silenceTimer = null;

  function emit(type, extra = {}) {
    const at = now();
    const event = { type, at, romaSpeaking, ...extra };
    for (const listener of listeners) listener(event);
  }

  function startSpeech(at, speaker, confidence) {
    speaking = true;
    speechStartedAt = at;
    lastSpeaker = speaker ?? lastSpeaker;
    emit(VA_EVENTS.START, { speaker: lastSpeaker, confidence });
  }

  function endSpeech(at) {
    if (!speaking) return;
    speaking = false;
    emit(VA_EVENTS.END, { speaker: lastSpeaker, durationMs: Math.max(0, at - speechStartedAt) });
    emit(VA_EVENTS.SILENCE, { speaker: lastSpeaker });
  }

  function noteVoice({ at = now(), speaker = null, confidence = null } = {}) {
    lastVoiceAt = at;
    if (!speaking) startSpeech(at, speaker, confidence);
    else {
      if (speaker) lastSpeaker = speaker;
      emit(VA_EVENTS.CONTINUE, { speaker: lastSpeaker, confidence, durationMs: Math.max(0, at - speechStartedAt) });
    }
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { silenceTimer = null; endSpeech(now()); }, silenceHangoverMs);
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /** Feed the smoothed mic level (0..1) from audio.js. */
    pushLevel(level, at = now()) {
      if (level >= levelThreshold) noteVoice({ at });
    },

    /** Feed a Deepgram interim/partial transcript (strong speech signal). */
    pushInterim(text, { at = now(), speaker = null } = {}) {
      if (text && text.trim()) noteVoice({ at, speaker, confidence: 0.9 });
    },

    /** Feed a finalized segment — closes the current speech burst cleanly. */
    pushSegment({ speaker = null, at = now() } = {}) {
      lastSpeaker = speaker ?? lastSpeaker;
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      endSpeech(at);
    },

    /** Mark that Roma's own playback is active (so echo is attributable). */
    setRomaSpeaking(value) { romaSpeaking = Boolean(value); },

    isSpeaking: () => speaking,
    isRomaSpeaking: () => romaSpeaking,
    lastVoiceAt: () => lastVoiceAt,
    msSinceVoice: (at = now()) => (lastVoiceAt ? Math.max(0, at - lastVoiceAt) : Infinity),
    currentSpeaker: () => lastSpeaker,

    dispose() { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = null; listeners.clear(); },
  };
}
