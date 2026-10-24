/* [HF-MERCH-STUDIO-2] Print export + mockups for the studio. exportDesign() renders every visible layer at 300 DPI (long side capped at 5000 px) into ONE transparent
 * PNG = union box of the layers clipped to the print area (spec section 2). [HF-MERCH-AI-HIRES-1] A PNG over 14 MB is redrawn smaller (never under 200 DPI) to fit the 15 MB limit. Layers are drawn by the same Konva nodes the stage uses (nodes.ts). */
import type Konva from 'konva';
import { EXPORT_DPI, EXPORT_MAX_PX } from '../../../../lib/studioGeometry';
import { canvasToBlob } from '../../../../lib/printFile';
import { loadMerchFonts } from './fonts';
import { applyLayer, createNode, designBounds, getKonva, loadImage, markFontReady, type KonvaLib, type RectIn } from './nodes';
import { printAreaPx, silhouetteDataUrl } from './silhouettes';
import type { Layer, Side, StudioArt } from './types';

export class ExportError extends Error {
  constructor(public code: 'nothing' | 'unreadable_picture' | 'canvas', message: string) { super(message); }
}
export const UNREADABLE = 'Could not read the picture — please upload it again.';
/** [HF-MERCH-AI-HIRES-1] The server and Printrove take print files up to 15 MB (MERCH_PRINT_MAX_BYTES); we aim a little under it. */
export const PRINT_LIMIT_BYTES = 15 * 1024 * 1024;
export const EXPORT_MAX_BYTES = 14 * 1024 * 1024;
/** Lowest DPI a too-big file is redrawn at ("Good" in dpiQuality). */
export const EXPORT_MIN_DPI = 200;

export interface ExportResult {
  blob: Blob; canvas: HTMLCanvasElement; preview: Blob;
  wIn: number; hIn: number; leftIn: number; topIn: number; widthPx: number; heightPx: number; dpi: number; scaledDown: boolean;
}

/** The picture source a layer should be exported from: the original bytes (object URL) when the tray has them, else the layer's own src. */
export function sourceFor(layer: { artId: string; src: string }, arts: StudioArt[]): string {
  const a = arts.find(x => x.artId === layer.artId);
  return a?.localUrl ?? layer.src ?? a?.url ?? '';
}

