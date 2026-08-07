// Reusable image preparation for remote vision analysis: take a buffered frame
// (a live canvas or a stored JPEG data URL), optionally crop to a padded region
// around a known bounding box, downscale to a max dimension, and re-encode as
// JPEG — WITHOUT mutating the original buffered frame. Records the final
// encoded byte size and dimensions so the UI/metrics can show what was sent.
//
// Canvas/image primitives are injectable (`createCanvas`, `loadImage`) so the
// logic is fully testable in Node; in the browser the defaults are used. In a
// bare Node context with no canvas available, a frame that already carries a
// dataUrl is passed through unmodified (the Groq payload limit still applies —
// callers keep buffered JPEGs modest via the camera capture size).

export const DEFAULT_MAX_DIMENSION = 768;
export const DEFAULT_JPEG_QUALITY = 0.72;

/** Pure: target size preserving aspect ratio, never upscaling. */
export function computeTargetSize(width, height, maxDimension = DEFAULT_MAX_DIMENSION) {
  if (!width || !height) return { width: width || 0, height: height || 0, scale: 1 };
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Pure: expand a normalized [0..1] box by padding on every side, clamped to the frame. */
export function expandCrop(box, padding = 0.15) {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  return {
    x,
    y,
    width: Math.min(1 - x, box.width + padding * 2),
    height: Math.min(1 - y, box.height + padding * 2),
  };
}

/** Pure: decoded byte size of a base64 data URL. */
export function estimateDataUrlBytes(dataUrl) {
  const base64 = typeof dataUrl === 'string' ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
  return Math.floor((base64.length * 3) / 4);
}

function defaultCreateCanvas(width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultLoadImage(dataUrl) {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode the buffered frame image.'));
    image.src = dataUrl;
  });
}

/**
 * @param {{ canvas?: object, dataUrl?: string, width?: number, height?: number }} frame — never mutated
 * @param {{ maxDimension?: number, quality?: number, crop?: {x,y,width,height}|null, cropPadding?: number,
 *           createCanvas?: Function, loadImage?: Function }} [options]
 * @returns {Promise<{ dataUrl: string, width: number|null, height: number|null, bytes: number, resized: boolean, cropped: boolean }>}
 */
export async function prepareImage(frame, {
  maxDimension = DEFAULT_MAX_DIMENSION,
  quality = DEFAULT_JPEG_QUALITY,
  crop = null,
  cropPadding = 0.15,
  createCanvas = defaultCreateCanvas,
  loadImage = defaultLoadImage,
} = {}) {
  if (!frame) throw new Error('No frame was provided for image preparation.');

  // Resolve a drawable source (live canvas, or decode the stored JPEG).
  let source = frame.canvas ?? null;
  if (!source && frame.dataUrl) source = await loadImage(frame.dataUrl);

  if (!source) {
    // No canvas capability (plain Node) — pass a stored JPEG through untouched.
    if (frame.dataUrl) {
      return {
        dataUrl: frame.dataUrl,
        width: frame.width ?? null,
        height: frame.height ?? null,
        bytes: estimateDataUrlBytes(frame.dataUrl),
        resized: false,
        cropped: false,
      };
    }
    throw new Error('Frame has no image data (no canvas and no dataUrl).');
  }

  const sourceWidth = source.width ?? source.videoWidth;
  const sourceHeight = source.height ?? source.videoHeight;

  const region = crop ? expandCrop(crop, cropPadding) : { x: 0, y: 0, width: 1, height: 1 };
  const regionWidth = Math.max(1, Math.round(region.width * sourceWidth));
  const regionHeight = Math.max(1, Math.round(region.height * sourceHeight));
  const target = computeTargetSize(regionWidth, regionHeight, maxDimension);

  const output = createCanvas(target.width, target.height);
  if (!output) throw new Error('No canvas implementation is available to prepare the image.');
  output.getContext('2d').drawImage(
    source,
    Math.round(region.x * sourceWidth), Math.round(region.y * sourceHeight), regionWidth, regionHeight,
    0, 0, target.width, target.height,
  );
  const dataUrl = output.toDataURL('image/jpeg', quality);

  return {
    dataUrl,
    width: target.width,
    height: target.height,
    bytes: estimateDataUrlBytes(dataUrl),
    resized: target.scale < 1,
    cropped: Boolean(crop),
  };
}
