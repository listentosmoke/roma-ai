import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateVisionResult } from '../src/vision/schema.js';
import { computeTargetSize, expandCrop, estimateDataUrlBytes, prepareImage } from '../src/vision/prepare.js';
import { createGroqVisionProvider, createMockVisionProvider, VisionProviderError, buildVisionMessages } from '../src/vision/provider.js';
import { createVisionAnalyzer, normalizeQuestion, sceneContextFrom } from '../src/vision/analyzer.js';
import { createInspector } from '../src/inspector/inspector.js';
import { createMockDetector } from '../src/inspector/detector.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';
import { createScriptedSource } from '../src/inspector/video.js';

const validRaw = {
  answer: 'The adjustable wrench is in the lower-right compartment.',
  description: 'An open toolbox with several hand tools.',
  target: { label: 'adjustable wrench', found: true, confidence: 0.91, position: 'lower-right' },
  observations: [{ label: 'adjustable wrench', position: 'lower-right', confidence: 0.91 }],
  visibleText: [],
  uncertainty: null,
  requiresAnotherFrame: false,
};

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function groqBody(content) {
  return { choices: [{ message: { content } }], usage: { total_tokens: 99 } };
}

// ── schema ────────────────────────────────────────────────────────────────────

test('vision schema accepts a valid result and clamps out-of-range confidences', () => {
  const { ok, result } = validateVisionResult({ ...validRaw, target: { ...validRaw.target, confidence: 7 } });
  assert.equal(ok, true);
  assert.equal(result.target.confidence, 1);
  assert.equal(result.answer, validRaw.answer);
});

test('vision schema rejects a missing answer and non-object garbage safely', () => {
  assert.equal(validateVisionResult({ ...validRaw, answer: '' }).ok, false);
  assert.equal(validateVisionResult(null).ok, false);
  assert.equal(validateVisionResult('text').ok, false);
  assert.doesNotThrow(() => validateVisionResult(undefined));
});

// ── image preparation ─────────────────────────────────────────────────────────

test('computeTargetSize downscales to the max dimension but never upscales', () => {
  assert.deepEqual(computeTargetSize(1600, 1200, 800), { width: 800, height: 600, scale: 0.5 });
  assert.deepEqual(computeTargetSize(400, 300, 800), { width: 400, height: 300, scale: 1 });
});

test('expandCrop pads a normalized box and clamps to the frame', () => {
  const crop = expandCrop({ x: 0.05, y: 0.7, width: 0.2, height: 0.25 }, 0.15);
  assert.equal(crop.x, 0);
  assert.ok(crop.y > 0.5 && crop.y < 0.6);
  assert.ok(crop.y + crop.height <= 1);
});

test('prepareImage passes a stored dataUrl through untouched when no canvas exists (Node)', async () => {
  const frame = Object.freeze({ dataUrl: 'data:image/jpeg;base64,aGVsbG8gd29ybGQ=' });
  const prepared = await prepareImage(frame, { createCanvas: () => null, loadImage: async () => null });
  assert.equal(prepared.dataUrl, frame.dataUrl);
  assert.equal(prepared.bytes, estimateDataUrlBytes(frame.dataUrl));
  assert.equal(prepared.resized, false);
});

test('prepareImage resizes oversized frames via canvas without mutating the original', async () => {
  const drawCalls = [];
  const fakeCanvas = (width, height) => ({
    width, height,
    getContext: () => ({ drawImage: (...args) => drawCalls.push(args) }),
    toDataURL: (type, quality) => `data:image/jpeg;base64,${'A'.repeat(400)}|q=${quality}`,
  });
  const source = Object.freeze({ canvas: Object.freeze({ width: 1920, height: 1080 }) });
  const prepared = await prepareImage(source, { maxDimension: 768, quality: 0.7, createCanvas: fakeCanvas });

  assert.equal(prepared.width, 768);
  assert.equal(prepared.height, 432);
  assert.equal(prepared.resized, true);
  assert.ok(prepared.bytes > 0);
  assert.match(prepared.dataUrl, /q=0\.7/);
  assert.equal(drawCalls.length, 1);
  assert.equal(drawCalls[0][0], source.canvas, 'draws FROM the original, never into it');
});

test('prepareImage crops around a bounding box with padding when one is provided', async () => {
  const drawCalls = [];
  const fakeCanvas = (width, height) => ({
    width, height,
    getContext: () => ({ drawImage: (...args) => drawCalls.push(args) }),
    toDataURL: () => 'data:image/jpeg;base64,AAAA',
  });
  const source = { canvas: { width: 1000, height: 1000 } };
  const prepared = await prepareImage(source, { crop: { x: 0.7, y: 0.7, width: 0.2, height: 0.2 }, cropPadding: 0.1, createCanvas: fakeCanvas });
  assert.equal(prepared.cropped, true);
  const [, sx, sy, sw, sh] = drawCalls[0];
  assert.equal(sx, 600);
  assert.equal(sy, 600);
  assert.equal(sw, 400);
  assert.equal(sh, 400);
});

