// Virtual-hardware lab internals: deterministic oracle conditions, seeded
// fixture generation (real waveform math), report redaction, isolated-server
// hygiene, and production-build exclusion of all simulation code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCondition } from '../src/simulation/oracle.js';
import { generateSyntheticVoice, generateNoise, generateImpulseResponse, encodeWav, pcm16ToFloat32, resample, rms, seededRandom } from '../scripts/lib/wav.mjs';
import { redact } from '../scripts/lib/reports.mjs';
import { SWEEPS } from '../scripts/lib/sweeps.mjs';

// ── oracle ──────────────────────────────────────────────────────────────────

const snap = (over = {}) => ({
  sim: { consoleErrorCount: 0, frameTick: 0, frameSignature: 1, audioLevel: 0, ...over.sim },
  app: {
    listening: true,
    segments: [],
    agentEvents: [],
    voiceEvents: [],
    deliveryMetrics: { approved: 0, denied: 0, ttsRequests: 0, echoesSuppressed: 0, bargeIns: 0, playback: { started: 0, completed: 0, stopped: 0, blocked: 0 } },
    memoryCounts: { total: 0 },
    memoryQueue: { open: 0, acknowledged: 0, failed: 0 },
    scene: null,
    engagement: { active: false },
    ...over.app,
  },
});

test('oracle: playback/echo/barge-in conditions are counter deltas, never labels', () => {
  const baseline = snap();
  const current = snap({ app: { deliveryMetrics: { approved: 1, denied: 0, ttsRequests: 1, echoesSuppressed: 1, bargeIns: 1, playback: { started: 1, completed: 1, stopped: 1, blocked: 0 } } } });
  for (const condition of ['roma.speech_authorized', 'roma.tts_requested', 'roma.playback_started', 'roma.playback_completed', 'roma.playback_stopped', 'roma.echo_suppressed', 'roma.barge_in']) {
    assert.equal(evaluateCondition(condition, { current, baseline }).pass, true, condition);
    assert.equal(evaluateCondition(condition, { current: baseline, baseline }).pass, false, `${condition} without delta`);
  }
});

test('oracle: decision conditions use observed agent events since baseline', () => {
  const baseline = snap();
  const responded = snap({ app: { agentEvents: [{ type: 'response', turnId: 1 }] } });
  assert.equal(evaluateCondition('roma.decision_respond', { current: responded, baseline }).pass, true);
  assert.equal(evaluateCondition('roma.no_response', { current: responded, baseline }).pass, false);
  assert.equal(evaluateCondition('roma.no_response', { current: snap({ app: { agentEvents: [{ type: 'ignored-turn', turnId: 1 }] } }), baseline }).pass, true);
});

test('oracle: scene conditions read real Inspector state with param matching', () => {
  const baseline = snap();
  const withSign = snap({ app: { scene: { revision: 3, objects: [{ label: 'stop sign', position: 'center', visibility: 'visible', confidence: 0.9 }], people: 0 } } });
  assert.equal(evaluateCondition('roma.scene_object_visible', { current: withSign, baseline, param: 'stop sign' }).pass, true);
  assert.equal(evaluateCondition('roma.scene_object_missing', { current: withSign, baseline, param: 'stop sign' }).pass, false);
  assert.equal(evaluateCondition('roma.scene_object_visible', { current: withSign, baseline, param: 'chair' }).pass, false);
  assert.equal(evaluateCondition('roma.scene_updated', { current: withSign, baseline: snap({ app: { scene: { revision: 1, objects: [], people: 0 } } }) }).pass, true);
});

test('oracle: unknown conditions never pass', () => {
  assert.equal(evaluateCondition('roma.invented', { current: snap(), baseline: snap() }).pass, false);
});

// ── seeded fixtures: the waveform genuinely changes ─────────────────────────

test('synthetic voices are seed-deterministic and differ across voices/settings', () => {
  const a1 = generateSyntheticVoice({ seconds: 0.5, pitchHz: 120, seed: 9 });
  const a2 = generateSyntheticVoice({ seconds: 0.5, pitchHz: 120, seed: 9 });
  const b = generateSyntheticVoice({ seconds: 0.5, pitchHz: 240, seed: 9 });
  assert.deepEqual(Array.from(a1.slice(0, 200)), Array.from(a2.slice(0, 200)), 'same seed => identical waveform (reproducible scenarios)');
  assert.notDeepEqual(Array.from(a1.slice(0, 200)), Array.from(b.slice(0, 200)), 'different pitch => different waveform');
  assert.ok(rms(a1) > 0.01, 'the signal is real, not silence');
});

test('noise changes the waveform and differs by seed; impulse decays for reverb', () => {
  const n1 = generateNoise({ seconds: 0.3, seed: 1, gain: 0.1 });
  const n2 = generateNoise({ seconds: 0.3, seed: 2, gain: 0.1 });
  assert.ok(rms(n1) > 0.001);
  assert.notDeepEqual(Array.from(n1.slice(0, 50)), Array.from(n2.slice(0, 50)));
  const impulse = generateImpulseResponse({ seconds: 0.2, decay: 6 });
  assert.ok(Math.abs(impulse[10]) > Math.abs(impulse[impulse.length - 10]) || rms(impulse.slice(0, 100)) > rms(impulse.slice(-100)), 'impulse energy decays');
});

