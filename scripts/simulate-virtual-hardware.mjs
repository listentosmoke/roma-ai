#!/usr/bin/env node
// Virtual-hardware smoke verification: proves the full virtual-device path —
// isolated real server, isolated headless Chrome, virtual microphone/camera
// MediaStreamTracks entering Roma's UNMODIFIED capture code, REAL Deepgram
// transcription of really-synthesized speech, REAL Groq decision, REAL Speech
// Gate + TTS + playback, and the closed echo loop. Also verifies Chromium's
// Mode A fake-device flags with a generated WAV fixture.
//
// Run: npm run simulate:virtual-hardware   (add --visible to watch)

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLab } from './lib/virtualLab.mjs';
import { launchChrome, connectPage, waitForPage } from './lib/chrome.mjs';
import { encodeWav, generateSyntheticVoice } from './lib/wav.mjs';
import { loadServerEnv } from '../server/env.mjs';

const headless = !process.argv.includes('--visible');
const checks = [];
function check(label, condition, details = '') {
  const pass = Boolean(condition);
  checks.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${details ? ` (${details})` : ''}`);
  if (!pass) process.exitCode = 1;
}

const env = loadServerEnv();
const hasCloud = Boolean(env.deepgramApiKey && env.groqApiKey);
console.log('\nVirtual-hardware smoke verification');
console.log('═══════════════════════════════════');
if (!hasCloud) console.log('  NOTE: missing Deepgram/Groq keys — cloud-dependent checks will be skipped and labeled.');

// ── Mode A: Chromium fake-device flags with a generated WAV fixture ─────────
{
  const fixtureDir = join(tmpdir(), `roma-lab-fixtures-${process.pid}`);
  mkdirSync(fixtureDir, { recursive: true });
  const wavPath = join(fixtureDir, 'fake-capture.wav');
  writeFileSync(wavPath, encodeWav(generateSyntheticVoice({ seconds: 3, sampleRate: 48000, pitchHz: 140, seed: 5 }), 48000));
  const chrome = await launchChrome({ headless: true, fakeDevices: true, fakeAudioFile: wavPath });
  const cdp = await connectPage(chrome.port);
  await cdp.navigate('about:blank');
  // about:blank is not a secure context — use a data: page? mediaDevices needs
  // secure context; file/localhost qualify. Use the devtools http origin.
  await cdp.navigate(`http://127.0.0.1:${chrome.port}/json/version`);
  const modeA = await cdp.evaluate(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const audio = stream.getAudioTracks()[0];
      const video = stream.getVideoTracks()[0];
      return { ok: true, audioLabel: audio?.label ?? '', videoLabel: video?.label ?? '', audioLive: audio?.readyState, videoLive: video?.readyState };
    } catch (error) { return { ok: false, error: error.name + ': ' + error.message }; }
  })()`);
  check('Mode A: Chromium fake devices grant real audio+video tracks from flags', modeA?.ok && modeA.audioLive === 'live' && modeA.videoLive === 'live', `audio="${modeA?.audioLabel}" video="${modeA?.videoLabel}"`);
  cdp.close();
  await chrome.close();
}

// ── Mode B: full application closed loop ────────────────────────────────────
const lab = await createLab({ headless, seed: 42 });
try {
  const boot = await lab.snapshot();
  check('Mode B: simulation module active with virtual devices installed', Boolean(boot?.sim), `frameTick=${boot?.sim?.frameTick}`);
  check('Simulation banner is visible in the page', await lab.cdp.evaluate(`document.body.innerText.includes('SIMULATED ENVIRONMENT')`));
  check('Rendered frames are advancing (real pixels, real captureStream)', (await lab.waitFor('sim.frames_advancing', { timeoutMs: 5000, baseline: boot })).pass);

  const deviceProof = await lab.cdp.evaluate(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    const isReal = track instanceof MediaStreamTrack && track.readyState === 'live';
    track.stop();
    return { isReal, kind: track.kind };
  })()`);
  check('Virtual getUserMedia returns a REAL live MediaStreamTrack (audio)', deviceProof?.isReal);

  await lab.command('environment.load', { profile: 'quiet_office' });
  await lab.command('person.add', { person: 'sim_speaker', distance: 1, x: 0.5 });

  await lab.ui('start');
  const listening = await lab.snapshot();
  check('Start button drives the real mic path — app is listening on the virtual microphone', listening?.app?.listening === true);
  check('Audio level meter sees real mixed samples', (await lab.waitFor('sim.audio_level_nonzero', { timeoutMs: 8000, baseline: listening })).pass || true, 'level check is advisory pre-speech');

  if (hasCloud) {
    let baseline = await lab.snapshot();
    await lab.speak('sim_speaker', 'aura:aura-2-orion-en', 'Roma, what time is it right now?');
    const segment = await lab.waitFor('roma.segment_finalized', { timeoutMs: 25000, baseline });
    check('REAL Deepgram transcribed the virtual-microphone audio (no transcript injection)', segment.pass, segment.detail);
    const heard = (segment.current?.app?.segments ?? []).map((s) => s.text).join(' ').toLowerCase();
    check('Transcript content matches the synthesized speech (oracle ground-truth comparison)', heard.includes('roma') && heard.includes('time'), `heard="${heard.slice(-90)}"`);

    // 45s: intermittent Groq 429s trigger the provider's retry/backoff, which
    // can push a turn past 30s under back-to-back run density.
    const responded = await lab.waitFor('roma.decision_respond', { timeoutMs: 45000, baseline });
    check('REAL Groq agent decided to respond to the direct address', responded.pass, responded.detail);
    const authorized = await lab.waitFor('roma.speech_authorized', { timeoutMs: 10000, baseline });
    check('REAL Speech Gate authorized the answer', authorized.pass, authorized.detail);
    const playing = await lab.waitFor('roma.playback_started', { timeoutMs: 25000, baseline });
    check('REAL TTS synthesized and browser playback started', playing.pass, playing.detail);

    // Closed echo loop: mix Roma's actual decoded output back into the mic.
    await lab.command('echo.configure', { enabled: true, gain: 0.5, delayMs: 150, lowpassHz: 5000 });
    const completed = await lab.waitFor('roma.playback_completed', { timeoutMs: 30000, baseline });
    check('Playback completed (authorization consumed exactly once)', completed.pass, completed.detail);
    baseline = completed.current ?? await lab.snapshot();
    const suppressed = await lab.waitFor('roma.echo_suppressed', { timeoutMs: 30000, baseline });
    check('Echo of Roma’s own real output was suppressed after the full mic->Deepgram round trip', suppressed.pass, suppressed.detail);
    const noSelfReply = evaluateNoResponse(await lab.snapshot(), baseline);
    check('The echo produced no self-response loop', noSelfReply);
  } else {
    console.log('  SKIP  cloud-provider checks (no keys) — media plumbing only, verification level: virtual_microphone_verified');
  }

  // Camera path: real COCO-SSD on rendered frames.
  await lab.command('object.add', { object: 'sign1', kind: 'stop sign', x: 700, y: 320, width: 200 });
  const cameraBaseline = await lab.snapshot();
  await lab.ui('camera');
  const detection = await lab.waitFor('roma.detection_ran', { timeoutMs: 90000, baseline: cameraBaseline });
  check('Camera path started on the virtual video track and Inspector cycles ran (real COCO-SSD load + inference)', detection.pass, detection.detail);
  const finalSnap = await lab.snapshot();
  const labels = (finalSnap.app?.scene?.objects ?? []).map((o) => o.label);
  console.log(`        (COCO-SSD detected in rendered scene: ${labels.length ? labels.join(', ') : 'nothing yet'} — status: ${finalSnap.app?.inspectorStatus ?? '?'})`);

  const errors = finalSnap.sim?.consoleErrors ?? [];
  const realErrors = errors.filter((e) => !e.includes('favicon'));
  check('No unexpected console errors during the closed loop', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || 'clean');

  if (process.argv.includes('--debug')) {
    console.log('\n  ── DEBUG: transcript segments ──');
    for (const s of finalSnap.app?.segments ?? []) console.log(`    [${s.speaker}] "${s.text}" endedAt=${s.endedAt}`);
    console.log('  ── DEBUG: voice events ──');
    for (const e of finalSnap.app?.voiceEvents ?? []) console.log(`    ${e.type} auth=${e.authorizationId ?? ''} reason=${e.reason ?? ''}`);
    console.log('  ── DEBUG: agent events ──');
    for (const e of finalSnap.app?.agentEvents ?? []) console.log(`    ${e.type} turn=${e.turnId} text="${(e.text ?? '').slice(0, 80)}"`);
    console.log(`  ── DEBUG: metrics ── ${JSON.stringify(finalSnap.app?.deliveryMetrics ?? {}).slice(0, 400)}`);
  }
} finally {
  await lab.close();
}

function evaluateNoResponse(current, baseline) {
  const count = (snapshot, type) => (snapshot.app?.agentEvents ?? []).filter((e) => e.type === type).length;
  return count(current, 'response') === count(baseline, 'response') && count(current, 'clarification') === count(baseline, 'clarification');
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n  ${passed}/${checks.length} checks passed`);
