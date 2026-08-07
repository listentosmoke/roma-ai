// Video input pipeline. Sources share one contract:
//   grabFrame() -> frame | null      (frame is an opaque payload detectors accept)
//   stop()
//
// createCameraSource: live webcam via getUserMedia, frames grabbed onto a canvas
// (browser only). createScriptedSource: pre-scripted frames for the Node
// simulation and tests — each scripted frame may carry `detections` for the mock
// detector and `people` hints for a scripted face recognizer.

export async function createCameraSource({ width = 640, height = 480, facingMode = 'environment' } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, facingMode },
    audio: false,
  });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // Separate small canvas fed to the object detector: the model downscales
  // internally anyway (~300px), so building its input tensor from a quarter-size
  // frame cuts per-cycle pixel work ~4× with no accuracy cost. The full-res
  // canvas is kept for the frame buffer / deep vision analysis.
  const DETECT_MAX_WIDTH = 320;
  const detectCanvas = document.createElement('canvas');
  const detectContext = detectCanvas.getContext('2d', { willReadFrequently: true });

  return {
    kind: 'camera',
    video,
    grabFrame() {
      const w = video.videoWidth || width;
      const h = video.videoHeight || height;
      if (!w || !h) return null;
      // Assigning canvas.width clears + reallocates the canvas even when the
      // value is unchanged — only resize when the camera dimensions change.
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      context.drawImage(video, 0, 0, w, h);
      const scale = Math.min(1, DETECT_MAX_WIDTH / w);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);
      if (detectCanvas.width !== dw || detectCanvas.height !== dh) { detectCanvas.width = dw; detectCanvas.height = dh; }
      detectContext.drawImage(video, 0, 0, dw, dh);
      return {
        canvas,
        detectCanvas,
        width: w,
        height: h,
        // Lazy JPEG for the frame buffer / deep analysis — only encoded on demand.
        toDataUrl: (quality = 0.7) => canvas.toDataURL('image/jpeg', quality),
      };
    },
    stop() {
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    },
  };
}

/** Replays scripted frames in order, holding the last one once exhausted. */
export function createScriptedSource(frames = []) {
  let index = 0;
  return {
    kind: 'scripted',
    grabFrame() {
      if (!frames.length) return null;
      const frame = frames[Math.min(index, frames.length - 1)];
      index += 1;
      return frame;
    },
    frameIndex: () => index,
    stop() {},
  };
}
