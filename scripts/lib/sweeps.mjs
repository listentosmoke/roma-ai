// Bounded parameter-sweep definitions for scripts/explore-simulation-boundaries.mjs.
// Separate module so tests can verify the bounds without executing a sweep.

export const SWEEPS = {
  gain: { parameter: 'speech gain (dB)', values: [0, -12, -20, -28, -34, -40], maxTrials: 8 },
  distance: { parameter: 'speaker distance (m)', values: [0.5, 1.5, 3, 5, 8, 12], maxTrials: 8 },
  noise: { parameter: 'background noise gain', values: [0.01, 0.05, 0.12, 0.25, 0.5, 0.9], maxTrials: 8 },
};
