// [AUMFE-POD-STUDIO-API-1 2026-10-01] Pure helpers for the Shop Studio API (routes/admin2_studio.ts).
// Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 4. No I/O here so every rule is unit-testable.
// Print-partner facts (print areas, DPI verdicts) come from lib/pod; nothing partner-specific is named in this file.
import { PRINT_SPECS, fitForProduct } from "./pod";
import type { CatalogProduct, CatalogVariant, PrintSide } from "./pod";

export type PodKind = keyof typeof PRINT_SPECS.areas;
export const POD_KINDS = Object.keys(PRINT_SPECS.areas) as PodKind[];
export const SIDES: readonly PrintSide[] = ["front", "back"];
export const STEPS = ["upload", "product", "design", "photos", "publish"] as const;
export const PHOTO_KINDS = ["model", "flat", "closeup"] as const;
export const SHAPES = ["none", "rect", "square", "circle"] as const;
export type Shape = (typeof SHAPES)[number];

export const LIMITS = {
  artBytes: 25 * 1024 * 1024,
  previewBytes: 3 * 1024 * 1024,
  printBytes: 15 * 1024 * 1024,
  photoBytes: 15 * 1024 * 1024,
  photoShortSidePx: 1200,
  minDpi: 150,
  maxPhotosPerDesign: 40,
} as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isKind = (k: unknown): k is PodKind => typeof k === "string" && Object.prototype.hasOwnProperty.call(PRINT_SPECS.areas, k);
export const isSide = (s: unknown): s is PrintSide => s === "front" || s === "back";

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v === null || v === undefined ? fallback : v) as T;
  } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Image headers (PNG / JPEG / WebP): dimensions, alpha, colour model. Reads only the header bytes.
// ---------------------------------------------------------------------------
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export type ImageInfo = { mime: ImageMime; w: number; h: number; has_alpha: boolean | null; rgb: boolean | null };

export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

function pngInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 33 || u32be(b, 8) !== 13 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const w = u32be(b, 16), h = u32be(b, 20), colourType = b[25];
  if (!w || !h) return null;
  let alpha = colourType === 4 || colourType === 6;
  if (!alpha && (colourType === 3 || colourType === 0 || colourType === 2)) {
    // A tRNS chunk (before the first IDAT) gives palette / grey / truecolour images transparency.
    let o = 33;
    while (o + 8 <= b.length) {
      const len = u32be(b, o);
      const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (type === "tRNS") { alpha = true; break; }
      if (type === "IDAT" || type === "IEND") break;
      o += 12 + len;
    }
  }
  return { mime: "image/png", w, h, has_alpha: alpha, rgb: true };
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null; // image data reached without a frame header
    const len = u16be(b, o + 2);
    const sof = (m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (o + 10 > b.length) return null;
      const h = u16be(b, o + 5), w = u16be(b, o + 7), comps = b[o + 9];
      if (!w || !h) return null;
      return { mime: "image/jpeg", w, h, has_alpha: false, rgb: comps === 4 ? false : comps === 3 ? true : null };
    }
    o += 2 + len;
  }
  return null;
}

function webpInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === "VP8X") return { mime: "image/webp", w: u24le(b, 24) + 1, h: u24le(b, 27) + 1, has_alpha: (b[20] & 0x10) !== 0, rgb: true };
  if (tag === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { mime: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, has_alpha: ((bits >>> 28) & 1) === 1, rgb: true };
  }
  if (tag === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: "image/webp", w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff, has_alpha: false, rgb: true };
  }
  return null;
}

/** null = not a readable PNG/JPEG/WebP. */
export function parseImageInfo(b: Uint8Array): ImageInfo | null {
  const mime = sniffImageMime(b);
  if (mime === "image/png") return pngInfo(b);
  if (mime === "image/jpeg") return jpegInfo(b);
  if (mime === "image/webp") return webpInfo(b);
  return null;
}