test('WAV encode/PCM decode round-trips samples within 16-bit precision', () => {
  const original = generateSyntheticVoice({ seconds: 0.1, seed: 3 });
  const wav = encodeWav(original, 48000);
  assert.equal(wav.readUInt32LE(24), 48000, 'sample rate header');
  const decoded = pcm16ToFloat32(wav.subarray(44));
  for (let i = 0; i < 50; i += 1) assert.ok(Math.abs(decoded[i] - Math.max(-1, Math.min(1, original[i]))) < 1 / 0x4000, `sample ${i}`);
  assert.equal(resample(original, 48000, 16000).length, Math.floor(original.length / 3));
});

test('seeded PRNG is stable across calls (replayable randomness)', () => {
  const r1 = seededRandom(42); const r2 = seededRandom(42);
  for (let i = 0; i < 20; i += 1) assert.equal(r1(), r2());
});

// ── sweeps are bounded ──────────────────────────────────────────────────────

test('parameter sweeps declare bounded trial counts', () => {
  for (const [name, sweep] of Object.entries(SWEEPS)) {
    assert.ok(sweep.maxTrials <= 12, `${name} maxTrials bounded`);
    assert.ok(sweep.values.length <= sweep.maxTrials + 2, `${name} value list bounded`);
  }
});

// ── report redaction ────────────────────────────────────────────────────────

test('reports redact biometric/secret-shaped keys and truncate long strings', () => {
  const redacted = redact({
    template: [0.1, 0.2],
    nested: { embedding: 'abc', apiKey: 'sk-xyz', audioBase64: 'AAAA', fine: 'kept' },
    long: 'y'.repeat(2000),
  });
  assert.equal(redacted.template, '[redacted]');
  assert.equal(redacted.nested.embedding, '[redacted]');
  assert.equal(redacted.nested.apiKey, '[redacted]');
  assert.equal(redacted.nested.audioBase64, '[redacted]');
  assert.equal(redacted.nested.fine, 'kept');
  assert.ok(redacted.long.length < 700 && redacted.long.endsWith('[truncated]'));
});

// ── isolation ───────────────────────────────────────────────────────────────

/** Strip // line comments and block comments so structural checks only see CODE, not prose. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('isolated server config never points at the real database and uses unique tenants', async () => {
  // Static inspection (starting real Vite here would be slow/flaky in CI):
  const source = readFileSync('scripts/lib/simServer.mjs', 'utf8');
  assert.match(source, /mkdtempSync/, 'disposable temp directory');
  assert.match(source, /ROMA_DB_PATH: dbPath/, 'points ROMA_DB_PATH at the temp db');
  assert.match(source, /dbPath = join\(workDir/, 'db lives inside the disposable work dir');
  assert.match(source, /randomBytes\(32\)/, 'temporary biometric key per run');
  assert.match(source, /DEV_PRINCIPAL_WORKSPACE_ID/, 'isolated tenant per run');
  assert.doesNotMatch(codeOnly(source), /data[\\/]roma\.db/, 'never references the real database file in code');
  const chromeSource = readFileSync('scripts/lib/chrome.mjs', 'utf8');
  assert.match(chromeSource, /mkdtempSync/, 'temporary browser profile');
  assert.match(chromeSource, /rmSync\(profile/, 'profile cleanup');
});

test('the real development database is untouched by lab runs (guard file check)', () => {
  // The lab writes only under tmpdir/.simcache/.simreports. If data/roma.db
  // exists, nothing in the simulation tree may reference it in CODE.
  for (const file of ['src/simulation/index.js', 'scripts/lib/virtualLab.mjs', 'scripts/run-virtual-scenarios.mjs']) {
    assert.doesNotMatch(codeOnly(readFileSync(file, 'utf8')), /roma\.db/, `${file} must not touch the real db`);
  }
});

// ── production separation ───────────────────────────────────────────────────

test('production bundle contains no simulation code or activation flags', () => {
  const assetsDir = join(process.cwd(), 'dist', 'assets');
  if (!existsSync(assetsDir)) { assert.ok(true, 'no dist build present — covered when built'); return; }
  const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  assert.ok(bundles.length > 0);
  for (const bundle of bundles) {
    const content = readFileSync(join(assetsDir, bundle), 'utf8');
    for (const marker of ['__ROMA_SIMULATION__', '__romaSim', 'activateSimulation', 'SIMULATED ENVIRONMENT', '__romaSimulationPlaybackTap', 'createAudioEngine', 'installVirtualDevices']) {
      assert.ok(!content.includes(marker), `${bundle} leaked simulation marker "${marker}" into production`);
    }
  }
});

test('simulation activation requires the pre-load injected flag — no query-parameter path exists', () => {
  const mainSource = readFileSync('src/main.jsx', 'utf8');
  assert.match(mainSource, /import\.meta\.env\.DEV && window\.__ROMA_SIMULATION__/, 'DEV + injected flag double gate');
  const simSource = codeOnly(readFileSync('src/simulation/index.js', 'utf8'));
  assert.doesNotMatch(simSource, /location\.search|URLSearchParams|localStorage/, 'no query-param/localStorage activation in code');
});

test('the simulation lab never imports Roma subsystems (media + observation only)', () => {
  const forbidden = /from '\.\.\/(agent|memory|identity|proactive|voice|inspector|engine)\//;
  for (const file of readdirSync('src/simulation').filter((f) => f.endsWith('.js'))) {
    const content = readFileSync(join('src', 'simulation', file), 'utf8');
    assert.doesNotMatch(content, forbidden, `src/simulation/${file} must not import Roma subsystems`);
  }
});
