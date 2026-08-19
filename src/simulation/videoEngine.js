// Virtual-room video engine — a continuously rendered canvas whose
// captureStream() is a REAL video MediaStreamTrack. Roma's unchanged camera
// source (src/inspector/video.js) consumes it exactly like a physical webcam:
// <video> element → frame canvas → real COCO-SSD inference. Nothing here
// writes detections or scene state — only pixels.
//
// Tiers:
//   deterministic_geometric  — filled shapes/objects with exact ground truth
//   recognition_compatible   — adds detector-friendly drawn assets (stop sign,
//                              clock, sports ball, tv…) and layered humanoid
//                              figures; real COCO-SSD decides what it sees
//   recorded_photorealistic  — a provided ImageBitmap/photo asset drawn into
//                              the room (asset slot; provenance documented by
//                              the scenario)

const BACKGROUNDS = {
  office: { wall: '#b8b2a6', floor: '#8a7f6d', accent: '#6d7f8a' },
  living: { wall: '#a68f86', floor: '#7d6a5c', accent: '#867ba6' },
  workshop: { wall: '#8f9399', floor: '#5f6266', accent: '#99928f' },
  bare: { wall: '#cccccc', floor: '#999999', accent: '#aaaaaa' },
};

function drawStopSign(g, x, y, size) {
  const r = size / 2;
  g.save();
  g.translate(x, y);
  g.fillStyle = '#b32025';
  g.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI / 8) + (i * Math.PI) / 4;
    const px = r * Math.cos(angle);
    const py = r * Math.sin(angle);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = Math.max(2, size * 0.04);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = `bold ${Math.round(size * 0.28)}px Arial`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('STOP', 0, 0);
  g.restore();
}

function drawClock(g, x, y, size) {
  const r = size / 2;
  g.save();
  g.translate(x, y);
  g.fillStyle = '#f5f0e6';
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#333'; g.lineWidth = Math.max(2, size * 0.05); g.stroke();
  g.fillStyle = '#333';
  for (let i = 0; i < 12; i += 1) {
    const a = (i * Math.PI) / 6;
    g.fillRect(Math.cos(a) * r * 0.82 - 1, Math.sin(a) * r * 0.82 - 1, 3, 3);
  }
  g.strokeStyle = '#222'; g.lineWidth = Math.max(2, size * 0.04);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(r * 0.45, -r * 0.2); g.stroke();
  g.beginPath(); g.moveTo(0, 0); g.lineTo(-r * 0.1, -r * 0.62); g.stroke();
  g.restore();
}

function drawSportsBall(g, x, y, size) {
  const r = size / 2;
  g.save();
  g.translate(x, y);
  const grad = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  grad.addColorStop(0, '#ff9d3f'); grad.addColorStop(1, '#c9601a');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#7a3a10'; g.lineWidth = Math.max(1.5, size * 0.03);
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(-r, 0); g.quadraticCurveTo(0, r * 0.35, r, 0); g.stroke();
  g.beginPath(); g.moveTo(0, -r); g.quadraticCurveTo(r * 0.35, 0, 0, r); g.stroke();
  g.restore();
}

function drawCup(g, x, y, size) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#e8e4da';
  g.fillRect(-size * 0.28, -size * 0.4, size * 0.56, size * 0.8);
  g.strokeStyle = '#b9b2a4'; g.lineWidth = 2;
  g.strokeRect(-size * 0.28, -size * 0.4, size * 0.56, size * 0.8);
  g.beginPath(); g.arc(size * 0.38, 0, size * 0.2, -Math.PI / 2, Math.PI / 2); g.stroke();
  g.restore();
}

function drawChair(g, x, y, size) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#6d4c33';
  g.fillRect(-size * 0.35, -size * 0.7, size * 0.12, size * 1.1); // back post
  g.fillRect(-size * 0.35, -size * 0.7, size * 0.7, size * 0.14); // back rest
  g.fillRect(-size * 0.35, 0, size * 0.7, size * 0.12);            // seat
  g.fillRect(-size * 0.33, 0.1 * size, size * 0.1, size * 0.5);   // legs
  g.fillRect(size * 0.24, 0.1 * size, size * 0.1, size * 0.5);
  g.restore();
}

function drawBook(g, x, y, size) {
  g.save(); g.translate(x, y);
  g.fillStyle = '#3e5f8a'; g.fillRect(-size * 0.45, -size * 0.3, size * 0.9, size * 0.6);
  g.fillStyle = '#f4f1e8'; g.fillRect(-size * 0.4, -size * 0.24, size * 0.8, size * 0.48);
  g.strokeStyle = '#3e5f8a'; g.beginPath(); g.moveTo(0, -size * 0.24); g.lineTo(0, size * 0.24); g.stroke();
  g.restore();
}