export const IMAGE_EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// ---------------------------------------------------------------------------
// Colour maths. "Looks faded" = contrast(dominant art colour, garment) < 3:1 (WCAG relative luminance).
// ---------------------------------------------------------------------------
export function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX_RE.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function luminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export const FADED_BELOW = 3;

/** true when the art's main colour would look faded on this garment. Unknown colours never claim "faded". */
export function looksFaded(dominantHexes: string[], garmentHex: string | null): boolean {
  const main = dominantHexes.find((h) => HEX_RE.test(h));
  if (!main || !garmentHex) return false;
  const c = contrastRatio(main, garmentHex);
  return c !== null && c < FADED_BELOW;
}

export function cleanHexList(v: unknown, max = 5): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim().toLowerCase()).filter((x) => HEX_RE.test(x)).slice(0, max);
}

// ---------------------------------------------------------------------------
// Catalogue helpers
// ---------------------------------------------------------------------------
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "5XL"];
export function sizeRank(size: string): number {
  const s = size.toUpperCase().replace(/\s+/g, "");
  const i = SIZE_ORDER.indexOf(s);
  if (i >= 0) return i;
  const age = /^(\d+)(?:-(\d+))?Y$/.exec(s); // kids: 2-3Y, 3Y
  if (age) return 100 + Number(age[1]);
  return 1000;
}
export const sortSizes = (sizes: string[]) => [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b) || a.localeCompare(b));

export type CatalogColour = { name: string; hex: string | null };
export type CatalogSummary = { provider_product_id: string; name: string; kind: string; colours: CatalogColour[]; sizes: string[]; cost_from_paise: number | null };

export function summariseCatalog(p: Pick<CatalogProduct, "provider_product_id" | "name" | "kind" | "variants">): CatalogSummary {
  const colours = new Map<string, CatalogColour>();
  const sizes = new Set<string>();
  let cost: number | null = null;
  for (const v of p.variants) {
    if (!colours.has(v.colour.toLowerCase())) colours.set(v.colour.toLowerCase(), { name: v.colour, hex: v.colour_hex && HEX_RE.test(v.colour_hex) ? v.colour_hex.toLowerCase() : null });
    sizes.add(v.size);
    if (typeof v.base_cost_paise === "number" && v.base_cost_paise > 0) cost = cost === null ? v.base_cost_paise : Math.min(cost, v.base_cost_paise);
  }
  return { provider_product_id: p.provider_product_id, name: p.name, kind: p.kind, colours: [...colours.values()], sizes: sortSizes([...sizes]), cost_from_paise: cost };
}

// ---------------------------------------------------------------------------
// Fits (Product step)
// ---------------------------------------------------------------------------
export type FitRow = {
  kind: PodKind; label: string; side: PrintSide; area_in: [number, number];
  full_area_dpi: number; sharp_w_in: number; verdict: "great" | "good" | "small_only" | "too_small"; note: string;
  catalog: { provider_product_id: string; colours: Array<{ name: string; hex: string | null; faded: boolean }>; sizes: string[]; cost_from_paise: number | null } | null;
};

const VERDICT_RANK = { great: 3, good: 2, small_only: 1, too_small: 0 } as const;

export function buildFits(artW: number, artH: number, catalog: CatalogSummary[], dominant: string[]): FitRow[] {
  const rows: FitRow[] = [];
  for (const kind of POD_KINDS) {
    const spec = PRINT_SPECS.areas[kind];
    const cat = catalog.find((c) => c.kind === kind) ?? null;
    for (const side of SIDES) {
      const f = fitForProduct(artW, artH, kind, side);
      rows.push({
        kind, label: spec.label, side, area_in: [spec[side][0], spec[side][1]],
        full_area_dpi: f.full_area_dpi, sharp_w_in: f.sharp_w_in, verdict: f.verdict, note: f.note,
        catalog: cat ? {
          provider_product_id: cat.provider_product_id,
          colours: cat.colours.map((c) => ({ ...c, faded: looksFaded(dominant, c.hex) })),
          sizes: cat.sizes, cost_from_paise: cat.cost_from_paise,
        } : null,
      });
    }
  }
  return rows;
}

