// Reusable environment definitions for the virtual-hardware lab. Every field
// maps to an ACTUAL signal or rendering parameter consumed by audioEngine.js /
// videoEngine.js — an environment is a bundle of real conditions, never a label.
//
// Acoustics fields:
//   noiseGain        0..1   seeded background-noise loop level
//   noiseLowpass     0..1   noise spectrum shaping (lower = rumblier)
//   reverbSeconds    impulse-response length (0 disables the convolver)
//   reverbDecay      exponential decay factor of the impulse
//   reverbMix        0..1   wet/dry
//   speechLowpassHz  global low-pass on speech bus (walls/distance dulling)
//   defaultDistance  default person distance in meters (drives 1/d gain + filter)
// Visual fields:
//   lighting         0..1   multiplies rendered luminance (real pixel change)
//   background       renderer palette key

export const ENVIRONMENTS = {
  quiet_office: {
    roomProfile: 'quiet_office', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.004, noiseLowpass: 0.15, reverbSeconds: 0.15, reverbDecay: 8, reverbMix: 0.08, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.9, background: 'office' },
  },
  busy_office: {
    roomProfile: 'busy_office', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.02, noiseLowpass: 0.35, reverbSeconds: 0.25, reverbDecay: 6, reverbMix: 0.12, speechLowpassHz: 7000, defaultDistance: 1.5 },
    visual: { lighting: 0.85, background: 'office' },
  },
  echoing_room: {
    roomProfile: 'echoing_room', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.003, noiseLowpass: 0.1, reverbSeconds: 1.2, reverbDecay: 2, reverbMix: 0.45, speechLowpassHz: 8000, defaultDistance: 2 },
    visual: { lighting: 0.8, background: 'bare' },
  },
  living_room_tv: {
    roomProfile: 'living_room_tv', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.015, noiseLowpass: 0.5, reverbSeconds: 0.35, reverbDecay: 5, reverbMix: 0.15, speechLowpassHz: 7500, defaultDistance: 2, tvVoice: true },
    visual: { lighting: 0.6, background: 'living' },
  },
  noisy_workshop: {
    roomProfile: 'noisy_workshop', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.06, noiseLowpass: 0.3, reverbSeconds: 0.4, reverbDecay: 4, reverbMix: 0.2, speechLowpassHz: 6500, defaultDistance: 1.5 },
    visual: { lighting: 0.75, background: 'workshop' },
  },
  vehicle: {
    roomProfile: 'vehicle', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.09, noiseLowpass: 0.12, reverbSeconds: 0.08, reverbDecay: 10, reverbMix: 0.05, speechLowpassHz: 5500, defaultDistance: 0.8 },
    visual: { lighting: 0.7, background: 'bare' },
  },
  meeting_2p: {
    roomProfile: 'meeting_2p', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.008, noiseLowpass: 0.2, reverbSeconds: 0.3, reverbDecay: 5, reverbMix: 0.12, speechLowpassHz: 8000, defaultDistance: 1.2 },
    visual: { lighting: 0.9, background: 'office' },
  },
  meeting_3p: {
    roomProfile: 'meeting_3p', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.012, noiseLowpass: 0.25, reverbSeconds: 0.3, reverbDecay: 5, reverbMix: 0.12, speechLowpassHz: 8000, defaultDistance: 1.5 },
    visual: { lighting: 0.9, background: 'office' },
  },
  distant_speaker: {
    roomProfile: 'distant_speaker', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.01, noiseLowpass: 0.2, reverbSeconds: 0.6, reverbDecay: 3, reverbMix: 0.3, speechLowpassHz: 4500, defaultDistance: 4 },
    visual: { lighting: 0.85, background: 'bare' },
  },
  close_speaker: {
    roomProfile: 'close_speaker', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.002, noiseLowpass: 0.15, reverbSeconds: 0.1, reverbDecay: 9, reverbMix: 0.05, speechLowpassHz: 8000, defaultDistance: 0.4 },
    visual: { lighting: 0.9, background: 'bare' },
  },
  low_light_room: {
    roomProfile: 'quiet_office', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.005, noiseLowpass: 0.15, reverbSeconds: 0.2, reverbDecay: 7, reverbMix: 0.1, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.12, background: 'bare' },
  },
  moving_camera: {
    roomProfile: 'quiet_office', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.005, noiseLowpass: 0.15, reverbSeconds: 0.2, reverbDecay: 7, reverbMix: 0.1, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.85, background: 'office', cameraDriftPxPerSecond: 30 },
  },
  intermittent_network: {
    roomProfile: 'quiet_office', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.004, noiseLowpass: 0.15, reverbSeconds: 0.15, reverbDecay: 8, reverbMix: 0.08, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.9, background: 'office' },
    faults: ['data_api_block'],
  },
  database_restart: {
    roomProfile: 'quiet_office', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.004, noiseLowpass: 0.15, reverbSeconds: 0.15, reverbDecay: 8, reverbMix: 0.08, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.9, background: 'office' },
    faults: ['data_api_block'],
  },
  enrollment_booth: {
    roomProfile: 'enrollment_booth', visualTier: 'deterministic_geometric',
    acoustics: { noiseGain: 0.001, noiseLowpass: 0.1, reverbSeconds: 0.05, reverbDecay: 12, reverbMix: 0.02, speechLowpassHz: 8000, defaultDistance: 0.4 },
    visual: { lighting: 0.95, background: 'bare' },
  },
  conflicting_speakers: {
    roomProfile: 'meeting_2p', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.006, noiseLowpass: 0.2, reverbSeconds: 0.25, reverbDecay: 6, reverbMix: 0.1, speechLowpassHz: 8000, defaultDistance: 1.2 },
    visual: { lighting: 0.9, background: 'office' },
  },
  visual_question_room: {
    roomProfile: 'quiet_office', visualTier: 'recognition_compatible',
    acoustics: { noiseGain: 0.004, noiseLowpass: 0.15, reverbSeconds: 0.15, reverbDecay: 8, reverbMix: 0.08, speechLowpassHz: 8000, defaultDistance: 1 },
    visual: { lighting: 0.9, background: 'office' },
  },
};

export function getEnvironment(name) {
  return ENVIRONMENTS[name] ?? null;
}
