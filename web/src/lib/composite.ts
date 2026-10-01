// [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Plain-shirt pictures — spec §0 rule 3 / §5.
// Draws the saved PRINT FILE onto the editor's shirt silhouette in each chosen colour, plus a print close-up,
// so every colour that is sold has at least one picture. Nothing here is AI: it is the same geometry the owner
// placed the art with (studioGeometry.ts). Output is uploaded by the Photos step as kind flat / closeup.
// Heavy canvas code: import dynamically.
import {
  AREA_TOP_PX, NECK_PATH, SHIRT_PATH, STAGE_CENTRE_X, STAGE_H, STAGE_PX_PER_IN, STAGE_W,
  type AreaIn, type SavedPlacement,
} from './studioGeometry';
import { canvasToBlob } from './printFile';

const BACKDROP = '#efe3cf';

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Print file on a flat shirt of one colour. `size` = output width in px (height follows the stage ratio). */
export async function flatShirtPicture(
  print: ImageBitmap, placement: SavedPlacement, area: AreaIn, colourHex: string, size = 1240,
): Promise<Blob> {
  const k = size / STAGE_W;
  const c = canvas(size, Math.round(STAGE_H * k));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot draw the picture.');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.scale(k, k);
  const shirt = new Path2D(SHIRT_PATH);
  ctx.fillStyle = colourHex;
  ctx.fill(shirt);
  ctx.lineWidth = 3; ctx.strokeStyle = '#00000033'; ctx.stroke(shirt);
  ctx.lineWidth = 10; ctx.strokeStyle = '#00000040'; ctx.stroke(new Path2D(NECK_PATH));
  // Where the print file sits: print area top-left + the saved offset inside it.
  const areaLeft = STAGE_CENTRE_X - (area.w * STAGE_PX_PER_IN) / 2;
  const left = placement.print_left_in ?? (area.w - placement.print_w_in) / 2;
  const top = placement.print_top_in ?? placement.frame_top_in;
  ctx.drawImage(print, areaLeft + left * STAGE_PX_PER_IN, AREA_TOP_PX + top * STAGE_PX_PER_IN,
    placement.print_w_in * STAGE_PX_PER_IN, placement.print_h_in * STAGE_PX_PER_IN);
  ctx.restore();
  return canvasToBlob(c, 'image/webp', 0.9);
}

/** The print large on the fabric colour, with a light fabric sheen. */
export async function printCloseup(print: ImageBitmap, colourHex: string, size = 1200): Promise<Blob> {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot draw the picture.');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = colourHex;
  ctx.fillRect(0, 0, size, size);
  const fit = Math.min((size * 0.8) / print.width, (size * 0.8) / print.height);
  const w = print.width * fit; const h = print.height * fit;
  ctx.drawImage(print, (size - w) / 2, (size - h) / 2, w, h);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(0,0,0,0.09)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasToBlob(c, 'image/webp', 0.9);
}
