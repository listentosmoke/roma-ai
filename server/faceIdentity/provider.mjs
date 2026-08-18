// Local face encoder — the face counterpart to server/voiceIdentity/provider.mjs.
//
// Images never leave this machine. Detection and embedding both run in-process
// through onnxruntime-node (already present as a dependency of
// @huggingface/transformers), with sharp for pixel work.
//
// MODEL: the InsightFace "buffalo_l" pack — SCRFD-10G for detection, ArcFace
// w600k_r50 for the 512-d embedding — pinned by revision and verified by
// SHA-256 before it is ever loaded.
//
// LICENSING: InsightFace models are published for NON-COMMERCIAL research use.
// That suits a personal, local assistant and rules out shipping this
// commercially. Everything here is configurable by environment variable so a
// differently-licensed encoder can take its place without touching callers.
//
// WHAT THIS IS NOT: a similarity score is evidence, never authentication, and
// there is no liveness detection — a printed photograph may well match. See
// PLAN-FACE-IDENTITY.md "Honest limits".

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Pinned so an upstream re-upload cannot silently change what we execute.
const REPO = 'immich-app/buffalo_l';
const REVISION = process.env.FACE_IDENTITY_MODEL_REVISION ?? 'd09715916a0778919a770c343533641e250b8699';
const ASSETS = {
  detection: {
    file: 'detection/model.onnx',
    sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
    bytes: 16923827,
  },
  recognition: {
    file: 'recognition/model.onnx',
    sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
    bytes: 174383860,
  },
};

const DETECT_SIZE = 640;   // SCRFD input, measured
const EMBED_SIZE = 112;    // ArcFace input, measured
const EMBED_DIMS = 512;    // ArcFace output, measured
const STRIDES = [8, 16, 32];
const ANCHORS_PER_CELL = 2;

// The reference 5-point template ArcFace was trained against, at 112x112.
// Aligning to it is what makes embeddings comparable between images.
const REFERENCE_LANDMARKS = [
  [38.2946, 51.6963], // left eye
  [73.5318, 51.5014], // right eye
  [56.0252, 71.7366], // nose
  [41.5493, 92.3655], // left mouth corner
  [70.7299, 92.2041], // right mouth corner
];

