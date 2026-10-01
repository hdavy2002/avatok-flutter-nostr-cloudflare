// [SAATHUM-SHOP-API-CATALOG-1 2026-10-01] Shop money + catalogue helpers. PURE: no env, no D1.
// Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md sections 2, 3, 4.1, 4.4. API-ORDERS imports computeShopQuote.
import { computeGstRupees } from "./saathum_checkout_logic";

// ---------------------------------------------------------------------------
// Row + wire types
// ---------------------------------------------------------------------------
export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  collection_id: string | null;
  description: string;
  fit: string;
  print_type: string;
  audience: string;
  price_rupees: number;
  mrp_rupees: number | null;
  colours_json: string;
  sizes_json: string;
  images_json: string;
  badge: string;
  status: string;
  printrove_ref: string | null;
  sold_count: number;
  seo_title: string | null;
  seo_description: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CouponRow {
  code: string;
  kind: string; // 'pct' | 'flat'
  value: number;
  min_order_rupees: number;
  max_uses: number | null;
  used_count: number;
  valid_until: number | null;
  active: number;
  created_at?: number;
  updated_at?: number;
}

export type ShopColour = { name: string; hex: string };
export type ShopImage = { url: string; label: string };

export type ShopCartItem = { product_id: string; colour: string; size: string; qty: number };

export type ShopQuoteLine = {
  product_id: string;
  slug: string;
  name: string;
  colour: string;
  size: string;
  qty: number;
  unit_rupees: number;
  amount_rupees: number;
  image_url: string | null;
};

export type ShopQuote = {
  lines: ShopQuoteLine[];
  subtotal_rupees: number;
  discount_rupees: number;
  coupon_code: string | null;
  taxable_rupees: number;
  gst_rate_pct: number;
  gst_rupees: number;
  shipping_rupees: 0;
  total_rupees: number;
};

export type ShopCard = {
  id: string;
  slug: string;
  name: string;
  price_rupees: number;
  mrp_rupees: number | null;
  off_pct: number | null;
  badge: "" | "new" | "best" | "sale";
  colours: ShopColour[];
  sizes: string[];
  image_url: string | null;
  collection: { slug: string; name: string } | null;
};

// ---------------------------------------------------------------------------
// JSON column parsers (never throw)
// ---------------------------------------------------------------------------
function parseArray(s: unknown): unknown[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function parseColours(s: unknown): ShopColour[] {
  const out: ShopColour[] = [];
  for (const c of parseArray(s)) {
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.name === "string" && o.name) out.push({ name: o.name, hex: typeof o.hex === "string" ? o.hex : "#cccccc" });
    }
  }
  return out;
}