function drawLaptop(g, x, y, size) {
  g.save(); g.translate(x, y);
  g.fillStyle = '#444a52'; g.fillRect(-size * 0.5, -size * 0.4, size, size * 0.55);
  g.fillStyle = '#7fb3e8'; g.fillRect(-size * 0.45, -size * 0.36, size * 0.9, size * 0.45);
  g.fillStyle = '#565d66'; g.fillRect(-size * 0.55, size * 0.17, size * 1.1, size * 0.12);
  g.restore();
}

function drawBottle(g, x, y, size) {
  g.save(); g.translate(x, y);
  g.fillStyle = '#3f7f5f';
  g.fillRect(-size * 0.12, -size * 0.55, size * 0.24, size * 0.25);
  g.fillRect(-size * 0.2, -size * 0.32, size * 0.4, size * 0.85);
  g.restore();
}

function drawTv(g, x, y, size, tick) {
  g.save(); g.translate(x, y);
  g.fillStyle = '#1a1a1a'; g.fillRect(-size * 0.6, -size * 0.4, size * 1.2, size * 0.8);
  const flicker = 0.5 + 0.3 * Math.sin(tick / 7);
  g.fillStyle = `rgba(120,160,220,${flicker})`;
  g.fillRect(-size * 0.55, -size * 0.35, size * 1.1, size * 0.7);
  g.restore();
}

function drawPersonFigure(g, x, y, size, tick, walking) {
  g.save();
  g.translate(x, y);
  const sway = walking ? Math.sin(tick / 5) * size * 0.05 : 0;
  // torso
  const torso = g.createLinearGradient(0, -size * 0.55, 0, size * 0.2);
  torso.addColorStop(0, '#5a6f8f'); torso.addColorStop(1, '#3d4c63');
  g.fillStyle = torso;
  g.beginPath();
  g.ellipse(0, -size * 0.18, size * 0.22, size * 0.38, 0, 0, Math.PI * 2);
  g.fill();
  // head
  const skin = g.createRadialGradient(-size * 0.03, -size * 0.68, size * 0.02, 0, -size * 0.65, size * 0.16);
  skin.addColorStop(0, '#e8c39e'); skin.addColorStop(1, '#c79b74');
  g.fillStyle = skin;
  g.beginPath(); g.arc(0, -size * 0.65, size * 0.14, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4a3b2a';
  g.beginPath(); g.arc(0, -size * 0.72, size * 0.13, Math.PI, Math.PI * 2); g.fill();
  // arms
  g.strokeStyle = '#3d4c63'; g.lineWidth = size * 0.09; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-size * 0.2, -size * 0.35); g.lineTo(-size * 0.3 + sway, size * 0.05); g.stroke();
  g.beginPath(); g.moveTo(size * 0.2, -size * 0.35); g.lineTo(size * 0.3 - sway, size * 0.05); g.stroke();
  // legs
  g.strokeStyle = '#2d3442'; g.lineWidth = size * 0.11;
  g.beginPath(); g.moveTo(-size * 0.09, size * 0.16); g.lineTo(-size * 0.12 - sway, size * 0.62); g.stroke();
  g.beginPath(); g.moveTo(size * 0.09, size * 0.16); g.lineTo(size * 0.12 + sway, size * 0.62); g.stroke();
  g.restore();
}

const OBJECT_PAINTERS = {
  'stop sign': drawStopSign,
  clock: drawClock,
  'sports ball': drawSportsBall,
  cup: drawCup,
  chair: drawChair,
  book: drawBook,
  laptop: drawLaptop,
  bottle: drawBottle,
  tv: (g, x, y, size, tick) => drawTv(g, x, y, size, tick),
};

