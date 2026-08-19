// Virtual-hardware lab — in-page entry point.
//
// ACTIVATION: this module is imported ONLY from main.jsx inside an
// `import.meta.env.DEV` guard (dead-code-eliminated from production builds;
// enforced by test/simulation-security.test.js's bundle scan), and it
// activates ONLY when the automation controller injected
// `window.__ROMA_SIMULATION__` before page load (CDP
// Page.addScriptToEvaluateOnNewDocument). There is no query-parameter,
// localStorage, or UI path to enable it — an ordinary dev session never
// simulates anything.
//
// The module owns the audio/video engines, the getUserMedia interposition,
// a visible simulation banner, the Roma playback tap (echo), a bounded
// console-error collector, and the `window.__romaSim` command surface the
// Node-side Scenario Director drives. It NEVER calls the agent runtime,
// Speech Gate, TTS, playback, Inspector stores, or repositories — it only
// produces media samples and reads bounded observability snapshots.

import { createAudioEngine } from './audioEngine.js';
import { createVideoEngine } from './videoEngine.js';
import { installVirtualDevices } from './devices.js';
import { getEnvironment } from './environments.js';

export function isSimulationRequested() {
  return typeof window !== 'undefined' && Boolean(window.__ROMA_SIMULATION__);
}

export function activateSimulation() {
  const config = window.__ROMA_SIMULATION__;
  if (!config) return null;

  const audioEngine = createAudioEngine({ sampleRate: config.sampleRate ?? 48000, seed: config.seed ?? 1 });
  const videoEngine = createVideoEngine({ width: config.cameraWidth ?? 1280, height: config.cameraHeight ?? 720, fps: config.cameraFps ?? 15 });
  const devices = installVirtualDevices({ audioEngine, videoEngine });

  // Visible simulation banner — always on while the lab drives the page.
  const banner = document.createElement('div');
  banner.textContent = '🔬 SIMULATED ENVIRONMENT — virtual microphone & camera active (development lab)';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7a2ea6;color:#fff;font:13px monospace;padding:4px 10px;text-align:center;pointer-events:none;';
  const attachBanner = () => document.body?.appendChild(banner);
  if (document.body) attachBanner(); else window.addEventListener('DOMContentLoaded', attachBanner);

  // Bounded console-error collector (assertion input for the oracle).
  const consoleErrors = [];
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    if (consoleErrors.length < 100) consoleErrors.push(String(args[0]).slice(0, 300));
    originalConsoleError(...args);
  };
  window.addEventListener('error', (event) => {
    if (consoleErrors.length < 100) consoleErrors.push(`window.onerror: ${String(event.message).slice(0, 300)}`);
  });

  // Roma playback tap: src/voice/playbackController.js's browserAudioFactory
  // calls this (DEV-only hook) with each REAL playback <audio> element. We
  // only observe/route audio — never create, authorize, or start playback.
  window.__romaSimulationPlaybackTap = (element) => {
    try { audioEngine.attachPlaybackElement(element); } catch { /* one capture per element */ }
  };

  // App-side observability bridge (main.jsx registers a bounded getState).
  let appState = () => ({});
  window.__romaSimAttach = (bridge) => { appState = bridge.getState; };

  function applyEnvironment(name) {
    const environment = getEnvironment(name);
    if (!environment) return { ok: false, error: `unknown environment ${name}` };
    audioEngine.applyRoomProfile(environment.acoustics);
    videoEngine.setBackground(environment.visual.background);
    videoEngine.setLighting(environment.visual.lighting);
    if (environment.visual.cameraDriftPxPerSecond) videoEngine.moveCamera({ driftPxPerSecond: environment.visual.cameraDriftPxPerSecond });
    return { ok: true, environment: name, visualTier: environment.visualTier };
  }

  const world = { people: new Map(), objects: new Map(), environment: null };

  // Playing <video> elements backing video_asset objects, kept so a scenario
  // can seek or stop one after it has been added.
  const videoObjects = new Map();

  // Command surface for the Node-side Scenario Director. Bounded verbs only —
  // audio/video state changes and reads. No verb reaches a Roma subsystem.
  window.__romaSim = {
    version: 1,

    applyEnvironment(name) { world.environment = name; return applyEnvironment(name); },

    addPerson(simulationId, { x = 0, distance = 1, visible = false, frameX = null, frameY = null, size = 260 } = {}) {
      world.people.set(simulationId, { x, distance, visible });
      audioEngine.positionPerson(simulationId, { x, distance });
      if (visible) videoEngine.setPerson(simulationId, { x: frameX ?? 640, y: frameY ?? 430, size, visible: true });
      return { ok: true };
    },
    movePerson(simulationId, { x, distance, visible, frameX, frameY, walking } = {}) {
      audioEngine.positionPerson(simulationId, { x, distance });
      if (visible !== undefined || frameX !== undefined || frameY !== undefined || walking !== undefined) {
        videoEngine.setPerson(simulationId, { x: frameX, y: frameY, visible, walking });
      }
      return { ok: true };
    },
    removePerson(simulationId) {
      world.people.delete(simulationId);
      audioEngine.stopSpeaking(simulationId);
      videoEngine.removePerson(simulationId);
      return { ok: true };
    },

    /** Play REAL synthesized/recorded speech (base64 WAV, resolved Node-side) through a person's spatial chain. */
    async speak(simulationId, wavBase64, { gainDb = 0, rate = 1 } = {}) {
      const binary = atob(wavBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const handle = await audioEngine.speak(simulationId, bytes.buffer, { gainDb, rate });
      return { ok: true, playbackId: handle.playbackId, durationMs: Math.round(handle.durationMs) };
    },
    stopSpeaking(simulationId) { audioEngine.stopSpeaking(simulationId ?? null); return { ok: true }; },

    addObject(id, options) { world.objects.set(id, options); videoEngine.addObject(id, options); return { ok: true }; },

    /**
     * Play a real video file into the room, so the camera sees MOTION —
     * head turns, motion blur, scene cuts, people entering and leaving. A
     * still image cannot exercise any of that, and those are exactly the
     * conditions perception gets wrong.
     *
     * `loopStart`/`loopEnd` hold one segment of the clip, which is how a
     * scenario keeps a chosen person on screen for longer than the cut lasts.
     * Muted, because this is a video source, not an audio one — room audio
     * belongs to the audio engine.
     */
    async showVideo(id, { src, x = 0, y = 0, width = 1280, startAt = 0, loopStart = null, loopEnd = null, z = 100000 } = {}) {
      const video = document.createElement('video');
      video.src = src;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error(`could not load ${src}`));
      });
      if (startAt) video.currentTime = startAt;
      if (loopStart != null && loopEnd != null) {
        video.addEventListener('timeupdate', () => {
          if (video.currentTime >= loopEnd || video.currentTime < loopStart) video.currentTime = loopStart;
        });
      }
      await video.play();
      videoObjects.set(id, video);
      world.objects.set(id, { kind: 'video_asset', src, x, y, width });
      videoEngine.addObject(id, { kind: 'video_asset', x, y, width, asset: video, z });
      return { ok: true, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    },

    /** Jump a playing clip to a timestamp (and optionally re-aim its held segment). */
    seekVideo(id, { to, loopStart = null, loopEnd = null } = {}) {
      const video = videoObjects.get(id);
      if (!video) return { ok: false, error: `no video ${id}` };
      if (loopStart != null && loopEnd != null) {
        video.onseeked = null;
        video.addEventListener('timeupdate', () => {
          if (video.currentTime >= loopEnd || video.currentTime < loopStart) video.currentTime = loopStart;
        });
      }
      if (typeof to === 'number') video.currentTime = to;
      return { ok: true, currentTime: video.currentTime };
    },

    removeVideo(id) {
      const video = videoObjects.get(id);
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); videoObjects.delete(id); }
      world.objects.delete(id);
      videoEngine.removeObject(id);
      return { ok: true };
    },

    moveObject(id, options) { videoEngine.moveObject(id, options); return { ok: true }; },
    removeObject(id) { world.objects.delete(id); videoEngine.removeObject(id); return { ok: true }; },
    setLighting(level) { videoEngine.setLighting(level); return { ok: true }; },
    moveCamera(options) { videoEngine.moveCamera(options); return { ok: true }; },
    configureEcho(options) { audioEngine.configureEcho(options); return { ok: true, echo: audioEngine.echoState() }; },
    setMicGain(gain) { audioEngine.setMicGain(gain); return { ok: true }; },
    audioDropout(durationMs) { audioEngine.dropout(durationMs); return { ok: true }; },
    freezeCamera() { videoEngine.freeze(); return { ok: true }; },
    unfreezeCamera() { videoEngine.unfreeze(); return { ok: true }; },
    endAudioTrack() { audioEngine.endTrack(); return { ok: true }; },
    endVideoTrack() { videoEngine.endTrack(); return { ok: true }; },

    /**
     * The exact pixels the virtual camera is producing, as a PNG data URL.
     * Read-only, and the only way to see what Roma's camera actually saw —
     * the render canvas is offscreen and never enters the DOM.
     */
    frameDataUrl() { return videoEngine.canvas.toDataURL('image/png'); },

    /** Bounded observability snapshot: engine facts + the app bridge's state. Read-only. */
    snapshot() {
      let app = {};
      try { app = appState() ?? {}; } catch (error) { app = { bridgeError: String(error?.message ?? error) }; }
      return {
        at: Date.now(),
        sim: {
          environment: world.environment,
          audioLevel: audioEngine.level(),
          speakingCount: audioEngine.speakingCount(),
          echo: audioEngine.echoState(),
          frameTick: videoEngine.tick(),
          frameSignature: videoEngine.frameSignature(),
          issuedDevices: devices.issuedCounts(),
          consoleErrors: consoleErrors.slice(-20),
          consoleErrorCount: consoleErrors.length,
        },
        app,
      };
    },
  };

  return { audioEngine, videoEngine, devices };
}