export function parseSizes(s: unknown): string[] {
  return parseArray(s).filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function parseImages(s: unknown): ShopImage[] {
  const out: ShopImage[] = [];
  for (const i of parseArray(s)) {
    if (i && typeof i === "object") {
      const o = i as Record<string, unknown>;
      if (typeof o.url === "string" && o.url) out.push({ url: o.url, label: typeof o.label === "string" ? o.label : "" });
    }
  }
  return out;
}

export function slugify(input: string): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function offPct(price: number, mrp: number | null): number | null {
  if (mrp === null || !Number.isFinite(mrp) || mrp <= price || price <= 0) return null;
  return Math.round(((mrp - price) / mrp) * 100);
}

export function toShopCard(row: ProductRow, collection?: { slug: string; name: string } | null): ShopCard {
  const images = parseImages(row.images_json);
  const mrp = row.mrp_rupees === null || row.mrp_rupees === undefined ? null : Number(row.mrp_rupees);
  const badge = (["new", "best", "sale"] as const).find((b) => b === row.badge) ?? "";
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    price_rupees: Number(row.price_rupees),
    mrp_rupees: mrp,
    off_pct: offPct(Number(row.price_rupees), mrp),
    badge,
    colours: parseColours(row.colours_json),
    sizes: parseSizes(row.sizes_json),
    image_url: images[0]?.url ?? null,
    collection: collection ?? null,
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------
export const SHOP_LIMITS = { maxLines: 20, maxQty: 10 } as const;

type QuoteFail = { ok: false; error: string; field?: string; line?: number };

export function computeShopQuote(input: {
  items: ShopCartItem[];
  products: Map<string, ProductRow>;
  coupon: CouponRow | null;
  gstRatePct: number;
  now: number;
}): { ok: true; quote: ShopQuote } | QuoteFail {
  const { items, products, coupon, now } = input;
  if (!Array.isArray(items) || items.length < 1) return { ok: false, error: "empty_cart", field: "items" };
  if (items.length > SHOP_LIMITS.maxLines) return { ok: false, error: "too_many_lines", field: "items" };

  const merged = new Map<string, ShopQuoteLine>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Partial<ShopCartItem> | null;
    if (!it || typeof it !== "object") return { ok: false, error: "invalid_item", line: i };
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > SHOP_LIMITS.maxQty) return { ok: false, error: "invalid_qty", field: "qty", line: i };
    const p = typeof it.product_id === "string" ? products.get(it.product_id) : undefined;
    if (!p || p.status !== "live") return { ok: false, error: "product_unavailable", field: "product_id", line: i };
    const colours = parseColours(p.colours_json);
    const sizes = parseSizes(p.sizes_json);
    const colour = typeof it.colour === "string" ? it.colour : "";
    const size = typeof it.size === "string" ? it.size : "";
    if (!colours.some((c) => c.name === colour)) return { ok: false, error: "invalid_colour", field: "colour", line: i };
    if (!sizes.includes(size)) return { ok: false, error: "invalid_size", field: "size", line: i };
    const key = `${p.id}\u0000${colour}\u0000${size}`;
    const existing = merged.get(key);
    const unit = Number(p.price_rupees);
    if (existing) {
      existing.qty += qty;
      if (existing.qty > SHOP_LIMITS.maxQty) return { ok: false, error: "invalid_qty", field: "qty", line: i };
      existing.amount_rupees = existing.qty * unit;
    } else {
      merged.set(key, {
        product_id: p.id, slug: p.slug, name: p.name, colour, size, qty,
        unit_rupees: unit, amount_rupees: qty * unit,
        image_url: parseImages(p.images_json)[0]?.url ?? null,
      });
    }
  }
  const lines = [...merged.values()];
  const subtotal = lines.reduce((s, l) => s + l.amount_rupees, 0);

  let discount = 0;
  let couponCode: string | null = null;
  if (coupon) {
    if (!coupon.active) return { ok: false, error: "coupon_invalid", field: "coupon" };
    if (coupon.valid_until !== null && coupon.valid_until !== undefined && Number(coupon.valid_until) <= now) return { ok: false, error: "coupon_expired", field: "coupon" };
    if (coupon.max_uses !== null && coupon.max_uses !== undefined && Number(coupon.used_count) >= Number(coupon.max_uses)) return { ok: false, error: "coupon_invalid", field: "coupon" };
    if (subtotal < Number(coupon.min_order_rupees ?? 0)) return { ok: false, error: "coupon_min_order", field: "coupon" };
    if (coupon.kind === "pct") discount = Math.round((subtotal * Number(coupon.value)) / 100);
    else if (coupon.kind === "flat") discount = Math.min(Number(coupon.value), subtotal - 1);
    else return { ok: false, error: "coupon_invalid", field: "coupon" };
    discount = Math.max(0, Math.min(discount, subtotal - 1));
    couponCode = coupon.code;
  }

  const taxable = subtotal - discount;
  const rate = Number.isFinite(input.gstRatePct) && input.gstRatePct > 0 ? input.gstRatePct : 0;
  const gst = computeGstRupees(taxable, rate);
  const total = taxable + gst;
  if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, error: "invalid_total" };
  return {
    ok: true,
    quote: {
      lines, subtotal_rupees: subtotal, discount_rupees: discount, coupon_code: couponCode,
      taxable_rupees: taxable, gst_rate_pct: rate, gst_rupees: gst, shipping_rupees: 0, total_rupees: total,
    },
  };
}