test('prepareImage fails clearly when the frame has no image data', async () => {
  await assert.rejects(() => prepareImage({ detections: [] }, { createCanvas: () => null, loadImage: async () => null }), /no image data/);
});

// ── Groq vision provider ──────────────────────────────────────────────────────

const image = 'data:image/jpeg;base64,AAAA';

test('groq vision provider constructs a valid multimodal request and validates the response', async () => {
  let captured;
  const provider = createGroqVisionProvider({
    apiKey: 'sk-test',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    fetchImpl: async (url, init) => { captured = { url, body: JSON.parse(init.body), headers: init.headers }; return jsonResponse(groqBody(JSON.stringify(validRaw))); },
  });
  const outcome = await provider.analyze({ image, question: 'Which tool is the adjustable wrench?', sceneContext: '- wrench-like object, lower-right, confidence 0.74', capturedAt: 1000, requestedAt: 1500 });

  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.body.model, 'meta-llama/llama-4-scout-17b-16e-instruct');
  assert.equal(captured.body.response_format.type, 'json_object');
  const userContent = captured.body.messages[1].content;
  assert.equal(userContent[0].type, 'text');
  assert.match(userContent[0].text, /Which tool is the adjustable wrench\?/);
  assert.match(userContent[0].text, /wrench-like object/);
  assert.match(userContent[0].text, /500 ms before/);
  assert.equal(userContent[1].type, 'image_url');
  assert.equal(userContent[1].image_url.url, image);
  assert.equal(outcome.result.target.label, 'adjustable wrench');
  assert.equal(outcome.usage.total_tokens, 99);
});

test('groq vision provider turns invalid JSON and schema failures into typed errors', async () => {
  const bad = createGroqVisionProvider({ apiKey: 'k', model: 'm', fetchImpl: async () => jsonResponse(groqBody('not json {')) });
  await assert.rejects(() => bad.analyze({ image, question: 'q' }), (e) => e.code === 'invalid_response');

  const invalid = createGroqVisionProvider({ apiKey: 'k', model: 'm', fetchImpl: async () => jsonResponse(groqBody(JSON.stringify({ nope: true }))) });
  await assert.rejects(() => invalid.analyze({ image, question: 'q' }), (e) => e.code === 'invalid_response' && /validation/.test(e.message));
});

test('groq vision provider times out and honors external AbortSignal', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const provider = createGroqVisionProvider({ apiKey: 'k', model: 'm', timeoutMs: 30, fetchImpl: hang });
  await assert.rejects(() => provider.analyze({ image, question: 'q' }), (e) => e.code === 'timeout');

  const controller = new AbortController();
  const slow = createGroqVisionProvider({ apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: hang });
  const pending = assert.rejects(() => slow.analyze({ image, question: 'q', signal: controller.signal }), (e) => e.code === 'timeout');
  controller.abort();
  await pending;
});

test('groq vision provider retries a transient failure once, but never auth errors', async () => {
  let transientCalls = 0;
  const transient = createGroqVisionProvider({
    apiKey: 'k', model: 'm',
    fetchImpl: async () => {
      transientCalls += 1;
      return transientCalls === 1 ? jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }) : jsonResponse(groqBody(JSON.stringify(validRaw)));
    },
  });
  const outcome = await transient.analyze({ image, question: 'q' });
  assert.equal(transientCalls, 2);
  assert.equal(outcome.result.target.found, true);

  let authCalls = 0;
  const auth = createGroqVisionProvider({
    apiKey: 'bad-key-value', model: 'm',
    fetchImpl: async () => { authCalls += 1; return jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 }); },
  });
  await assert.rejects(() => auth.analyze({ image, question: 'q' }), (e) => e.code === 'auth' && !e.message.includes('bad-key-value'));
  assert.equal(authCalls, 1, 'auth failures are not retried');
});

// ── analyzer: cache, coalescing, concurrency ─────────────────────────────────

function countingProvider() {
  let calls = 0;
  return {
    provider: createMockVisionProvider(async () => { calls += 1; return validRaw; }),
    calls: () => calls,
  };
}

const passthroughPrepare = async (frame) => ({ dataUrl: frame.dataUrl ?? image, width: 100, height: 100, bytes: 4, resized: false, cropped: false });

test('duplicate requests within the TTL reuse the cached result', async () => {
  const { provider, calls } = countingProvider();
  const analyzer = createVisionAnalyzer({ provider, prepare: passthroughPrepare, cacheTtlMs: 60000 });
  const first = await analyzer.analyze({ frame: { dataUrl: image }, frameAt: 5000, question: 'Where is the wrench?' });
  const second = await analyzer.analyze({ frame: { dataUrl: image }, frameAt: 5000, question: 'where is the WRENCH??' }); // normalizes equal
  assert.equal(calls(), 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.result.answer, first.result.answer);
});

