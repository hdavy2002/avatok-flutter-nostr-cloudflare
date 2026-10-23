/* [HF-MERCH-STUDIO-2] "Erase plain colour": removes a flat background in the browser. Flood-fills from the picture's edges through pixels close to the
 * corner colour (so the same colour inside the artwork stays), then softens the cut edge a little. No server, no AI, free. */
import { canvasToBlob } from '../../../../lib/printFile';

export const ERASE_MAX_PX = 4096;

export function loadImageFrom(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!/^(blob:|data:)/.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the picture.'));
    img.src = url;
  });
}

/** Draws an image onto a canvas, scaled so the long side is at most `maxPx`. */
export function imageToCanvas(img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number }, maxPx: number): HTMLCanvasElement {
  const nw = img.naturalWidth || img.width; const nh = img.naturalHeight || img.height;
  const k = Math.min(1, maxPx / Math.max(nw, nh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(nw * k)); c.height = Math.max(1, Math.round(nh * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Your browser cannot edit pictures.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** The background colour: the most common of the four corner patches (so one odd corner does not decide). */
function cornerColour(d: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const patch = Math.max(1, Math.min(6, Math.floor(Math.min(w, h) / 20)));
  const corners: [number, number, number][] = [];
  for (const [cx, cy] of [[0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch]]) {
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = cy; y < cy + patch; y++) for (let x = cx; x < cx + patch; x++) { const i = (y * w + x) * 4; if (d[i + 3] < 16) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (n) corners.push([r / n, g / n, b / n]);
  }
  if (!corners.length) return [255, 255, 255];
  let best = corners[0]; let bestVotes = -1;
  for (const c of corners) {
    const votes = corners.filter(o => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 40).length;
    if (votes > bestVotes) { best = c; bestVotes = votes; }
  }
  return best;
}

/** tolerance 1..100 (how different a pixel may be and still count as background), feather 0..6 px. Returns a NEW canvas with transparency. */
export function eraseBackground(src: HTMLCanvasElement, tolerance: number, feather: number): HTMLCanvasElement {
  const w = src.width; const h = src.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Your browser cannot edit pictures.');
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [br, bg, bb] = cornerColour(d, w, h);
  const thr = Math.max(1, tolerance) * 2.4;
  const bgLike = (p: number): boolean => {
    const i = p * 4;
    if (d[i + 3] < 16) return true;
    return Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb) <= thr;
  };
  const mask = new Uint8Array(w * h); // 1 = background
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (p: number): void => { if (!mask[p] && bgLike(p)) { mask[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w; const y = (p - x) / w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }
  // soft edge: blur the mask a little, art alpha = 1 - blurred mask
  let soft: Float32Array = Float32Array.from(mask);
  const r = Math.round(feather);
  if (r > 0) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += soft[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += soft[y * w + Math.min(w - 1, x + r + 1)] - soft[y * w + Math.max(0, x - r)];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    soft = out;
  }
  for (let p = 0; p < w * h; p++) {
    const m = mask[p] ? 1 : soft[p];
    if (m <= 0) continue;
    const i = p * 4;
    d[i + 3] = Math.round(d[i + 3] * (1 - (mask[p] ? 1 : Math.min(1, m * 1.15))));
  }
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const dctx = dst.getContext('2d');
  if (!dctx) throw new Error('Your browser cannot edit pictures.');
  dctx.putImageData(img, 0, 0);
  return dst;
}

export const canvasToPng = (c: HTMLCanvasElement): Promise<Blob> => canvasToBlob(c, 'image/png');
