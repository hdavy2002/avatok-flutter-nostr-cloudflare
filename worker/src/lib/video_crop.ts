// [SAATHUM-FREEVID-BASE-1 2026-10-01] Server copy of the video-crop rules.
// Web twin: web/src/components/dash2/crop.ts — keep the two in step.
// A crop is four fractions (0..1) of the full 16:9 YouTube frame; null = no crop.

export interface VideoCrop { x: number; y: number; w: number; h: number }

export const CROP_MIN = 0.05;

export function isValidCrop(c: unknown): c is VideoCrop {
  if (!c || typeof c !== "object") return false;
  const { x, y, w, h } = c as Record<string, unknown>;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  const [X, Y, W, H] = [x, y, w, h] as number[];
  return X >= 0 && Y >= 0 && W >= CROP_MIN && H >= CROP_MIN && X + W <= 1.0001 && Y + H <= 1.0001;
}

/** Normalise to a crop or null. A near-full-frame box is stored as null (no crop). */
export function toCrop(c: unknown): VideoCrop | null {
  if (!isValidCrop(c)) return null;
  const r = (v: number) => Math.round(v * 10_000) / 10_000;
  const out = { x: r(c.x), y: r(c.y), w: r(Math.min(c.w, 1 - c.x)), h: r(Math.min(c.h, 1 - c.y)) };
  if (out.x <= 0.001 && out.y <= 0.001 && out.w >= 0.999 && out.h >= 0.999) return null;
  return out;
}

/** Read the four event_videos columns back into a crop (or null). */
export function cropFromRow(row: { crop_x?: number | null; crop_y?: number | null; crop_w?: number | null; crop_h?: number | null } | null | undefined): VideoCrop | null {
  if (!row || row.crop_x == null || row.crop_y == null || row.crop_w == null || row.crop_h == null) return null;
  return toCrop({ x: row.crop_x, y: row.crop_y, w: row.crop_w, h: row.crop_h });
}
