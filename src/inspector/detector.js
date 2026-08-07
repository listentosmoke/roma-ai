// Object detection interface (fast path). Detectors share one contract:
//
//   detect(frame) -> Promise<[{ label, confidence, box?: {x,y,width,height} }]>
//
// with boxes normalized to [0..1] of the frame. Two implementations today:
//  - mock: reads scripted detections off the frame itself (Node simulation/tests)
//  - coco-ssd: real in-browser detection via TensorFlow.js COCO-SSD from a CDN
//    (80 common classes @ ~20-60 ms/frame on WebGL). It knows generic classes
//    only — "adjustable wrench vs pliers" is exactly what the deep-analysis path
//    is for. Swap in YOLO/RT-DETR later behind the same detect() contract.

export function createMockDetector() {
  return {
    name: 'mock',
    async detect(frame) {
      return frame?.detections ?? [];
    },
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

export async function createCocoSsdDetector(onStatus) {
  await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
  const model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  // If WebGL is unavailable (e.g. hardware acceleration disabled), tfjs falls
  // back to its CPU backend and each detect() takes hundreds of ms — surface
  // that so the pacing backoff in inspector.js is explainable, not mysterious.
  const backend = window.tf?.getBackend?.() ?? 'unknown';
  if (backend !== 'webgl' && backend !== 'webgpu') {
    onStatus?.(`Detector running on the slow "${backend}" backend (no GPU acceleration) — expect a reduced frame rate.`);
  }
  return {
    name: `coco-ssd (${backend})`,
    async detect(frame) {
      // Prefer the downscaled detection canvas; boxes are normalized so the
      // coordinates are identical either way.
      const source = frame?.detectCanvas ?? frame?.canvas ?? frame?.video;
      if (!source) return [];
      const width = source.width || source.videoWidth;
      const height = source.height || source.videoHeight;
      const predictions = await model.detect(source);
      return predictions.map((p) => ({
        label: p.class,
        confidence: p.score,
        box: { x: p.bbox[0] / width, y: p.bbox[1] / height, width: p.bbox[2] / width, height: p.bbox[3] / height },
      }));
    },
  };
}

/** Factory mirroring engine/index.js: pick a detector from config, degrading to mock. */
export async function createDetector(settings = {}, onStatus) {
  if (settings.detector === 'coco-ssd' && typeof window !== 'undefined') {
    try {
      onStatus?.('Loading detector (coco-ssd)…');
      return await createCocoSsdDetector(onStatus);
    } catch (error) {
      onStatus?.(`Detector load failed (${error.message}); using mock.`);
    }
  }
  return createMockDetector();
}
