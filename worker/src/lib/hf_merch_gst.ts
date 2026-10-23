// [HF-MERCH-GST-1 2026-10-23] Per-category GST rate + HSN + price-cap table for merch (rule HF-MERCH-17). Pure: no I/O.
// The PLATFORM is the seller, so the rate depends on WHAT is sold: clothing up to Rs 2,500 a piece is 5%; every other category defaults to 18% with the HSN left
// for the CA to confirm. The table lives in the string setting hfMerchGstTable (JSON, admin-editable). Rate + HSN + "cap applies" are FROZEN into each product's
// merch_json and into each order snapshot, so a later edit never touches either. A product/order made before this table existed uses the flat
// hfMerchGstRateBps / hfMerchHsn fallback (5%, 6109, cap applies).

export type GstRow = {
  /** HSN printed on the invoice; "" = not set yet (the CA still has to confirm it). */
  hsn: string;
  /** GST included in the fan price, basis points. */
  rateBps: number;
  /** true: the per-piece fan-price cap (hfMerchPriceCapRupees) applies to this category (it is what keeps the 5% clothing rate legal). */
  capApplies: boolean;
};
export type GstTable = Record<string, GstRow>;
/** What gets frozen into a product / order. */
export type FrozenGst = GstRow & { category?: string };

export const GST_RATE_MAX_BPS = 2800;
export const GST_CONFIRM_NOTE = "confirm with CA";

/** Keyed by the STUDIO-2 category slugs (lib/hf_merch_families.ts CATEGORY_ORDER). Clothing 5% (<= the cap); everything else 18%, HSN blank. */
export const DEFAULT_GST_TABLE: GstTable = {
  tshirts: { hsn: "6109", rateBps: 500, capApplies: true },
  hoodies: { hsn: "6110", rateBps: 500, capApplies: true },
  bottoms: { hsn: "", rateBps: 500, capApplies: true },
  jackets: { hsn: "", rateBps: 500, capApplies: true },
  accessories: { hsn: "", rateBps: 1800, capApplies: false },
  home: { hsn: "", rateBps: 1800, capApplies: false },
  phone: { hsn: "", rateBps: 1800, capApplies: false },
  other: { hsn: "", rateBps: 1800, capApplies: false },
};
export const GST_CATEGORY_SLUGS: readonly string[] = Object.keys(DEFAULT_GST_TABLE);
export const HSN_RE = /^\d{4,8}$/;

/** A row that is not a plain, in-range object is rejected (the default for that category stands). */
function cleanRow(v: unknown): GstRow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const rate = typeof o.rateBps === "number" ? o.rateBps : typeof o.rateBps === "string" && o.rateBps.trim() !== "" ? Number(o.rateBps) : NaN;
  if (!Number.isFinite(rate) || Math.trunc(rate) !== rate || rate < 0 || rate > GST_RATE_MAX_BPS) return null;
  const hsn = typeof o.hsn === "string" ? o.hsn.trim() : o.hsn == null ? "" : null;
  if (hsn === null || (hsn !== "" && !HSN_RE.test(hsn))) return null;
  if (typeof o.capApplies !== "boolean") return null;
  return { hsn, rateBps: rate, capApplies: o.capApplies };
}

/** Parse the stored setting (JSON string or object). Always returns a full table: defaults overlaid with every valid row; junk is ignored, never thrown. */
export function parseGstTable(raw: unknown): GstTable {
  const out: GstTable = {};
  for (const [k, v] of Object.entries(DEFAULT_GST_TABLE)) out[k] = { ...v };
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = raw.trim() ? JSON.parse(raw) : null; } catch { obj = null; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [slug, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(slug)) continue;
    const row = cleanRow(v);
    if (row) out[slug] = row;
  }
  return out;
}

/** Admin PUT validation: every row must be valid (unlike parseGstTable, which forgives). Returns the clean table or a message. */
export function validateGstTable(raw: unknown): { ok: true; table: GstTable } | { ok: false; message: string } {
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return { ok: false, message: "The GST table is not valid JSON." }; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, message: "The GST table must be an object keyed by category." };
  const out: GstTable = {};
  for (const [slug, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(slug)) return { ok: false, message: `"${slug}" is not a valid category.` };
    const row = cleanRow(v);
    if (!row) return { ok: false, message: `Category "${slug}": GST must be 0 to ${GST_RATE_MAX_BPS / 100}%, HSN 4 to 8 digits or blank, and "cap applies" yes or no.` };
    out[slug] = row;
  }
  for (const slug of GST_CATEGORY_SLUGS) if (!out[slug]) out[slug] = { ...DEFAULT_GST_TABLE[slug] };
  return { ok: true, table: out };
}

/** The row for a category; a category the table does not know (or none) falls back to the flat default (rate + HSN settings, cap applies). */
export function gstRowFor(table: GstTable, category: string | null | undefined, fallback: { rateBps: number; hsn: string }): FrozenGst {
  const r = category ? table[category] : undefined;
  if (r) return { ...r, category: category as string };
  return { hsn: fallback.hsn, rateBps: fallback.rateBps, capApplies: true };
}

/** True when the HSN still needs the CA (blank). */
export const needsHsnConfirm = (row: Pick<GstRow, "hsn">): boolean => row.hsn === "";

/** What a frozen block (product merch_json.gst or order money) says; absent/invalid -> the flat fallback. */
export function frozenOrFallback(f: Partial<FrozenGst> | null | undefined, fallback: { rateBps: number; hsn: string }): FrozenGst {
  if (f && typeof f.rateBps === "number" && f.rateBps >= 0 && f.rateBps <= GST_RATE_MAX_BPS) {
    return { rateBps: f.rateBps, hsn: typeof f.hsn === "string" ? f.hsn : fallback.hsn, capApplies: f.capApplies !== false, ...(f.category ? { category: f.category } : {}) };
  }
  return { hsn: fallback.hsn, rateBps: fallback.rateBps, capApplies: true };
}