// ---------------------------------------------------------------------------
// Admin product input validation
// ---------------------------------------------------------------------------
export const PRODUCT_LIMITS = {
  nameMin: 2, nameMax: 120, descMax: 4000, maxColours: 12, maxSizes: 12, maxImages: 10,
  priceMin: 1, priceMax: 100_000,
} as const;
export const FITS = ["Regular", "Oversized"] as const;
export const PRINT_TYPES = ["Chest print", "Big front print", "Back print", "Embroidery"] as const;
export const AUDIENCES = ["Adults", "Kids"] as const;
export const BADGES = ["", "new", "best", "sale"] as const;
export const STATUSES = ["live", "draft", "hidden", "archived"] as const;
export const SLOTS = ["hero_hotspots", "new_arrivals", "featured_banner", "bestsellers", "sale", "also_like"] as const;

/** An https image URL (the /upload/public result), or a site-relative /assets/ path (same rule as chadhava). */
export function isValidImageUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > 500) return false;
  if (v.startsWith("/assets/")) return true;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

export type FieldError = { field: string; message: string };

export type ProductInput = {
  name?: string;
  slug?: string;
  collection_id?: string | null;
  description?: string;
  fit?: string;
  print_type?: string;
  audience?: string;
  price_rupees?: number;
  mrp_rupees?: number | null;
  colours?: ShopColour[];
  sizes?: string[];
  images?: ShopImage[];
  badge?: string;
  status?: string;
  printrove_ref?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Validate admin product JSON. `partial` = PUT-style (only keys present are checked). Never throws. */
export function normalizeProductInput(body: Record<string, unknown>, opts: { partial: boolean }): { value: ProductInput; errors: FieldError[] } {
  const v: ProductInput = {};
  const errors: FieldError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const want = (k: string) => has(k) || !opts.partial;
  const L = PRODUCT_LIMITS;

  if (want("name")) {
    const n = String(body.name ?? "").replace(/\s+/g, " ").trim();
    if (n.length < L.nameMin || n.length > L.nameMax) errors.push({ field: "name", message: `Name must be ${L.nameMin}–${L.nameMax} characters.` });
    else v.name = n;
  }
  if (has("slug") && body.slug !== null && body.slug !== "") {
    const s = slugify(String(body.slug));
    if (!s) errors.push({ field: "slug", message: "Slug must contain letters or numbers." });
    else v.slug = s;
  }
  if (has("collection_id")) {
    if (body.collection_id === null || body.collection_id === "") v.collection_id = null;
    else if (typeof body.collection_id !== "string" || body.collection_id.length > 64) errors.push({ field: "collection_id", message: "Pick a valid collection." });
    else v.collection_id = body.collection_id;
  }
  if (has("description")) {
    const d = String(body.description ?? "").trim();
    if (d.length > L.descMax) errors.push({ field: "description", message: `Keep the description under ${L.descMax} characters.` });
    else v.description = d;
  }
  if (has("fit")) {
    if (!(FITS as readonly string[]).includes(String(body.fit))) errors.push({ field: "fit", message: "Fit must be Regular or Oversized." });
    else v.fit = String(body.fit);
  }
  if (has("print_type")) {
    if (!(PRINT_TYPES as readonly string[]).includes(String(body.print_type))) errors.push({ field: "print_type", message: "Choose a valid print type." });
    else v.print_type = String(body.print_type);
  }
  if (has("audience")) {
    if (!(AUDIENCES as readonly string[]).includes(String(body.audience))) errors.push({ field: "audience", message: "Audience must be Adults or Kids." });
    else v.audience = String(body.audience);
  }
  if (want("price_rupees")) {
    const p = Number(body.price_rupees);
    if (!Number.isInteger(p) || p < L.priceMin || p > L.priceMax) errors.push({ field: "price_rupees", message: `Price must be a whole number of rupees, ₹${L.priceMin}–₹${L.priceMax.toLocaleString("en-IN")}.` });
    else v.price_rupees = p;
  }
  if (has("mrp_rupees")) {
    if (body.mrp_rupees === null || body.mrp_rupees === "") v.mrp_rupees = null;
    else {
      const m = Number(body.mrp_rupees);
      if (!Number.isInteger(m) || m < L.priceMin || m > L.priceMax) errors.push({ field: "mrp_rupees", message: "MRP must be a whole number of rupees." });
      else v.mrp_rupees = m;
    }
  }
  if (want("colours")) {
    const arr = body.colours;
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > L.maxColours) errors.push({ field: "colours", message: `Add 1–${L.maxColours} colours.` });
    else {
      const out: ShopColour[] = [];
      let bad = false;
      for (const c of arr) {
        const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const name = String(o.name ?? "").trim();
        const hex = String(o.hex ?? "").trim();
        if (!name || name.length > 40 || !HEX_RE.test(hex) || out.some((x) => x.name === name)) { bad = true; break; }
        out.push({ name, hex });
      }
      if (bad) errors.push({ field: "colours", message: "Each colour needs a unique name and a #rrggbb hex." });
      else v.colours = out;
    }
  }
  if (want("sizes")) {
    const arr = body.sizes;
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > L.maxSizes) errors.push({ field: "sizes", message: `Add 1–${L.maxSizes} sizes.` });
    else {
      const out = arr.map((s) => String(s ?? "").trim());
      if (out.some((s) => !s || s.length > 12) || new Set(out).size !== out.length) errors.push({ field: "sizes", message: "Sizes must be unique and short (e.g. S, M, 2-3Y)." });
      else v.sizes = out;
    }
  }
  if (has("images")) {
    const arr = body.images;
    if (!Array.isArray(arr) || arr.length > L.maxImages) errors.push({ field: "images", message: `Up to ${L.maxImages} photos.` });
    else {
      const out: ShopImage[] = [];
      let bad = false;
      for (const i of arr) {
        const o = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
        const label = String(o.label ?? "").trim().slice(0, 40);
        if (!isValidImageUrl(o.url)) { bad = true; break; }
        out.push({ url: String(o.url), label });
      }
      if (bad) errors.push({ field: "images", message: "Each photo must be an uploaded https image (or a site /assets/ path)." });
      else v.images = out;
    }
  }
  if (has("badge")) {
    const b = body.badge === null ? "" : String(body.badge);
    if (!(BADGES as readonly string[]).includes(b)) errors.push({ field: "badge", message: "Badge must be none, new, best or sale." });
    else v.badge = b;
  }
  if (has("status")) {
    if (!(STATUSES as readonly string[]).includes(String(body.status))) errors.push({ field: "status", message: "Status must be live, draft, hidden or archived." });
    else v.status = String(body.status);
  }
  if (has("printrove_ref")) {
    const r = body.printrove_ref === null ? "" : String(body.printrove_ref).trim();
    if (r.length > 100) errors.push({ field: "printrove_ref", message: "Printrove reference is too long." });
    else v.printrove_ref = r || null;
  }
  for (const k of ["seo_title", "seo_description"] as const) {
    if (has(k)) {
      const t = body[k] === null ? "" : String(body[k]).trim();
      const max = k === "seo_title" ? 120 : 300;
      if (t.length > max) errors.push({ field: k, message: `Keep ${k.replace("_", " ")} under ${max} characters.` });
      else v[k] = t || null;
    }
  }
  if (v.mrp_rupees !== undefined && v.mrp_rupees !== null && v.price_rupees !== undefined && v.mrp_rupees < v.price_rupees) {
    errors.push({ field: "mrp_rupees", message: "MRP cannot be lower than the price." });
  }
  return { value: v, errors };
}