/** Highest verdict, then the biggest print area (a hero chest print on a tee beats a 4 in polo logo). */
export function pickBest(fits: FitRow[]): FitRow | null {
  const usable = fits.filter((f) => f.verdict !== "too_small");
  if (!usable.length) return null;
  return [...usable].sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || b.area_in[0] * b.area_in[1] - a.area_in[0] * a.area_in[1])[0];
}

/** Colours that would not look faded (all colours when every one would). */
export function bestColours(row: FitRow): string[] {
  const cols = row.catalog?.colours ?? [];
  const good = cols.filter((c) => !c.faded).map((c) => c.name);
  return good.length ? good : cols.map((c) => c.name);
}

export function fallbackBestText(row: FitRow | null, artW: number, artH: number, fadedNames: string[]): string {
  if (!row) return `This artwork is ${artW} x ${artH} px, which is too small to print sharp on a full shirt. Upload a larger file to unlock more products.`;
  const shape = artW === artH ? "square" : artW > artH ? "wide" : "tall";
  const where = row.side === "back" ? "back" : "front";
  const verdictText = row.verdict === "great" ? "prints sharp at full size" : row.verdict === "good" ? "prints well at full size" : "is best as a smaller chest print";
  const faded = fadedNames.length ? ` On ${fadedNames.slice(0, 3).join(", ")} it may look faded.` : "";
  return `Your art is ${shape} (${artW} x ${artH} px) and ${verdictText} on the ${row.label} ${where} (${row.full_area_dpi} DPI at full width).${faded}`;
}

// ---------------------------------------------------------------------------
// Placement validation
// ---------------------------------------------------------------------------
export type Placement = {
  kind: PodKind; side: PrintSide; shape: Shape; frame_w_in: number; frame_h_in: number; frame_top_in: number;
  zoom_pct: number; nudge_x_in: number; nudge_y_in: number; print_w_in: number; print_h_in: number; dpi: number;
};
export type PlacementResult = { ok: true; placement: Placement } | { ok: false; status: 400; code: string; message: string; field?: string };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function validatePlacement(raw: unknown): PlacementResult {
  const fail = (code: string, message: string, field?: string): PlacementResult => ({ ok: false, status: 400, code, message, field });
  if (!raw || typeof raw !== "object") return fail("invalid_placement", "Send the placement as an object.", "placement");
  const p = raw as Record<string, unknown>;
  if (!isKind(p.kind)) return fail("invalid_placement", "Pick a product for this placement.", "kind");
  if (!isSide(p.side)) return fail("invalid_placement", "Side must be front or back.", "side");
  if (!(SHAPES as readonly unknown[]).includes(p.shape)) return fail("invalid_placement", "Frame must be none, rect, square or circle.", "shape");
  for (const k of ["frame_w_in", "frame_h_in", "frame_top_in", "zoom_pct", "nudge_x_in", "nudge_y_in", "print_w_in", "print_h_in", "dpi"] as const) {
    if (!finite(p[k])) return fail("invalid_placement", `${k} must be a number.`, k);
  }
  const area = PRINT_SPECS.areas[p.kind][p.side];
  const [aw, ah] = [area[0], area[1]];
  const fw = p.frame_w_in as number, fh = p.frame_h_in as number, ft = p.frame_top_in as number;
  const EPS = 0.05;
  if (fw <= 0 || fh <= 0) return fail("invalid_placement", "The frame must have a size.", "frame_w_in");
  if (fw > aw + EPS || fh > ah + EPS) return fail("outside_print_area", `The frame (${round2(fw)} x ${round2(fh)} in) is bigger than the print area (${aw} x ${ah} in).`, "frame_w_in");
  if (ft < -EPS || ft + fh > ah + EPS) return fail("outside_print_area", "The frame sits outside the print area.", "frame_top_in");
  if ((p.shape === "square" || p.shape === "circle") && Math.abs(fw - fh) > EPS) return fail("invalid_placement", "A square or circle frame must be as tall as it is wide.", "frame_h_in");
  const zoom = p.zoom_pct as number;
  if (zoom < 40 || zoom > 300) return fail("invalid_placement", "Zoom must be between 40% and 300%.", "zoom_pct");
  if (Math.abs(p.nudge_x_in as number) > 20 || Math.abs(p.nudge_y_in as number) > 20) return fail("invalid_placement", "Nudge is out of range.", "nudge_x_in");
  const pw = p.print_w_in as number, ph = p.print_h_in as number;
  if (pw <= 0 || ph <= 0 || pw > aw + EPS || ph > ah + EPS) return fail("outside_print_area", "The print file size does not fit the print area.", "print_w_in");
  const dpi = p.dpi as number;
  if (dpi < LIMITS.minDpi) return fail("too_blurry", `At ${Math.round(dpi)} DPI this would print blurry. Make the art smaller on the shirt or upload a bigger file (minimum ${LIMITS.minDpi} DPI).`, "dpi");
  return {
    ok: true,
    placement: {
      kind: p.kind, side: p.side, shape: p.shape as Shape, frame_w_in: round2(fw), frame_h_in: round2(fh), frame_top_in: round2(Math.max(0, ft)),
      zoom_pct: Math.round(zoom), nudge_x_in: round2(p.nudge_x_in as number), nudge_y_in: round2(p.nudge_y_in as number),
      print_w_in: round2(pw), print_h_in: round2(ph), dpi: Math.round(dpi),
    },
  };
}

