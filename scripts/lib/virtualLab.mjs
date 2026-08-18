// The Virtual Hardware Lab — Scenario Director (Node side).
//
// Owns one isolated run: real Vite server (disposable DB, isolated tenant,
// temp biometric key) + isolated headless Chrome with the in-page simulation
// activated via a pre-load injected flag. Exposes the bounded command API
// Claude drives (person.speak, echo.configure, wait_for, assert, …), executes
// validated declarative scenarios, evaluates every condition through the
// deterministic oracle, and writes JSON/Markdown reports.
//
// Nothing in this file calls a Roma subsystem directly: commands only shape
// media signals in the page and read bounded observability snapshots.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateScenario } from '../../src/simulation/schema.js';
import { getEnvironment } from '../../src/simulation/environments.js';
import { evaluateCondition } from '../../src/simulation/oracle.js';
import { resolveVoiceAudio, DEFAULT_VOICES } from './voices.mjs';
import { startIsolatedServer } from './simServer.mjs';
import { launchChrome, connectPage, waitForPage } from './chrome.mjs';
import { writeReports } from './reports.mjs';

const FAULT_URL_PATTERNS = {
  deepgram_block: ['*api/deepgram*'],
  agent_block: ['*api/agent/infer*'],
  tts_block: ['*api/tts/*'],
  data_api_block: ['*api/data/*', '*api/session*', '*api/consent*'],
};