test('cache entries expire after the TTL', async () => {
  const { provider, calls } = countingProvider();
  let fakeNow = 0;
  const analyzer = createVisionAnalyzer({ provider, prepare: passthroughPrepare, cacheTtlMs: 1000, now: () => fakeNow });
  await analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' });
  fakeNow = 5000;
  await analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' });
  assert.equal(calls(), 2);
});

test('identical concurrent requests share one in-flight promise', async () => {
  let calls = 0;
  let release;
  const provider = {
    model: 'm',
    analyze: () => new Promise((resolve) => { calls += 1; release = () => resolve({ result: validRaw, usage: null, latencyMs: 1, model: 'm' }); }),
  };
  const analyzer = createVisionAnalyzer({ provider, prepare: passthroughPrepare });
  const a = analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' });
  const b = analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra.result.answer, rb.result.answer);
  assert.equal(rb.cacheHit, true);
});

test('concurrency cap: no more than maxConcurrent remote analyses run simultaneously', async () => {
  let active = 0;
  let peak = 0;
  const provider = {
    model: 'm',
    analyze: async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { result: validRaw, usage: null, latencyMs: 20, model: 'm' };
    },
  };
  const analyzer = createVisionAnalyzer({ provider, prepare: passthroughPrepare, maxConcurrent: 1 });
  await Promise.all([
    analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'first question' }),
    analyzer.analyze({ frame: { dataUrl: image }, frameAt: 2, question: 'second question' }),
    analyzer.analyze({ frame: { dataUrl: image }, frameAt: 3, question: 'third question' }),
  ]);
  assert.equal(peak, 1);
});

test('failed analyses are not cached — the next identical request retries', async () => {
  let calls = 0;
  const provider = {
    model: 'm',
    analyze: async () => {
      calls += 1;
      if (calls === 1) throw new VisionProviderError('server', 'boom');
      return { result: validRaw, usage: null, latencyMs: 1, model: 'm' };
    },
  };
  const analyzer = createVisionAnalyzer({ provider, prepare: passthroughPrepare });
  await assert.rejects(() => analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' }));
  const outcome = await analyzer.analyze({ frame: { dataUrl: image }, frameAt: 1, question: 'q' });
  assert.equal(calls, 2);
  assert.equal(outcome.result.answer, validRaw.answer);
});

// ── integration bits ──────────────────────────────────────────────────────────

test('the continuous Inspector loop is not blocked by slow remote analysis', async () => {
  const store = createSceneStore();
  const slowDeepAnalyzer = {
    maybeAnalyze: () => new Promise((resolve) => setTimeout(() => resolve({ requested: false }), 500)),
  };
  const inspector = createInspector({
    source: createScriptedSource([{ detections: [{ label: 'screwdriver', confidence: 0.4, box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }]),
    detector: createMockDetector(),
    store,
    deepAnalyzer: slowDeepAnalyzer,
  });
  const started = Date.now();
  await inspector.tickOnce(Date.now());
  await inspector.tickOnce(Date.now());
  assert.ok(Date.now() - started < 250, 'two ticks complete while a 500ms deep analysis is still pending');
});

test('sceneContextFrom renders detector hints and normalizeQuestion is stable', () => {
  const context = sceneContextFrom({
    scene: { summary: 'Toolbox on a bench.' },
    objects: [{ label: 'wrench', position: 'lower-right', confidence: 0.74, visibility: 'visible' }],
  });
  assert.match(context, /Scene: Toolbox on a bench\./);
  assert.match(context, /- wrench, lower-right, confidence 0\.74/);
  assert.equal(normalizeQuestion('  Where IS the wrench?! '), 'where is the wrench');
});

test('buildVisionMessages labels detector output as hints that may be wrong', () => {
  const messages = buildVisionMessages({ image, question: 'q', sceneContext: '- hint', target: 'adjustable wrench' });
  assert.match(messages[0].content, /Never invent/);
  assert.match(messages[1].content[0].text, /may be wrong/);
  assert.match(messages[1].content[0].text, /REQUESTED TARGET: adjustable wrench/);
});

// ── security: the key must never be referenceable from client code ───────────

test('no client source file references VITE_GROQ_API_KEY (would inline the key into the bundle)', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) scan(path);
      else if (/\.(js|jsx|mjs)$/.test(name) && readFileSync(path, 'utf8').includes('VITE_GROQ_API_KEY')) offenders.push(path);
    }
  };
  scan('src');
  assert.deepEqual(offenders, [], `VITE_GROQ_API_KEY found in: ${offenders.join(', ')}`);
});