/** Where the print file sits on the partner's print area: centred left-to-right, frame_top from the top. */
export function partnerPlacement(p: Placement): { side: PrintSide; width_in: number; height_in: number; top_in: number; left_in: number } {
  const area = PRINT_SPECS.areas[p.kind][p.side];
  return { side: p.side, width_in: p.print_w_in, height_in: p.print_h_in, top_in: p.frame_top_in, left_in: round2(Math.max(0, (area[0] - p.print_w_in) / 2)) };
}

// ---------------------------------------------------------------------------
// Upload checks
// ---------------------------------------------------------------------------
export type ArtChecks = Record<string, unknown> & { w?: number; h?: number; bytes?: number; mime?: string; rgb?: boolean | null; has_alpha?: boolean | null };

export function artChecksFromInfo(info: ImageInfo, bytes: number, fileName: string): ArtChecks {
  return { w: info.w, h: info.h, bytes, mime: info.mime, rgb: info.rgb, has_alpha: info.has_alpha, file_name: fileName };
}

/** Whitelist + clamp the checks the browser measures. Returns the object to merge, or an error message. */
export function cleanBrowserChecks(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "art_checks must be an object." };
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("trimmed_px" in r) {
    const t = r.trimmed_px;
    if (finite(t)) out.trimmed_px = Math.max(0, Math.round(t));
    else if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const nums = ["left", "top", "right", "bottom", "w", "h"].filter((k) => finite(o[k]));
      if (!nums.length) return { ok: false, message: "trimmed_px needs numbers." };
      out.trimmed_px = Object.fromEntries(nums.map((k) => [k, Math.max(0, Math.round(o[k] as number))]));
    } else return { ok: false, message: "trimmed_px must be a number or an object of numbers." };
  }
  if ("soft_edge_pct" in r) {
    if (!finite(r.soft_edge_pct)) return { ok: false, message: "soft_edge_pct must be a number." };
    out.soft_edge_pct = Math.min(100, Math.max(0, round2(r.soft_edge_pct)));
  }
  if ("dominant_colours" in r) {
    if (!Array.isArray(r.dominant_colours)) return { ok: false, message: "dominant_colours must be a list of #rrggbb colours." };
    out.dominant_colours = cleanHexList(r.dominant_colours, 5);
  }
  if ("cmyk_converted" in r) {
    if (typeof r.cmyk_converted !== "boolean") return { ok: false, message: "cmyk_converted must be true or false." };
    out.cmyk_converted = r.cmyk_converted;
  }
  if (!Object.keys(out).length) return { ok: false, message: "Send at least one of trimmed_px, soft_edge_pct, dominant_colours, cmyk_converted." };
  return { ok: true, value: out };
}