/** Loads a picture for export. Remote files are fetched as a blob first so the canvas can never be tainted. */
export async function loadPicture(src: string, temp: string[]): Promise<HTMLImageElement> {
  if (!src) throw new ExportError('unreadable_picture', UNREADABLE);
  try {
    if (/^(blob:|data:)/.test(src)) return await loadImage(src);
    const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`picture_http_${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    temp.push(url);
    return await loadImage(url);
  } catch (e) {
    throw Object.assign(new ExportError('unreadable_picture', UNREADABLE), { cause: e });
  }
}

/** Halves a big picture step by step until it is near the target size, so the final scale-down stays crisp (no aliasing). */
function prescale(img: HTMLImageElement, tw: number, th: number): CanvasImageSource {
  let w = img.naturalWidth; let h = img.naturalHeight;
  let src: CanvasImageSource = img;
  while (w / 2 >= tw * 1.05 && h / 2 >= th * 1.05) {
    w = Math.ceil(w / 2); h = Math.ceil(h / 2);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) break;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    src = c;
  }
  return src;
}

const canvasOf = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

/** Renders the design. `layers` are in bottom -> top order; `arts` supplies the original picture bytes. */
export async function exportDesign(input: { layers: Layer[]; areaIn: { w: number; h: number }; arts: StudioArt[] }): Promise<ExportResult> {
  const K: KonvaLib = await getKonva();
  const fails = await loadMerchFonts(input.layers.flatMap(l => (l.type === 'text' && l.visible ? [l.font] : [])));
  input.layers.forEach(l => { if (l.type === 'text') markFontReady(l.font); });
  if (fails.length) throw new ExportError('canvas', `Could not load the font ${fails[0].family}. Check your internet and try again.`);
  const bounds: RectIn | null = designBounds(K, input.layers, input.areaIn);
  if (!bounds) throw new ExportError('nothing', 'Put your picture or text inside the dashed box first.');

  let ppi = EXPORT_DPI;
  let widthPx = Math.round(bounds.w * ppi); let heightPx = Math.round(bounds.h * ppi);
  const longest = Math.max(widthPx, heightPx);
  let scaledDown = false;
  if (longest > EXPORT_MAX_PX) { ppi = (EXPORT_DPI * EXPORT_MAX_PX) / longest; widthPx = Math.round(bounds.w * ppi); heightPx = Math.round(bounds.h * ppi); scaledDown = true; }

  const temp: string[] = [];
  const prevRatio = K.pixelRatio;
  const held: { stage: Konva.Stage | null } = { stage: null };
  try {
    // images first (async), then build the stage in one synchronous go with pixelRatio 1 (a retina 2x canvas of 5000 px would not fit in memory)
    const els = new Map<string, HTMLImageElement>();
    for (const l of input.layers) {
      if (l.type !== 'image' || !l.visible) continue;
      els.set(l.id, await loadPicture(sourceFor(l, input.arts), temp));
    }
    const draw = (): HTMLCanvasElement => {
      held.stage?.destroy();
      K.pixelRatio = 1;
      const stage = new K.Stage({ container: document.createElement('div'), width: widthPx, height: heightPx });
      held.stage = stage;
      const lay = new K.Layer(); stage.add(lay);
      for (const l of input.layers) {
        if (!l.visible) continue;
        const node = createNode(K, l);
        applyLayer(node, l, ppi, -bounds.left * ppi, -bounds.top * ppi);
        const el = els.get(l.id);
        if (l.type === 'image' && el) (node as Konva.Image).image(prescale(el, l.w * ppi, l.h * ppi) as HTMLImageElement);
        lay.add(node);
      }
      lay.draw();
      const c = stage.toCanvas({ pixelRatio: 1 }) as HTMLCanvasElement;
      K.pixelRatio = prevRatio;
      return c;
    };
    let canvas = draw();
    let blob = await canvasToBlob(canvas, 'image/png');
    // [HF-MERCH-AI-HIRES-1] A big, detailed picture (a sharp 4K AI picture across the whole shirt) can make a PNG over the 15 MB print-file limit.
    // Then draw it again a little smaller, never under EXPORT_MIN_DPI (the print stays "Good"); the server and Printrove both cap the file at 15 MB.
    for (let i = 0; i < 3 && blob.size > EXPORT_MAX_BYTES && ppi > EXPORT_MIN_DPI; i++) {
      ppi = Math.max(EXPORT_MIN_DPI, ppi * Math.sqrt(EXPORT_MAX_BYTES / blob.size) * 0.92);
      widthPx = Math.max(1, Math.round(bounds.w * ppi)); heightPx = Math.max(1, Math.round(bounds.h * ppi)); scaledDown = true;
      canvas = draw();
      blob = await canvasToBlob(canvas, 'image/png');
    }
    if (blob.size > PRINT_LIMIT_BYTES) throw new ExportError('canvas', 'Your design makes a print file that is too big. Make the picture a little smaller on the product and try again.');
    const pk = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
    const pc = canvasOf(canvas.width * pk, canvas.height * pk);
    const pctx = pc.getContext('2d');
    if (!pctx) throw new ExportError('canvas', 'Your browser cannot draw the preview.');
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(canvas, 0, 0, pc.width, pc.height);
    const preview = await canvasToBlob(pc, 'image/webp', 0.9);
    return { blob, canvas, preview, wIn: bounds.w, hIn: bounds.h, leftIn: bounds.left, topIn: bounds.top, widthPx: canvas.width, heightPx: canvas.height, dpi: Math.round(canvas.width / bounds.w), scaledDown };
  } finally {
    K.pixelRatio = prevRatio;
    held.stage?.destroy();
    temp.forEach(u => URL.revokeObjectURL(u));
  }
}

/** One product picture: the silhouette in `hex` with the print placed on the print area. 900 px by default (spec section 2). */
export async function renderMockup(o: {
  family: string; side: Side; hex: string; areaIn: { w: number; h: number }; print: CanvasImageSource;
  leftIn: number; topIn: number; wIn: number; hIn: number; size?: number;
}): Promise<Blob> {
  const size = o.size ?? 900;
  const c = canvasOf(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) throw new ExportError('canvas', 'Your browser cannot draw the picture.');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#efe3cf'; ctx.fillRect(0, 0, size, size);
  const shape = await loadImage(silhouetteDataUrl(o.family, o.side, o.hex));
  ctx.drawImage(shape, 0, 0, size, size);
  const g = printAreaPx(o.family, o.side, o.areaIn);
  const k = size / 1000;
  const dw = o.wIn * g.ppi * k; const dh = o.hIn * g.ppi * k;
  let src = o.print;
  const sw = (o.print as HTMLCanvasElement).width; const sh = (o.print as HTMLCanvasElement).height;
  if (sw > dw * 1.6) {
    // stepwise halving, same idea as prescale()
    let w = sw; let h = sh;
    while (w / 2 >= dw * 1.05) {
      w = Math.ceil(w / 2); h = Math.ceil(h / 2);
      const t = canvasOf(w, h); const tctx = t.getContext('2d'); if (!tctx) break;
      tctx.imageSmoothingQuality = 'high'; tctx.drawImage(src, 0, 0, w, h); src = t;
    }
  }
  ctx.drawImage(src, (g.x + o.leftIn * g.ppi) * k, (g.y + o.topIn * g.ppi) * k, dw, dh);
  return canvasToBlob(c, 'image/webp', 0.9);
}