export async function createLab({ headless = true, seed = 1, log = (line) => console.log(line), keepBrowserOpen = false, worker = 'mock' } = {}) {
  const server = await startIsolatedServer({ worker });
  log(`  [lab] isolated server ${server.baseUrl} (db: disposable, tenant: ${server.workspaceId}, worker: ${worker})`);
  const chrome = await launchChrome({ headless });
  const cdp = await connectPage(chrome.port);
  await cdp.injectOnNewDocument(`window.__ROMA_SIMULATION__ = { seed: ${Number(seed)}, cameraFps: 12 };`);
  await cdp.navigate(server.baseUrl);
  await waitForPage(cdp, 'Boolean(window.__romaSim)', { timeoutMs: 20000, label: 'simulation module active' });
  log('  [lab] simulation active in page (banner visible, virtual devices installed)');

  const activeFaults = new Set();
  const groundTruth = [];
  const timeline = [];
  const startedAtMs = Date.now();
  function record(kind, detail) { timeline.push({ atMs: Date.now() - startedAtMs, kind, detail: String(detail).slice(0, 220) }); }

  async function snapshot() {
    return cdp.evaluate('window.__romaSim.snapshot()');
  }

  async function ui(control) {
    if (control === 'start') {
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Start'); if (!b) throw new Error('Start button not found'); b.click(); return true; })()`);
      await waitForPage(cdp, `window.__romaSim.snapshot().app.listening === true`, { timeoutMs: 20000, label: 'listening after Start' });
      return;
    }
    if (control === 'stop') {
      await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Stop'); b?.click(); return true; })()`);
      return;
    }
    if (control === 'camera') {
      await cdp.evaluate(`(() => { const b = document.querySelector('button[title*="camera" i], button[aria-label*="camera" i]') ?? [...document.querySelectorAll('button')].find(x => (x.title ?? '').toLowerCase().includes('camera')); if (!b) throw new Error('camera button not found'); b.click(); return true; })()`);
      return;
    }
    throw new Error(`Unknown ui control "${control}"`);
  }

  async function speak(personId, voiceSource, text, { gainDb = 0, rate = 1, waitDone = false } = {}) {
    const resolved = await resolveVoiceAudio(voiceSource, text, { baseUrl: server.baseUrl });
    groundTruth.push({ person: personId, text, provider: resolved.provider, real: resolved.real });
    record('speak', `${personId} (${resolved.provider}): "${text.slice(0, 80)}"`);
    const b64 = resolved.wav.toString('base64');
    const handle = await cdp.evaluate(`window.__romaSim.speak(${JSON.stringify(personId)}, ${JSON.stringify(b64)}, { gainDb: ${gainDb}, rate: ${rate} })`);
    if (waitDone) await new Promise((resolve) => setTimeout(resolve, (handle?.durationMs ?? 1000) + 200));
    return handle;
  }

  async function triggerFault(fault, durationMs = null) {
    record('fault', `${fault}${durationMs ? ` for ${durationMs}ms` : ''}`);
    if (FAULT_URL_PATTERNS[fault]) {
      activeFaults.add(fault);
      await cdp.setBlockedUrls([...activeFaults].flatMap((f) => FAULT_URL_PATTERNS[f] ?? []));
    } else if (fault === 'network_offline') { activeFaults.add(fault); await cdp.setOffline(true); }
    else if (fault === 'audio_dropout') await cdp.evaluate(`window.__romaSim.audioDropout(${durationMs ?? 800})`);
    else if (fault === 'camera_freeze') { activeFaults.add(fault); await cdp.evaluate('window.__romaSim.freezeCamera()'); }
    else if (fault === 'audio_track_end') await cdp.evaluate('window.__romaSim.endAudioTrack()');
    else if (fault === 'video_track_end') await cdp.evaluate('window.__romaSim.endVideoTrack()');
    else throw new Error(`Unknown fault "${fault}"`);
    if (durationMs && FAULT_URL_PATTERNS[fault]) setTimeout(() => { clearFault(fault).catch(() => {}); }, durationMs);
  }

  async function clearFault(fault) {
    activeFaults.delete(fault);
    record('fault-cleared', fault);
    if (FAULT_URL_PATTERNS[fault]) await cdp.setBlockedUrls([...activeFaults].flatMap((f) => FAULT_URL_PATTERNS[f] ?? []));
    else if (fault === 'network_offline') await cdp.setOffline(false);
    else if (fault === 'camera_freeze') await cdp.evaluate('window.__romaSim.unfreezeCamera()');
  }

  async function waitFor(condition, { timeoutMs = 15000, param = null, baseline }) {
    const deadline = Date.now() + Math.min(timeoutMs, 120000);
    let last = { pass: false, detail: 'not evaluated' };
    while (Date.now() < deadline) {
      const current = await snapshot();
      last = evaluateCondition(condition, { current, baseline, param });
      if (last.pass) { record('wait_for', `${condition} satisfied — ${last.detail}`); return { ...last, current }; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    record('wait_for-timeout', `${condition} — ${last.detail}`);
    return { ...last, pass: false, timedOut: true, current: await snapshot() };
  }

  return {
    server,
    chrome,
    cdp,
    /** Which worker engine this lab's server was started with; fixed for its lifetime. */
    worker,
    snapshot,
    ui,
    speak,
    triggerFault,
    clearFault,
    waitFor,
    record,
    groundTruth,
    timeline,

    /** Direct command surface (used by ad-hoc/NL-authored scenarios and the runner below). */
    async command(action, args = {}) {
      const js = (call) => cdp.evaluate(call);
      switch (action) {
        case 'environment.load': return js(`window.__romaSim.applyEnvironment(${JSON.stringify(args.profile)})`);
        case 'person.add': return js(`window.__romaSim.addPerson(${JSON.stringify(args.person)}, ${JSON.stringify(args)})`);
        case 'person.move': return js(`window.__romaSim.movePerson(${JSON.stringify(args.person)}, ${JSON.stringify(args)})`);
        case 'person.remove': return js(`window.__romaSim.removePerson(${JSON.stringify(args.person)})`);
        case 'person.stop': return js(`window.__romaSim.stopSpeaking(${JSON.stringify(args.person)})`);
        case 'object.add': return js(`window.__romaSim.addObject(${JSON.stringify(args.object)}, ${JSON.stringify(args)})`);
        case 'object.move': return js(`window.__romaSim.moveObject(${JSON.stringify(args.object)}, ${JSON.stringify(args)})`);
        case 'object.remove': return js(`window.__romaSim.removeObject(${JSON.stringify(args.object)})`);
        case 'lighting.set': return js(`window.__romaSim.setLighting(${Number(args.level)})`);
        case 'camera.move': return js(`window.__romaSim.moveCamera(${JSON.stringify(args)})`);
        case 'echo.configure': return js(`window.__romaSim.configureEcho(${JSON.stringify(args)})`);
        case 'microphone.setGain': return js(`window.__romaSim.setMicGain(${Number(args.gain)})`);
        default: throw new Error(`Unknown command ${action}`);
      }
    },

    async close() {
      if (!keepBrowserOpen) { cdp.close(); await chrome.close(); }
      await server.close();
    },
  };
}

/**
 * Execute a validated declarative scenario against a lab instance.
 * Baseline semantics: condition deltas are measured against the snapshot
 * taken after the PREVIOUS wait_for/assert/speak completed (a fresh marker),
 * so each check observes only what happened since the last checkpoint.
 */
export async function runScenario(lab, scenario, { requiredOnly = false, voices = DEFAULT_VOICES, log = (line) => console.log(line) } = {}) {
  const validation = validateScenario(scenario);
  if (!validation.ok) throw new Error(`Scenario ${scenario?.scenarioId ?? '?'} failed validation:\n  ${validation.errors.join('\n  ')}`);

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const assertions = [];
  const environmentName = scenario.environment?.roomProfile ?? null;
  const environment = environmentName ? getEnvironment(environmentName) : null;
  const personVoices = new Map();

  if (environmentName) await lab.command('environment.load', { profile: environmentName });
  for (const person of scenario.people ?? []) {
    personVoices.set(person.simulationId, person.voice ?? voices.voice_a);
    await lab.command('person.add', {
      person: person.simulationId,
      x: person.position?.x ?? 0,
      distance: person.position?.z ?? environment?.acoustics?.defaultDistance ?? 1,
      visible: person.visible ?? false,
      frameX: person.frameX,
      frameY: person.frameY,
    });
  }

  let baseline = await lab.snapshot();
  const scenarioStartSnapshot = baseline;

  async function executeEvents(events) {
    for (const event of events) {
      switch (event.action) {
        case 'environment.load':
        case 'room.setProfile':
          await lab.command('environment.load', { profile: event.profile });
          break;
        case 'person.add': case 'person.move': case 'person.remove': case 'person.stop':
        case 'object.add': case 'object.move': case 'object.remove':
        case 'lighting.set': case 'camera.move': case 'echo.configure': case 'microphone.setGain':
          await lab.command(event.action, event);
          break;
        case 'person.speak': {
          baseline = await lab.snapshot();
          const voice = personVoices.get(event.person) ?? DEFAULT_VOICES.voice_a;
          await lab.speak(event.person, voice, event.text, { gainDb: event.gainDb ?? 0, rate: event.rate ?? 1 });
          break;
        }
        case 'person.interrupt': {
          const voice = personVoices.get(event.person) ?? DEFAULT_VOICES.voice_a;
          const waited = await lab.waitFor('roma.playback_started', { timeoutMs: 25000, baseline });
          if (waited.pass) {
            if (event.afterPlaybackMs) await new Promise((resolve) => setTimeout(resolve, event.afterPlaybackMs));
            baseline = await lab.snapshot();
            await lab.speak(event.person, voice, event.text, { gainDb: event.gainDb ?? 0 });
          } else {
            assertions.push({ condition: 'roma.playback_started', pass: false, detail: 'interrupt precondition: playback never started', required: true });
          }
          break;
        }
        case 'project.register': {
          // Setup step: register an allowlisted project on the isolated
          // server so dispatch scenarios have somewhere legitimate to work.
          const response = await fetch(`${lab.server.baseUrl}/api/agent-projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: event.name, rootPath: event.rootPath ?? process.cwd(), defaultTestCmd: event.testCmd ?? 'node --test' }),
          });
          lab.record('project.register', `${event.name} -> ${response.status}`);
          break;
        }
        case 'wait':
          await new Promise((resolve) => setTimeout(resolve, event.ms));
          break;
        case 'wait_for': {
          const outcome = await lab.waitFor(event.condition, { timeoutMs: event.timeoutMs, param: event.param ?? null, baseline });
          assertions.push({ condition: event.condition, param: event.param, pass: outcome.pass, detail: outcome.detail, kind: 'wait_for', required: true });
          if (outcome.current) baseline = outcome.current;
          break;
        }
        case 'assert': {
          const negate = event.negate === true;
          // scope 'scenarioStart' measures counter deltas across the whole
          // scenario (fresh lab => counters start at zero) — for facts whose
          // increment co-occurs with an earlier awaited event.
          const assertBaseline = event.scope === 'scenarioStart' ? scenarioStartSnapshot : baseline;
          let outcome;
          if (event.timeoutMs && !negate) {
            outcome = await lab.waitFor(event.condition, { timeoutMs: event.timeoutMs, param: event.param ?? null, baseline: assertBaseline });
          } else {
            if (event.timeoutMs && negate) await new Promise((resolve) => setTimeout(resolve, event.timeoutMs));
            const current = await lab.snapshot();
            outcome = evaluateCondition(event.condition, { current, baseline: assertBaseline, param: event.param ?? null });
          }
          const pass = negate ? !outcome.pass : outcome.pass;
          assertions.push({ condition: event.condition, param: event.param, negate, pass, detail: outcome.detail, message: event.message, required: event.required !== false });
          break;
        }
        case 'fault.trigger':
          await lab.triggerFault(event.fault, event.durationMs ?? null);
          break;
        case 'fault.clear':
          await lab.clearFault(event.fault);
          break;
        case 'ui.click':
          await lab.ui(event.control);
          break;
        case 'branch': {
          const outcome = await lab.waitFor(event.condition, { timeoutMs: event.timeoutMs ?? 8000, param: event.param ?? null, baseline });
          lab.record('branch', `${event.condition} -> ${outcome.pass ? 'then' : 'else'}`);
          await executeEvents(outcome.pass ? (event.then ?? []) : (event.else ?? []));
          break;
        }
        default:
          throw new Error(`Unhandled action ${event.action}`);
      }
    }
  }

  await executeEvents(scenario.events ?? []);

  const finalSnapshot = await lab.snapshot();
  const requiredFailed = assertions.filter((a) => a.required !== false && !a.pass);
  const passed = requiredFailed.length === 0;

  const usedAura = lab.groundTruth.some((g) => g.provider.startsWith('deepgram_aura'));
  const result = {
    scenarioId: scenario.scenarioId,
    version: scenario.version ?? 1,
    passed,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    seed: scenario.seed ?? null,
    environment: environmentName,
    visualTier: scenario.environment?.visualTier ?? getEnvironment(environmentName ?? '')?.visualTier ?? null,
    verificationLevel: usedAura ? 'closed_loop_simulation_verified' : 'virtual_microphone_verified',
    browser: `Chrome ${finalSnapshot?.app ? '' : ''}(headless)`.trim(),
    serverBaseUrl: lab.server.baseUrl,
    workspaceId: lab.server.workspaceId,
    components: {
      microphone: 'virtual (WebAudio MediaStreamTrack)',
      camera: 'virtual (canvas captureStream MediaStreamTrack)',
      speech_source: usedAura ? 'REAL Deepgram Aura synthesis' : lab.groundTruth.some((g) => g.provider === 'recorded_human_speech') ? 'recorded human speech' : 'deterministic synth signal',
      stt: 'REAL Deepgram nova-3 streaming (via server proxy)',
      agent: 'REAL Groq inference (via server proxy)',
      speech_gate: 'REAL deterministic gate',
      tts: 'REAL Deepgram Aura',
      playback: 'REAL browser HTMLAudioElement',
      detector: 'REAL COCO-SSD (when camera scenario)',
      storage: 'REAL SQLite (disposable, isolated tenant)',
    },
    assertions,
    transcript: finalSnapshot?.app?.segments ?? [],
    // Agent decision trail — what Roma decided per turn, including the
    // deterministic direct-address recheck. Essential for diagnosing a
    // scenario that failed because Roma stayed silent.
    agentEvents: finalSnapshot?.app?.agentEvents ?? [],
    addresseeDecisions: finalSnapshot?.app?.addresseeDecisions ?? [],
    groundTruth: lab.groundTruth,
    timeline: lab.timeline,
    consoleErrors: finalSnapshot?.sim?.consoleErrors ?? [],
    finalMetrics: finalSnapshot?.app?.deliveryMetrics ?? {},
    memoryCounts: finalSnapshot?.app?.memoryCounts ?? {},
    queue: finalSnapshot?.app?.memoryQueue ?? {},
    notes: [],
  };

  for (const assertion of assertions) {
    log(`    ${assertion.pass ? 'PASS' : 'FAIL'}  ${assertion.negate ? 'NOT ' : ''}${assertion.condition}${assertion.param ? ` (${assertion.param})` : ''} — ${assertion.detail}`);
  }
  return result;
}

/** Capture a failure screenshot into .simreports/. */
export async function captureFailureArtifacts(lab, scenarioId) {
  const dir = join(process.cwd(), '.simreports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${scenarioId}_failure_${randomBytes(3).toString('hex')}.png`);
  try { await lab.cdp.screenshot(path); return path; } catch { return null; }
}

export { writeReports };