function modelDir() {
  return process.env.FACE_IDENTITY_MODEL_DIR ?? path.join(process.cwd(), '.models', 'face');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

/**
 * Fetch a pinned model asset once and verify it. A file whose digest does not
 * match is deleted rather than loaded — a corrupted or substituted model is a
 * hard failure, never something we run anyway and hope for the best.
 */
async function ensureAsset(name, { allowDownload }) {
  const asset = ASSETS[name];
  const target = path.join(modelDir(), `${name}.onnx`);

  if (fs.existsSync(target)) {
    const digest = await sha256File(target);
    if (digest === asset.sha256) return target;
    await fsp.rm(target, { force: true });
    if (!allowDownload) throw new Error(`face model "${name}" failed its integrity check and re-download is disabled`);
  }
  if (!allowDownload) throw new Error(`face model "${name}" is not downloaded (set FACE_IDENTITY_ALLOW_DOWNLOAD=1 for the one run that fetches it)`);

  await fsp.mkdir(modelDir(), { recursive: true });
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${asset.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`face model "${name}": HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== asset.sha256) throw new Error(`face model "${name}": SHA-256 mismatch (expected ${asset.sha256}, got ${digest})`);
  await fsp.writeFile(target, buffer);
  return target;
}

/**
 * Classify SCRFD's outputs by SHAPE rather than by name. The exported names are
 * numeric ("448", "471", …) and change between re-exports; the shapes do not:
 * [N,1] is a score, [N,4] a box, [N,10] five landmarks, and N identifies the
 * stride. Measured against the pinned revision.
 */
function groupDetectionOutputs(results) {
  const byStride = new Map(STRIDES.map((stride) => [stride, {}]));
  for (const tensor of Object.values(results)) {
    const [rows, cols] = tensor.dims;
    const cells = rows / ANCHORS_PER_CELL;
    const stride = STRIDES.find((s) => cells === (DETECT_SIZE / s) ** 2);
    if (!stride) continue;
    const slot = byStride.get(stride);
    if (cols === 1) slot.scores = tensor;
    else if (cols === 4) slot.boxes = tensor;
    else if (cols === 10) slot.landmarks = tensor;
  }
  return byStride;
}

function intersectionOverUnion(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return overlap / (areaA + areaB - overlap || 1);
}

function nonMaximumSuppression(faces, threshold = 0.4) {
  const kept = [];
  for (const face of [...faces].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => intersectionOverUnion(face, k) < threshold)) kept.push(face);
  }
  return kept;
}

/** Least-squares similarity transform (scale + rotation + translation). */
function similarityTransform(from, to) {
  const n = from.length;
  const mean = (points, index) => points.reduce((sum, p) => sum + p[index], 0) / n;
  const [fx, fy, tx, ty] = [mean(from, 0), mean(from, 1), mean(to, 0), mean(to, 1)];
  let a = 0;
  let b = 0;
  let norm = 0;
  for (let i = 0; i < n; i += 1) {
    const [dfx, dfy] = [from[i][0] - fx, from[i][1] - fy];
    const [dtx, dty] = [to[i][0] - tx, to[i][1] - ty];
    a += dfx * dtx + dfy * dty;
    b += dfx * dty - dfy * dtx;
    norm += dfx * dfx + dfy * dfy;
  }
  const scale = Math.hypot(a, b) / (norm || 1);
  const angle = Math.atan2(b, a);
  const [cos, sin] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
  return {
    // maps a source point to the aligned frame
    apply: ([x, y]) => [cos * (x - fx) - sin * (y - fy) + tx, sin * (x - fx) + cos * (y - fy) + ty],
    inverse: ([x, y]) => {
      const d = cos * cos + sin * sin || 1;
      const [px, py] = [x - tx, y - ty];
      return [(cos * px + sin * py) / d + fx, (-sin * px + cos * py) / d + fy];
    },
  };
}

export function createFaceProvider({
  allowDownload = process.env.FACE_IDENTITY_ALLOW_DOWNLOAD === '1',
  detectionThreshold = Number(process.env.FACE_IDENTITY_DETECTION_THRESHOLD ?? 0.5),
} = {}) {
  let sessions = null;
  let loadError = null;

  async function load() {
    if (sessions) return sessions;
    if (loadError) throw loadError;
    try {
      const [{ default: ort }, { default: sharp }] = await Promise.all([
        import('onnxruntime-node'),
        import('sharp'),
      ]);
      const [detectionPath, recognitionPath] = await Promise.all([
        ensureAsset('detection', { allowDownload }),
        ensureAsset('recognition', { allowDownload }),
      ]);
      const [detection, recognition] = await Promise.all([
        ort.InferenceSession.create(detectionPath),
        ort.InferenceSession.create(recognitionPath),
      ]);
      sessions = { ort, sharp, detection, recognition };
      return sessions;
    } catch (error) {
      loadError = error;
      throw error;
    }
  }

  /** Decode SCRFD outputs into face boxes + 5 landmarks in source-image pixels. */
  function decode(results, scale) {
    const grouped = groupDetectionOutputs(results);
    const faces = [];
    for (const stride of STRIDES) {
      const { scores, boxes, landmarks } = grouped.get(stride) ?? {};
      if (!scores || !boxes || !landmarks) continue;
      const side = DETECT_SIZE / stride;
      for (let index = 0; index < scores.dims[0]; index += 1) {
        const score = scores.data[index];
        if (score < detectionThreshold) continue;
        const cell = Math.floor(index / ANCHORS_PER_CELL);
        const cx = (cell % side) * stride;
        const cy = Math.floor(cell / side) * stride;
        const b = index * 4;
        const face = {
          score,
          x1: (cx - boxes.data[b] * stride) / scale,
          y1: (cy - boxes.data[b + 1] * stride) / scale,
          x2: (cx + boxes.data[b + 2] * stride) / scale,
          y2: (cy + boxes.data[b + 3] * stride) / scale,
          landmarks: [],
        };
        const l = index * 10;
        for (let point = 0; point < 5; point += 1) {
          face.landmarks.push([
            (cx + landmarks.data[l + point * 2] * stride) / scale,
            (cy + landmarks.data[l + point * 2 + 1] * stride) / scale,
          ]);
        }
        faces.push(face);
      }
    }
    return nonMaximumSuppression(faces);
  }

  return {
    name: 'local_insightface',
    describe: () => ({
      provider: 'local_insightface',
      repo: REPO,
      revision: REVISION,
      dims: EMBED_DIMS,
      license: 'non-commercial research use (InsightFace)',
      liveness: false,
    }),
    available: () => Boolean(sessions) || !loadError,

    /** @returns {Promise<Array<{score,x1,y1,x2,y2,landmarks}>>} */
    async detect(imageBuffer) {
      const { ort, sharp, detection } = await load();
      const image = sharp(imageBuffer).rotate();
      const meta = await image.metadata();
      const scale = Math.min(DETECT_SIZE / meta.width, DETECT_SIZE / meta.height);
      const resized = await image
        .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { fit: 'fill' })
        .extend({
          top: 0,
          left: 0,
          bottom: DETECT_SIZE - Math.round(meta.height * scale),
          right: DETECT_SIZE - Math.round(meta.width * scale),
          background: { r: 0, g: 0, b: 0 },
        })
        .removeAlpha()
        .raw()
        .toBuffer();

      // SCRFD expects (pixel - 127.5) / 128.0 in CHW order.
      const input = new Float32Array(3 * DETECT_SIZE * DETECT_SIZE);
      const plane = DETECT_SIZE * DETECT_SIZE;
      for (let i = 0; i < plane; i += 1) {
        input[i] = (resized[i * 3] - 127.5) / 128.0;
        input[plane + i] = (resized[i * 3 + 1] - 127.5) / 128.0;
        input[2 * plane + i] = (resized[i * 3 + 2] - 127.5) / 128.0;
      }
      const results = await detection.run({
        [detection.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DETECT_SIZE, DETECT_SIZE]),
      });
      return decode(results, scale);
    },

    /**
     * Embed one detected face. Returns an L2-normalized 512-d vector, so
     * cosine similarity is a plain dot product.
     */
    async embed(imageBuffer, face) {
      const { ort, sharp, recognition } = await load();
      const transform = similarityTransform(face.landmarks, REFERENCE_LANDMARKS);

      // Resolve the aligned crop by sampling the source through the inverse
      // transform — nearest neighbour, which is enough at this scale and keeps
      // the implementation dependency-free.
      const meta = await sharp(imageBuffer).metadata();
      const source = await sharp(imageBuffer).removeAlpha().raw().toBuffer();
      // Bilinear, matching cv2.warpAffine's default in the reference
      // implementation. Nearest-neighbour visibly degrades the embedding:
      // aliasing at this scale moves eyes and mouth by a pixel or more, which
      // is exactly the signal ArcFace is reading.
      const aligned = Buffer.alloc(EMBED_SIZE * EMBED_SIZE * 3);
      const sample = (px, py, channel) => {
        const x = Math.min(meta.width - 1, Math.max(0, px));
        const y = Math.min(meta.height - 1, Math.max(0, py));
        return source[(y * meta.width + x) * 3 + channel];
      };
      for (let y = 0; y < EMBED_SIZE; y += 1) {
        for (let x = 0; x < EMBED_SIZE; x += 1) {
          const [sx, sy] = transform.inverse([x, y]);
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const fx = sx - x0;
          const fy = sy - y0;
          const to = (y * EMBED_SIZE + x) * 3;
          for (let channel = 0; channel < 3; channel += 1) {
            const top = sample(x0, y0, channel) * (1 - fx) + sample(x0 + 1, y0, channel) * fx;
            const bottom = sample(x0, y0 + 1, channel) * (1 - fx) + sample(x0 + 1, y0 + 1, channel) * fx;
            aligned[to + channel] = Math.round(top * (1 - fy) + bottom * fy);
          }
        }
      }

      // ArcFace expects (pixel - 127.5) / 127.5 in CHW order.
      const input = new Float32Array(3 * EMBED_SIZE * EMBED_SIZE);
      const plane = EMBED_SIZE * EMBED_SIZE;
      for (let i = 0; i < plane; i += 1) {
        input[i] = (aligned[i * 3] - 127.5) / 127.5;
        input[plane + i] = (aligned[i * 3 + 1] - 127.5) / 127.5;
        input[2 * plane + i] = (aligned[i * 3 + 2] - 127.5) / 127.5;
      }
      const results = await recognition.run({
        [recognition.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, EMBED_SIZE, EMBED_SIZE]),
      });
      const raw = Object.values(results)[0].data;
      const norm = Math.hypot(...raw) || 1;
      return Float32Array.from(raw, (value) => value / norm);
    },
  };
}

/** Cosine similarity of two L2-normalized embeddings: -1..1. */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

export { REPO, REVISION, EMBED_DIMS, ASSETS };