export type PrintCheck = { ok: true } | { ok: false; status: number; code: string; message: string };
export function checkPrintFile(info: ImageInfo | null, bytes: number): PrintCheck {
  if (bytes > LIMITS.printBytes) return { ok: false, status: 413, code: "too_large", message: "The print file must be 15 MB or smaller." };
  if (!info || info.mime !== "image/png") return { ok: false, status: 415, code: "unsupported_type", message: "The print file must be a PNG." };
  if (info.w > PRINT_SPECS.max_px || info.h > PRINT_SPECS.max_px) return { ok: false, status: 400, code: "too_big_px", message: `The print file must be at most ${PRINT_SPECS.max_px} x ${PRINT_SPECS.max_px} px (this one is ${info.w} x ${info.h}).` };
  if (!info.has_alpha) return { ok: false, status: 400, code: "no_alpha", message: "The print file must have a see-through (transparent) background outside the frame." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
export type PhotoChecks = { size_ok: boolean; colour_sold: boolean };
export function photoChecks(w: number | null, h: number | null, colour: string | null, soldColours: string[]): PhotoChecks {
  const short = w && h ? Math.min(w, h) : 0;
  const sold = colour ? soldColours.some((c) => c.toLowerCase() === colour.toLowerCase()) : false;
  return { size_ok: short >= LIMITS.photoShortSidePx, colour_sold: sold };
}

export type PhotoLite = { kind: string; colour: string | null; status: string };
export function photoCoverage(soldColours: string[], photos: PhotoLite[]): Array<{ colour: string; photos: number; flat: number }> {
  return soldColours.map((colour) => {
    const same = photos.filter((p) => p.status === "kept" && (p.colour ?? "").toLowerCase() === colour.toLowerCase());
    return { colour, photos: same.filter((p) => p.kind === "model").length, flat: same.filter((p) => p.kind !== "model").length };
  });
}

export type PhotoOrderRow = { id: string; kind: string; colour: string | null; url: string; sort: number; is_main: number; status: string };
const KIND_ORDER: Record<string, number> = { model: 0, flat: 1, closeup: 2 };
/** Shop images: owner's model photos first (main first, then by sort), then plain-shirt pictures, then the close-up. */
export function orderPhotosForShop(photos: PhotoOrderRow[]): PhotoOrderRow[] {
  return photos.filter((p) => p.status === "kept").sort((a, b) =>
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.is_main - a.is_main || a.sort - b.sort || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Colours / prices / copy input
// ---------------------------------------------------------------------------
export type DesignColour = { name: string; hex: string };
export function cleanColours(raw: unknown, catalogHexByName: Map<string, string | null> = new Map()): { ok: true; value: DesignColour[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length > 12) return { ok: false, message: "Choose up to 12 colours." };
  const out: DesignColour[] = [];
  for (const c of raw) {
    const o = typeof c === "string" ? { name: c, hex: catalogHexByName.get(c.toLowerCase()) ?? "" } : (c && typeof c === "object" ? c as Record<string, unknown> : {});
    const name = String(o.name ?? "").replace(/\s+/g, " ").trim();
    let hex = String(o.hex ?? "").trim().toLowerCase();
    if (!hex) hex = catalogHexByName.get(name.toLowerCase()) ?? "";
    if (!name || name.length > 40 || !HEX_RE.test(hex) || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, message: "Each colour needs a unique name and a #rrggbb colour." };
    }
    out.push({ name, hex });
  }
  return { ok: true, value: out };
}

export function cleanPrices(raw: unknown): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "prices must be an object of size to rupees." };
  const out: Record<string, number> = {};
  for (const [size, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (!size || size.length > 12 || !Number.isInteger(n) || n < 1 || n > 100_000) return { ok: false, message: `Price for ${size || "a size"} must be whole rupees, 1 to 1,00,000.` };
    out[size] = n;
  }
  return { ok: true, value: out };
}

export type DesignCopy = { name?: string; description?: string; seo_title?: string; seo_description?: string };
export function cleanCopy(raw: unknown): { ok: true; value: DesignCopy } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "copy must be an object." };
  const r = raw as Record<string, unknown>;
  const out: DesignCopy = {};
  if ("name" in r) { const n = String(r.name ?? "").replace(/\s+/g, " ").trim(); if (n.length < 2 || n.length > 120) return { ok: false, message: "Name must be 2 to 120 characters." }; out.name = n; }
  if ("description" in r) { const d = String(r.description ?? "").trim(); if (d.length > 4000) return { ok: false, message: "Keep the description under 4000 characters." }; out.description = d; }
  if ("seo_title" in r) out.seo_title = String(r.seo_title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if ("seo_description" in r) out.seo_description = String(r.seo_description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Copy draft (Gemini output -> clean fields, with a deterministic fallback)
// ---------------------------------------------------------------------------
export function fallbackCopy(name: string, productLabel: string, colours: string[]): { name: string; description: string; seo_title: string } {
  const cols = colours.length ? ` Available in ${colours.slice(0, 6).join(", ")}.` : "";
  return {
    name: name.trim().slice(0, 120) || "New design",
    description: `${name.trim() || "This design"}, printed to order on a ${productLabel.toLowerCase()}. [FABRIC]${cols} Made for you after you order; free shipping across India.`,
    seo_title: `${name.trim()} ${productLabel}`.replace(/\s+/g, " ").trim().slice(0, 70),
  };
}

/** Pull {name, description, seo_title} out of a model reply (JSON, possibly fenced). null when unusable. */
export function parseCopyReply(text: string): { name: string; description: string; seo_title: string } | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const name = String(o.name ?? "").replace(/\s+/g, " ").trim();
    const description = String(o.description ?? "").trim();
    const seo_title = String(o.seo_title ?? "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 120 || !description || description.length > 4000) return null;
    return { name, description, seo_title: (seo_title || name).slice(0, 70) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Publish planning
// ---------------------------------------------------------------------------
export type PublishVariantRow = { colour: string; size: string; variant: CatalogVariant };
export type ResolvedVariants = { colours: DesignColour[]; sizes: string[]; rows: PublishVariantRow[]; missing: string[] };

/** Chosen colours x priced sizes, matched (case-insensitive) against the catalogue product's variants. */
export function resolveVariants(chosen: DesignColour[], product: Pick<CatalogProduct, "variants">, prices: Record<string, number>): ResolvedVariants {
  const sizes = sortSizes(Object.keys(prices).filter((s) => prices[s] > 0));
  const rows: PublishVariantRow[] = [];
  const missing: string[] = [];
  const coloursUsed: DesignColour[] = [];
  const sizesUsed = new Set<string>();
  for (const c of chosen) {
    let any = false;
    for (const s of sizes) {
      const v = product.variants.find((x) => x.colour.toLowerCase() === c.name.toLowerCase() && x.size.toLowerCase() === s.toLowerCase());
      if (v) { rows.push({ colour: c.name, size: s, variant: v }); sizesUsed.add(s); any = true; } else missing.push(`${c.name} ${s}`);
    }
    if (any) coloursUsed.push(c);
  }
  return { colours: coloursUsed, sizes: sortSizes([...sizesUsed]), rows, missing };
}

const S_TO_XL = new Set(["S", "M", "L", "XL"]);
/** Shop checkout prices per product, not per size: use the owner's S-XL price (lowest of them), else the lowest price. */
export function shopPrice(prices: Record<string, number>, sizes: string[]): { price: number; uniform: boolean } {
  const all = sizes.map((s) => prices[s]).filter((n) => typeof n === "number" && n > 0);
  if (!all.length) return { price: 0, uniform: true };
  const core = sizes.filter((s) => S_TO_XL.has(s.toUpperCase())).map((s) => prices[s]).filter((n) => n > 0);
  return { price: Math.min(...(core.length ? core : all)), uniform: new Set(all).size === 1 };
}

export const printTypeFor = (p: Placement): "Chest print" | "Big front print" | "Back print" =>
  p.side === "back" ? "Back print" : p.print_w_in >= 8 ? "Big front print" : "Chest print";
export const audienceFor = (kind: string): "Adults" | "Kids" => (kind === "kids_tee" || kind === "toddler_tee" ? "Kids" : "Adults");

export type StepKey = "upload_design" | "create_listing" | "variant_map" | "shop_product" | "slots";
export type StepStatus = "done" | "skipped" | "failed" | "pending";
export type StepResult = { key: StepKey; label: string; status: StepStatus; note: string };
export const STEP_KEYS: StepKey[] = ["upload_design", "create_listing", "variant_map", "shop_product", "slots"];

export type StoredSteps = { version: number; steps: Partial<Record<StepKey, { status: StepStatus; note: string; ref?: string | null; refs?: Record<string, string> | null }>> };
/** Progress from an earlier publish counts only for the same print-file version. */
export function resumeSteps(raw: unknown, version: number): StoredSteps {
  const s = raw && typeof raw === "object" ? (raw as Partial<StoredSteps>) : null;
  if (!s || s.version !== version || !s.steps || typeof s.steps !== "object") return { version, steps: {} };
  return { version, steps: s.steps };
}

/** Steps that did not run (an earlier one failed) are listed as pending so the page can show the whole list. */
export function pendingSteps(results: StepResult[], labels: Record<StepKey, string>): StepResult[] {
  const have = new Set(results.map((r) => r.key));
  return [...results, ...STEP_KEYS.filter((k) => !have.has(k)).map((key) => ({ key, label: labels[key], status: "pending" as const, note: "Not run yet." }))];
}

export const SHOP_SLOTS_FLAGS = { new_arrivals: "is_new", bestsellers: "is_bestseller" } as const;
export function cleanSlots(raw: unknown, allowed: readonly string[]): { ok: true; value: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "slots must be a list." };
  const out = [...new Set(raw.map((s) => String(s)))];
  const bad = out.find((s) => !allowed.includes(s));
  return bad ? { ok: false, message: `Unknown slot: ${bad}.` } : { ok: true, value: out };
}

export function slugForSku(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "x";
}
export const variantSku = (designId: string, version: number, colour: string, size: string, given?: string) =>
  given && given.trim() ? given.trim() : `${designId}-v${version}-${slugForSku(colour)}-${slugForSku(size)}`;

export function productsLabel(products: Array<{ kind: string; side: string }>): string {
  if (!products.length) return "Not chosen yet";
  return products.map((p) => `${isKind(p.kind) ? PRINT_SPECS.areas[p.kind].label : p.kind} ${p.side}`).join(", ");
}

export function cleanProducts(raw: unknown): { ok: true; value: Array<{ kind: PodKind; provider_product_id: string; side: PrintSide }> } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length > 12) return { ok: false, message: "Send up to 12 products." };
  const out: Array<{ kind: PodKind; provider_product_id: string; side: PrintSide }> = [];
  for (const p of raw) {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const pid = String(o.provider_product_id ?? "").trim();
    if (!isKind(o.kind) || !isSide(o.side) || !pid || pid.length > 80) return { ok: false, message: "Each product needs a kind, a side and a provider_product_id." };
    if (out.some((x) => x.kind === o.kind && x.side === o.side && x.provider_product_id === pid)) return { ok: false, message: "Each product and side can be chosen once." };
    out.push({ kind: o.kind, provider_product_id: pid, side: o.side });
  }
  return { ok: true, value: out };
}
