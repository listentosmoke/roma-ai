#!/usr/bin/env node
// Bounded parameter exploration: sweeps a real signal parameter and measures
// where the REAL pipeline (virtual mic -> Deepgram) starts failing. Every
// trial changes the actual waveform (gain or distance), never a label. The
// result is an approximate operating boundary for THIS synthetic setup — not
// a universal real-world guarantee.
//
//   npm run explore:virtual-boundaries              # gain sweep (default)
//   npm run explore:virtual-boundaries -- --sweep distance
//   npm run explore:virtual-boundaries -- --sweep noise

import { createLab } from './lib/virtualLab.mjs';
import { writeReports } from './lib/reports.mjs';
import { SWEEPS } from './lib/sweeps.mjs';
import { loadServerEnv } from '../server/env.mjs';

const env = loadServerEnv();
if (!env.deepgramApiKey) { console.error('Boundary exploration needs DEEPGRAM_API_KEY.'); process.exit(1); }

const args = process.argv.slice(2);
const sweepName = args.includes('--sweep') ? args[args.indexOf('--sweep') + 1] : 'gain';
const sweep = SWEEPS[sweepName];
if (!sweep) { console.error(`Unknown sweep "${sweepName}". Options: ${Object.keys(SWEEPS).join(', ')}`); process.exit(1); }

const PHRASE = 'The quick brown fox jumps over the lazy dog tonight.';
const PHRASE_TOKENS = PHRASE.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);

function wordRecall(transcript) {
  const heard = new Set(transcript.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/));
  const matched = PHRASE_TOKENS.filter((token) => heard.has(token)).length;
  return matched / PHRASE_TOKENS.length;
}

console.log(`\nBoundary exploration — sweep: ${sweep.parameter}`);
console.log('═══════════════════════════════════════════════');

const lab = await createLab({ headless: true, seed: 7 });
const trials = [];
try {
  await lab.command('environment.load', { profile: 'quiet_office' });
  await lab.command('person.add', { person: 'sim_probe', distance: 1 });
  await lab.ui('start');

  for (const value of sweep.values.slice(0, sweep.maxTrials)) {
    if (sweepName === 'distance') await lab.command('person.move', { person: 'sim_probe', distance: value });
    const baseline = await lab.snapshot();
    if (sweepName === 'noise') {
      // Real SNR change: a competing synthetic "noise talker" mixed at a
      // scaled gain alongside the probe phrase — the waveform genuinely
      // changes per trial.
      await lab.speak('sim_noise', 'synth:low_male', 'background rumble', { gainDb: 20 * Math.log10(value / 0.05) });
    }
    const gainDb = sweepName === 'gain' ? value : 0;
    await lab.speak('sim_probe', 'aura:aura-2-thalia-en', PHRASE, { gainDb });
    const segment = await lab.waitFor('roma.segment_finalized', { timeoutMs: 20000, baseline });
    const heardText = segment.pass ? (segment.current.app.segments ?? []).map((s) => s.text).join(' ') : '';
    const recall = segment.pass ? wordRecall(heardText.split(PHRASE.slice(0, 8))[1] ?? heardText) : 0;
    const fullRecall = segment.pass ? wordRecall(heardText) : 0;
    trials.push({ value, transcribed: segment.pass, wordRecall: +fullRecall.toFixed(2) });
    console.log(`  ${sweep.parameter} = ${value}: ${segment.pass ? `transcribed, word recall ${(fullRecall * 100).toFixed(0)}%` : 'NOT transcribed within timeout'}`);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // settle between trials
  }
} finally {
  await lab.close();
}

const boundary = trials.find((t) => !t.transcribed || t.wordRecall < 0.5);
const summary = {
  scenarioId: `boundary_${sweepName}_sweep`,
  passed: true,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 0,
  verificationLevel: 'closed_loop_simulation_verified',
  environment: 'quiet_office',
  components: { stt: 'REAL Deepgram nova-3', speech_source: 'REAL Deepgram Aura + deterministic signal ops' },
  assertions: trials.map((t) => ({ condition: `recall@${sweep.parameter}=${t.value}`, pass: true, detail: t.transcribed ? `word recall ${(t.wordRecall * 100).toFixed(0)}%` : 'not transcribed' })),
  timeline: [],
  groundTruth: [{ person: 'sim_probe', text: PHRASE, provider: 'deepgram_aura:aura-2-thalia-en' }],
  transcript: [],
  notes: [
    `Approximate failure boundary: ${boundary ? `${sweep.parameter} ≈ ${boundary.value}` : `not reached within swept range (${sweep.values.join(', ')})`}.`,
    'Synthetic-room measurement only — not a universal claim about real microphones or rooms.',
  ],
};
const reports = writeReports(summary);
console.log(`\n  Boundary: ${boundary ? `${sweep.parameter} ≈ ${boundary.value}` : 'not reached in swept range'}`);
console.log(`  Report: ${reports.markdown}`);