export function createVideoEngine({ width = 1280, height = 720, fps = 15 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');

  const state = {
    background: 'office',
    lighting: 0.9,
    camera: { panX: 0, panY: 0, zoom: 1, driftPxPerSecond: 0 },
    objects: new Map(), // id -> { kind, x, y, width, asset }
    people: new Map(),  // simulationId -> { x, y, size, visible, walking }
    frozen: false,
    tick: 0,
  };

  function drawScene() {
    const palette = BACKGROUNDS[state.background] ?? BACKGROUNDS.bare;
    const cam = state.camera;
    const drift = cam.driftPxPerSecond ? (state.tick / fps) * cam.driftPxPerSecond : 0;
    g.save();
    g.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.panX - drift, -cam.panY);
    g.fillStyle = palette.wall;
    g.fillRect(-width, -height, width * 3, height * 3);
    g.fillStyle = palette.floor;
    g.fillRect(-width, height * 0.72, width * 3, height * 1.5);
    g.fillStyle = palette.accent;
    g.fillRect(width * 0.05, height * 0.1, width * 0.22, height * 0.34); // window/panel
    // draw order = z order (later = closer = occludes)
    const drawables = [];
    for (const [id, object] of state.objects) drawables.push({ z: object.z ?? object.y, kind: 'object', id, item: object });
    for (const [id, person] of state.people) if (person.visible) drawables.push({ z: person.y, kind: 'person', id, item: person });
    drawables.sort((a, b) => a.z - b.z);
    for (const entry of drawables) {
      if (entry.kind === 'person') {
        drawPersonFigure(g, entry.item.x, entry.item.y, entry.item.size ?? 260, state.tick, entry.item.walking);
      } else {
        const painter = OBJECT_PAINTERS[entry.item.kind];
        if (painter) painter(g, entry.item.x, entry.item.y, entry.item.width ?? 120, state.tick);
        else if (entry.item.kind === 'photo_asset' && entry.item.asset) {
          g.drawImage(entry.item.asset, entry.item.x, entry.item.y, entry.item.width ?? 320, (entry.item.width ?? 320) * (entry.item.asset.height / entry.item.asset.width));
        }
      }
    }
    g.restore();
    // Lighting is a REAL pixel transform: darken everything by (1 - level).
    g.fillStyle = `rgba(0,0,10,${Math.max(0, Math.min(1, 1 - state.lighting))})`;
    g.fillRect(0, 0, width, height);
    // Simulation watermark — visible in every frame Roma sees.
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '16px monospace';
    g.fillText('SIMULATED ENVIRONMENT', 12, height - 14);
  }

  const interval = setInterval(() => {
    if (state.frozen) return;
    state.tick += 1;
    drawScene();
  }, Math.round(1000 / fps));
  drawScene();

  const stream = canvas.captureStream(fps);

  /** Cheap deterministic frame signature so tests can prove pixels actually changed. */
  function frameSignature() {
    const sample = g.getImageData(0, 0, width, height).data;
    let hash = 2166136261;
    for (let i = 0; i < sample.length; i += 977) {
      hash ^= sample[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  return {
    canvas,
    stream,
    setBackground: (name) => { state.background = name; },
    setLighting: (level) => { state.lighting = Math.max(0, Math.min(1, level)); },
    moveCamera: ({ panX, panY, zoom, driftPxPerSecond } = {}) => {
      if (typeof panX === 'number') state.camera.panX = panX;
      if (typeof panY === 'number') state.camera.panY = panY;
      if (typeof zoom === 'number') state.camera.zoom = zoom;
      if (typeof driftPxPerSecond === 'number') state.camera.driftPxPerSecond = driftPxPerSecond;
    },
    // `z` overrides the default depth (the object's own y) for the rare case
    // where a drawable must sit in front of a figure it overlaps — a photo
    // asset held at head height, for instance.
    addObject: (id, { kind, x = width / 2, y = height / 2, width: objectWidth = 140, asset = null, z = null }) => {
      state.objects.set(id, { kind, x, y, width: objectWidth, asset, z });
    },
    moveObject: (id, { x, y }) => {
      const object = state.objects.get(id);
      if (!object) return;
      if (typeof x === 'number') object.x = x;
      if (typeof y === 'number') object.y = y;
    },
    removeObject: (id) => state.objects.delete(id),
    setPerson: (simulationId, { x, y, size, visible, walking }) => {
      const current = state.people.get(simulationId) ?? { x: width / 2, y: height * 0.55, size: 260, visible: true, walking: false };
      state.people.set(simulationId, {
        x: typeof x === 'number' ? x : current.x,
        y: typeof y === 'number' ? y : current.y,
        size: typeof size === 'number' ? size : current.size,
        visible: typeof visible === 'boolean' ? visible : current.visible,
        walking: typeof walking === 'boolean' ? walking : current.walking,
      });
    },
    removePerson: (simulationId) => state.people.delete(simulationId),
    freeze: () => { state.frozen = true; },
    unfreeze: () => { state.frozen = false; },
    endTrack: () => stream.getVideoTracks().forEach((track) => track.stop()),
    frameSignature,
    tick: () => state.tick,
    dispose: () => clearInterval(interval),
  };
}
