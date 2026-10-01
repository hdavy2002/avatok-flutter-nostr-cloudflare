// [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Client-side artwork analysis for the Upload step (spec §5).
// Decodes the file (createImageBitmap — a CMYK JPEG is converted to RGB by drawing it on a canvas),
// finds see-through edges and trims them, measures the soft (half-see-through) edge share, picks the 3
// dominant colours (k-means on a 64 px thumbnail) and prepares the upload + a ≤ 1600 px preview.
// Dynamic-import this file: it is canvas-heavy.
import { canvasToBlob } from '../../../lib/printFile';

export const ART_MAX_PX = 5000;
const ALPHA_EDGE = 8;
const BAND = 256;

export interface ArtAnalysis {
  /** What gets uploaded (trimmed PNG, or the untouched original when nothing needed changing). */
  blob: Blob;
  mime: string;
  fileName: string;
  /** Size after trimming / resizing, i.e. what the server will read from the file. */
  w: number; h: number; bytes: number;
  /** Original pixel size, before trimming and resizing. */
  srcW: number; srcH: number;
  has_alpha: boolean;
  trimmed_px: number;
  soft_edge_pct: number;
  dominant_colours: string[];
  cmyk_converted: boolean;
  resized: boolean;
  preview: Blob;
  /** Small object URL for the on-page preview (caller revokes). */
  previewUrl: string;
}

/** JPEG with 4 components in its SOF marker = CMYK/YCCK. */
async function isCmykJpeg(file: File): Promise<boolean> {
  if (file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name)) return false;
  const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9] === 4;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return false;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function hex2(n: number): string { return n.toString(16).padStart(2, '0'); }

/** k-means (k ≤ 3) over the opaque pixels of a small thumbnail. Returns hexes, biggest cluster first. */
function dominantColours(src: HTMLCanvasElement): string[] {
  const t = 64;
  const k = Math.min(1, t / Math.max(src.width, src.height));
  const tc = makeCanvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
  const tctx = tc.getContext('2d', { willReadFrequently: true });
  if (!tctx) return [];
  tctx.drawImage(src, 0, 0, tc.width, tc.height);
  const d = tctx.getImageData(0, 0, tc.width, tc.height).data;
  const px: number[][] = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) px.push([d[i], d[i + 1], d[i + 2]]);
  if (px.length === 0) return [];
  // Deterministic spread-out seeds: first pixel, then the farthest from the chosen seeds.
  const seeds: number[][] = [px[0]];
  while (seeds.length < 3) {
    let best = px[0]; let bestD = -1;
    for (const p of px) {
      const dist = Math.min(...seeds.map((s) => (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2 + (p[2] - s[2]) ** 2));
      if (dist > bestD) { bestD = dist; best = p; }
    }
    if (bestD <= 0) break;
    seeds.push(best);
  }
  let centres = seeds.map((s) => [...s]);
  let counts: number[] = centres.map(() => 0);
  for (let it = 0; it < 10; it++) {
    const sums = centres.map(() => [0, 0, 0]); counts = centres.map(() => 0);
    for (const p of px) {
      let bi = 0; let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dist = (p[0] - centres[c][0]) ** 2 + (p[1] - centres[c][1]) ** 2 + (p[2] - centres[c][2]) ** 2;
        if (dist < bd) { bd = dist; bi = c; }
      }
      sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2]; counts[bi]++;
    }
    centres = centres.map((c, i) => (counts[i] ? sums[i].map((v) => v / counts[i]) : c));
  }
  return centres
    .map((c, i) => ({ c, n: counts[i] }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => `#${hex2(Math.round(x.c[0]))}${hex2(Math.round(x.c[1]))}${hex2(Math.round(x.c[2]))}`);
}

export async function analyseArtwork(file: File): Promise<ArtAnalysis> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Use a PNG or JPG image.');
  const cmyk = await isCmykJpeg(file);
  const bmp = await createImageBitmap(file);
  const srcW = bmp.width; const srcH = bmp.height;
  const k = Math.min(1, ART_MAX_PX / Math.max(srcW, srcH));
  const cw = Math.max(1, Math.round(srcW * k)); const ch = Math.max(1, Math.round(srcH * k));
  const full = makeCanvas(cw, ch);
  const fctx = full.getContext('2d', { willReadFrequently: true });
  if (!fctx) throw new Error('Your browser cannot read the image.');
  fctx.drawImage(bmp, 0, 0, cw, ch);
  bmp.close();

  // Alpha scan in bands (never allocates the whole 100 MB at once).
  let minX = cw; let minY = ch; let maxX = -1; let maxY = -1;
  let opaqueish = 0; let soft = 0; let anyTransparent = false;
  for (let y0 = 0; y0 < ch; y0 += BAND) {
    const bh = Math.min(BAND, ch - y0);
    const d = fctx.getImageData(0, y0, cw, bh).data;
    for (let y = 0; y < bh; y++) {
      const row = y * cw * 4;
      for (let x = 0; x < cw; x++) {
        const a = d[row + x * 4 + 3];
        if (a < 255) anyTransparent = true;
        if (a > 0) { opaqueish++; if (a < 255) soft++; }
        if (a > ALPHA_EDGE) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          const yy = y0 + y;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
  }
  if (maxX < 0) throw new Error('That image is completely see-through.');
  const bw = maxX - minX + 1; const bh2 = maxY - minY + 1;
  const trimmed = bw < cw || bh2 < ch;
  const trimmedPx = (cw - bw) + (ch - bh2);

  let out = full;
  if (trimmed) {
    out = makeCanvas(bw, bh2);
    out.getContext('2d')?.drawImage(full, minX, minY, bw, bh2, 0, 0, bw, bh2);
  }
  const resized = k < 1;
  const changed = trimmed || resized || cmyk || file.type !== 'image/png';
  const blob: Blob = changed ? await canvasToBlob(out, 'image/png') : file;
  const pk = Math.min(1, 1600 / Math.max(out.width, out.height));
  const pc = makeCanvas(Math.round(out.width * pk), Math.round(out.height * pk));
  pc.getContext('2d')?.drawImage(out, 0, 0, pc.width, pc.height);
  const preview = await canvasToBlob(pc, 'image/webp', 0.9);

  return {
    blob, mime: blob.type || 'image/png', fileName: changed ? file.name.replace(/\.[^.]+$/, '') + '.png' : file.name,
    w: out.width, h: out.height, bytes: blob.size, srcW, srcH,
    has_alpha: anyTransparent, trimmed_px: trimmedPx,
    soft_edge_pct: opaqueish ? Math.round((soft / opaqueish) * 1000) / 10 : 0,
    dominant_colours: dominantColours(out), cmyk_converted: cmyk, resized,
    preview, previewUrl: URL.createObjectURL(preview),
  };
}

/** "Make edges solid": pixels ≥ half opaque become fully opaque, the rest fully see-through. Returns a new File. */
export async function solidifyEdges(file: File | Blob, name: string): Promise<File> {
  const bmp = await createImageBitmap(file);
  const c = makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Your browser cannot read the image.');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  for (let y0 = 0; y0 < c.height; y0 += BAND) {
    const bh = Math.min(BAND, c.height - y0);
    const img = ctx.getImageData(0, y0, c.width, bh);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    ctx.putImageData(img, 0, y0);
  }
  const b = await canvasToBlob(c, 'image/png');
  return new File([b], name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
}
