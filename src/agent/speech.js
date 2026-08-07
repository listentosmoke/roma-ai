// Speech-output boundary — PLACEHOLDER. The runtime routes every user-facing
// response/clarification through speak() rather than assuming a decision should
// immediately trigger audio playback. TTS is not implemented yet; speak() is a
// documented no-op. Wire a real synthesizer behind this same contract:
//
//   createSpeechOutput({ speak: async (text) => { ...call a TTS API... } })

export function createSpeechOutput({ speak: speakImpl } = {}) {
  return {
    name: speakImpl ? 'custom' : 'stub',
    speak(text) {
      if (speakImpl) return speakImpl(text);
      return undefined; // no-op placeholder
    },
  };
}
