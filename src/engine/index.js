import { config } from './config.js';
import { createDeepgramEngine } from './deepgram.js';

export { config };

// Build the active engine. Engines share one interface:
//   start(handlers) / stop() / labels()
// where handlers = { onInterim, onSegment, onSpeakers, onLevel, onStatus, onError }.
// Deepgram is the only engine today; the factory keeps room for others.
export function createEngine(overrides = {}) {
  const merged = { ...config, ...overrides };
  switch (merged.engine) {
    case 'deepgram':
    default:
      return createDeepgramEngine(merged);
  }
}
