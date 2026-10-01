// [AUMFE-POD-CORE-1] Print-area specs and artwork-fit maths. Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3.
// Source: the print partner's "How to prepare design files for apparel products" (RGB only, >= 300 DPI, max 5000 x 5000 px,
// PNG/JPEG, transparent edges auto-trimmed, API upload <= 15 MB). Kept as DATA so a provider can override later.
import type { PrintSide } from './types';

export const PRINT_SPECS = {
  min_dpi: 300,
  max_px: 5000,
  max_upload_bytes: 15 * 1024 * 1024,
  areas: {
    mens_tee:    { front: [15.6, 19.6], back: [15.6, 19.6], label: "Men's T-shirt" },
    womens_tee:  { front: [11.6, 14.5], back: [11.6, 14.5], label: "Women's T-shirt" },
    kids_tee:    { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Kids T-shirt' },
    toddler_tee: { front: [7, 7.8],     back: [7, 7.8],     label: 'Toddler T-shirt' },
    hoodie:      { front: [12, 10.5],   back: [14, 16],     label: 'Hoodie' },
    sweatshirt:  { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Sweatshirt' },
    polo:        { front: [4, 4],       back: [14, 16],     label: 'Polo T-shirt' },
    crop_top:    { front: [12, 10],     back: [12, 10],     label: 'Crop top' },
    crop_hoodie: { front: [10.6, 10.6], back: [10.6, 10.6], label: 'Crop hoodie' },
  },
} as const; // [w_in, h_in]

export type PrintKind = keyof typeof PRINT_SPECS.areas;
export type FitVerdict = 'great' | 'good' | 'small_only' | 'too_small';

/** How wide/tall the artwork can print sharp (at 300 DPI), one decimal. */
export function maxSharpInches(px_w: number, px_h: number): { w: number; h: number } {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { w: r1(Math.max(0, px_w) / PRINT_SPECS.min_dpi), h: r1(Math.max(0, px_h) / PRINT_SPECS.min_dpi) };
}

/** Print area [w_in, h_in] for a kind + side, or null when the kind is not a known garment (e.g. 'other'). */
export function areaFor(kind: string, side: PrintSide): readonly [number, number] | null {
  const a = (PRINT_SPECS.areas as Record<string, Record<string, unknown>>)[kind];
  if (!a) return null;
  return a[side] as readonly [number, number];
}

/**
 * How well artwork of px_w x px_h fills the print area of `kind`/`side`.
 * great >= 300 DPI at the full area width; good 250-299; small_only = sharp only as a smaller chest print;
 * too_small = below 150 DPI even at a 4 in print (i.e. under 600 px wide).
 */
export function fitForProduct(px_w: number, px_h: number, kind: string, side: PrintSide):
  { full_area_dpi: number; sharp_w_in: number; verdict: FitVerdict; note: string } {
  const area = areaFor(kind, side) ?? PRINT_SPECS.areas.mens_tee.front;
  const full_area_dpi = Math.round(Math.max(0, px_w) / area[0]);
  const sharp_w_in = maxSharpInches(px_w, px_h).w;
  const dpiAt4in = Math.max(0, px_w) / 4;
  let verdict: FitVerdict;
  let note: string;
  if (full_area_dpi >= 300) {
    verdict = 'great';
    note = `Sharp across the full ${area[0]} in print width.`;
  } else if (full_area_dpi >= 250) {
    verdict = 'good';
    note = `Prints well across the full width (${full_area_dpi} DPI).`;
  } else if (dpiAt4in >= 150) {
    verdict = 'small_only';
    note = `Sharp only as a smaller print, up to about ${sharp_w_in} in wide.`;
  } else {
    verdict = 'too_small';
    note = 'Too small to print sharp even as a small chest print. Use a larger image.';
  }
  return { full_area_dpi, sharp_w_in, verdict, note };
}
