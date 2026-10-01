// [AUMFE-POD-STUDIO-WEB-1 2026-10-01] The print file — spec §0 rule 2.
// Renders the artwork clipped to the owner's frame (none / rectangle / square / circle) at 300 DPI into a
// TRANSPARENT PNG, in the browser. That PNG is the only file a print partner ever receives; the server never
// re-renders it. Pixels = inches × 300, both sides capped at 5000 (scaled down and the real DPI reported).
// Only the visible part (art ∩ frame) is exported — Printrove trims see-through edges itself, so the placement
// the editor saves (print_left_in / print_top_in) is the position of THIS bitmap, exactly.
// Heavy: import this module dynamically (await import('../lib/printFile')).
import { EXPORT_DPI, EXPORT_MAX_PX, type FrameShape, type Layout } from './studioGeometry';

export const PREVIEW_MAX_PX = 1600;

export interface PrintRender {
  blob: Blob;
  preview: Blob;
  width: number;
  height: number;
  /** Real DPI of the printed pixels (≤ 300; lower when the 5000 px cap kicked in or the art is low-res). */
  dpi: number;
  scaledDown: boolean;
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image file.'))), type, quality);
  });
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
}

/** Clip path of the frame, in canvas pixels. Frame origin (fx, fy) is relative to the exported bitmap. */
function clipFrame(ctx: CanvasRenderingContext2D, shape: FrameShape, fx: number, fy: number, fw: number, fh: number): void {
  ctx.beginPath();
  if (shape === 'circle') ctx.ellipse(fx + fw / 2, fy + fh / 2, fw / 2, fh / 2, 0, 0, Math.PI * 2);
  else ctx.rect(fx, fy, fw, fh);
  ctx.clip();
}

/**
 * Render the print file. `art` is the decoded artwork (its natural pixel size is the source resolution),
 * `layout` comes from computeLayout() with the same state the owner saw.
 */
export async function renderPrintFile(art: ImageBitmap | HTMLImageElement, layout: Layout, shape: FrameShape): Promise<PrintRender> {
  if (layout.empty) throw new Error('Nothing of your artwork is inside the frame.');
  const natW = 'naturalWidth' in art ? art.naturalWidth : art.width;
  const natH = 'naturalHeight' in art ? art.naturalHeight : art.height;

  let ppi = EXPORT_DPI;
  let w = Math.round(layout.visW * ppi);
  let h = Math.round(layout.visH * ppi);
  const longest = Math.max(w, h);
  let scaledDown = false;
  if (longest > EXPORT_MAX_PX) {
    const k = EXPORT_MAX_PX / longest;
    ppi = EXPORT_DPI * k;
    w = Math.round(layout.visW * ppi); h = Math.round(layout.visH * ppi);
    scaledDown = true;
  }

  const canvas = newCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot draw the print file.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  // Frame position relative to the exported (visible) bitmap.
  clipFrame(ctx, shape, -layout.visX * ppi, -layout.visY * ppi, layout.frameW * ppi, layout.frameH * ppi);
  ctx.drawImage(art, (layout.artLeft - layout.visX) * ppi, (layout.artTop - layout.visY) * ppi, layout.artW * ppi, layout.artH * ppi);
  ctx.restore();

  const blob = await canvasToBlob(canvas, 'image/png');

  const pk = Math.min(1, PREVIEW_MAX_PX / Math.max(w, h));
  const pc = newCanvas(Math.round(w * pk), Math.round(h * pk));
  const pctx = pc.getContext('2d');
  if (!pctx) throw new Error('Your browser cannot draw the preview.');
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(canvas, 0, 0, pc.width, pc.height);
  const preview = await canvasToBlob(pc, 'image/webp', 0.9);

  const sourceDpi = layout.artW > 0 ? natW / layout.artW : 0;
  void natH;
  return { blob, preview, width: w, height: h, dpi: Math.round(Math.min(sourceDpi, ppi)), scaledDown };
}
