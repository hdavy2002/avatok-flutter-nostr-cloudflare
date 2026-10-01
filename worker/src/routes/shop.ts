// [SAATHUM-SHOP-API-CATALOG-1 2026-10-01] Public shop catalogue API.
// Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md section 4.1. Tables: migrations/2026-10-01-saathum-shop.sql.
//
//   GET  /api/shop/home
//   GET  /api/shop/products?collection=&colour=&size=&fit=&print=&for=&min=&max=&sort=&tag=&ids=&q=
//   GET  /api/shop/products/:slug
//   POST /api/shop/quote
//   /api/shop/orders*, /api/shop/my-orders  -> delegated to shop_orders.ts (API-ORDERS)
//
// Only status='live' products are ever public. GETs are cached 60 s.
import type { Env } from "../types";
import { json } from "../util";
import { trackException } from "../hooks";
import { readConfig } from "./config";
import { shopOrdersRoute } from "./shop_orders";
import { PAGE_KEY, parseRecord, resolvePage, type Resolved } from "../lib/shop_page";
import {
  computeShopQuote, parseColours, parseImages, parseSizes, toShopCard,
  type CouponRow, type ProductRow, type ShopCard, type ShopCartItem,
} from "../lib/shop_logic";

const APP = "saathum";
const CACHE = { "cache-control": "public, max-age=60" };
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

const QUOTE_MESSAGES: Record<string, string> = {
  empty_cart: "Your cart is empty.",
  too_many_lines: "That is too many different items in one order.",
  invalid_item: "One of the cart items is not valid.",
  invalid_qty: "Quantity must be between 1 and 10 per item.",
  product_unavailable: "One of the items is no longer available.",
  invalid_colour: "That colour is not available for this T-shirt.",
  invalid_size: "That size is not available for this T-shirt.",
  coupon_invalid: "That coupon code is not valid.",
  coupon_expired: "That coupon has expired.",
  coupon_min_order: "Your order is below the minimum for this coupon.",
  invalid_total: "This order total is invalid.",
};

type CollectionRow = { id: string; slug: string; name: string; blurb: string; image_url: string | null; sort: number; active: number };
type SlotRow = { slot: string; product_id: string; sort: number; until_at: number | null };

function isMissingTable(e: unknown): boolean {
  return /no such table/i.test(String((e as { message?: string })?.message ?? e));
}

async function guarded(env: Env, route: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingTable(e)) return err(503, "shop_unavailable", "The shop is not available yet.");
    await trackException(env, e, { route, handled: true, app_name: APP });
    return err(500, "internal", "Something went wrong loading the shop.");
  }
}

function parseSetting<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? (v as T) : fallback; } catch { return fallback; }
}

async function loadLive(env: Env): Promise<ProductRow[]> {
  const r = await env.DB_META.prepare("SELECT * FROM shop_products WHERE status='live'").all<ProductRow>();
  return r.results ?? [];
}

async function loadCollections(env: Env): Promise<CollectionRow[]> {
  const r = await env.DB_META.prepare(
    "SELECT id, slug, name, blurb, image_url, sort, active FROM shop_collections WHERE active=1 ORDER BY sort ASC, name ASC",
  ).all<CollectionRow>();
  return r.results ?? [];
}

function collectionMap(cols: CollectionRow[]): Map<string, { slug: string; name: string }> {
  return new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }]));
}

function cardOf(p: ProductRow, cmap: Map<string, { slug: string; name: string }>): ShopCard {
  return toShopCard(p, p.collection_id ? cmap.get(p.collection_id) ?? null : null);
}

/** Product ids of a slot, ordered, expired entries dropped. */
async function slotIds(env: Env, slot: string, now: number): Promise<string[]> {
  const r = await env.DB_META.prepare(
    "SELECT slot, product_id, sort, until_at FROM shop_slots WHERE slot=?1 AND (until_at IS NULL OR until_at>?2) ORDER BY sort ASC",
  ).bind(slot, now).all<SlotRow>();
  return (r.results ?? []).map((x) => x.product_id);
}

const byNewest = (a: ProductRow, b: ProductRow) => Number(b.created_at) - Number(a.created_at);
const byBest = (a: ProductRow, b: ProductRow) => Number(b.sold_count) - Number(a.sold_count) || byNewest(a, b);

function pick(ids: string[], live: Map<string, ProductRow>, limit: number): ProductRow[] {
  const out: ProductRow[] = [];
  for (const id of ids) {
    const p = live.get(id);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/shop/home
// ---------------------------------------------------------------------------
async function home(env: Env): Promise<Response> {
  const now = Date.now();
  const [liveRows, cols, settingsRows, newIds, bestIds] = await Promise.all([
    loadLive(env),
    loadCollections(env),
    env.DB_META.prepare("SELECT key, value_json FROM shop_settings WHERE key IN ('hero','featured_banner','page_home')").all<{ key: string; value_json: string }>(),
    slotIds(env, "new_arrivals", now),
    slotIds(env, "bestsellers", now),
  ]);
  const live = new Map(liveRows.map((p) => [p.id, p]));
  const cmap = collectionMap(cols);
  const settings = new Map((settingsRows.results ?? []).map((s) => [s.key, s.value_json]));

  const hero = parseSetting<Record<string, unknown>>(settings.get("hero"), {});
  const rawSpots = Array.isArray(hero.hotspots) ? (hero.hotspots as Array<Record<string, unknown>>) : [];
  const hotspots: Array<{ x: number; y: number; product: ShopCard }> = [];
  for (const h of rawSpots) {
    const p = typeof h?.product_id === "string" ? live.get(h.product_id) : undefined;
    if (p) hotspots.push({ x: Number(h.x), y: Number(h.y), product: cardOf(p, cmap) });
  }

  const counts = new Map<string, number>();
  for (const p of liveRows) if (p.collection_id) counts.set(p.collection_id, (counts.get(p.collection_id) ?? 0) + 1);

  const newPicked = pick(newIds, live, 4);
  const newArrivals = newPicked.length ? newPicked : [...liveRows].sort(byNewest).slice(0, 4);
  const bestPicked = pick(bestIds, live, 4);
  const bestsellers = bestPicked.length ? bestPicked : [...liveRows].sort(byBest).slice(0, 4);

  const fb = parseSetting<Record<string, unknown> | null>(settings.get("featured_banner"), null);
  const fbProduct = fb && typeof fb.product_id === "string" ? live.get(fb.product_id) : undefined;
  const featured = fb && fbProduct ? {
    eyebrow: String(fb.eyebrow ?? ""), title: String(fb.title ?? ""), text: String(fb.text ?? ""),
    cta_label: String(fb.cta_label ?? ""), image_url: typeof fb.image_url === "string" && fb.image_url ? fb.image_url : null,
    product: cardOf(fbProduct, cmap),
  } : null;

  // [SAATHUM-SHOP-EDITOR-1] The owner's edited page (null = the site renders its built-in default from the fields below).
  const page = parseRecord(settings.get(PAGE_KEY)).published;
  const resolved: Resolved = page
    ? resolvePage(page, { live: liveRows, cols, newIds, bestIds })
    : { products: {}, rails: {} };

  return json({
    page,
    resolved,
    hero: { ...hero, hotspots },
    collections: cols.map((c) => ({ id: c.id, slug: c.slug, name: c.name, blurb: c.blurb, image_url: c.image_url, count: counts.get(c.id) ?? 0 })),
    new_arrivals: newArrivals.map((p) => cardOf(p, cmap)),
    featured_banner: featured,
    bestsellers: bestsellers.map((p) => cardOf(p, cmap)),
  }, 200, CACHE);
}

// ---------------------------------------------------------------------------
// GET /api/shop/products
// ---------------------------------------------------------------------------
const list = (v: string | null): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const lc = (a: string[]) => a.map((s) => s.toLowerCase());

function tally<T extends string>(items: T[]): Array<{ value: T; count: number }> {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].map(([value, count]) => ({ value, count }));
}

async function products(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  const [liveRows, cols] = await Promise.all([loadLive(env), loadCollections(env)]);
  const cmap = collectionMap(cols);
  const colBySlug = new Map(cols.map((c) => [c.slug.toLowerCase(), c.id]));

  const fCollections = lc(list(q.get("collection")));
  const fColours = lc(list(q.get("colour")));
  const fSizes = lc(list(q.get("size")));
  const fFits = lc(list(q.get("fit")));
  const fPrints = lc(list(q.get("print")));
  const fFor = lc(list(q.get("for")));
  const fIds = list(q.get("ids"));
  const fTag = (q.get("tag") ?? "").toLowerCase();
  const text = (q.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const minP = q.get("min") !== null && q.get("min") !== "" ? Number(q.get("min")) : null;
  const maxP = q.get("max") !== null && q.get("max") !== "" ? Number(q.get("max")) : null;
  const sort = q.get("sort") ?? "feat";

  const wantedCols = new Set(fCollections.map((s) => colBySlug.get(s)).filter((x): x is string => !!x));
  let rows = liveRows.filter((p) => {
    if (fIds.length && !fIds.includes(p.id)) return false;
    if (fCollections.length && !(p.collection_id && wantedCols.has(p.collection_id))) return false;
    if (fColours.length && !parseColoursNames(p).some((n) => fColours.includes(n))) return false;
    if (fSizes.length && !parseSizesLower(p).some((n) => fSizes.includes(n))) return false;
    if (fFits.length && !fFits.includes(p.fit.toLowerCase())) return false;
    if (fPrints.length && !fPrints.includes(p.print_type.toLowerCase())) return false;
    if (fFor.length && !fFor.includes(p.audience.toLowerCase())) return false;
    if (fTag && p.badge !== fTag) return false;
    if (minP !== null && Number.isFinite(minP) && p.price_rupees < minP) return false;
    if (maxP !== null && Number.isFinite(maxP) && p.price_rupees > maxP) return false;
    if (text) {
      const cn = p.collection_id ? cmap.get(p.collection_id)?.name ?? "" : "";
      if (!`${p.name} ${p.description} ${cn}`.toLowerCase().includes(text)) return false;
    }
    return true;
  });

  if (sort === "new") rows.sort(byNewest);
  else if (sort === "lo") rows.sort((a, b) => a.price_rupees - b.price_rupees || byNewest(a, b));
  else if (sort === "hi") rows.sort((a, b) => b.price_rupees - a.price_rupees || byNewest(a, b));
  else rows.sort(byBest); // 'best' and 'feat'
  const total = rows.length;
  rows = rows.slice(0, 200);

  // Facets are over ALL live products (as the approved mockup shows), not the filtered set.
  const colourMap = new Map<string, { name: string; hex: string; count: number }>();
  const sizeCount = new Map<string, number>();
  const colCount = new Map<string, number>();
  for (const p of liveRows) {
    for (const c of colourListOf(p)) {
      const e = colourMap.get(c.name);
      if (e) e.count++; else colourMap.set(c.name, { name: c.name, hex: c.hex, count: 1 });
    }
    for (const s of sizeListOf(p)) sizeCount.set(s, (sizeCount.get(s) ?? 0) + 1);
    if (p.collection_id) colCount.set(p.collection_id, (colCount.get(p.collection_id) ?? 0) + 1);
  }
  const prices = liveRows.map((p) => Number(p.price_rupees));

  return json({
    items: rows.map((p) => cardOf(p, cmap)),
    total,
    facets: {
      collections: cols.map((c) => ({ slug: c.slug, name: c.name, count: colCount.get(c.id) ?? 0 })),
      colours: [...colourMap.values()],
      sizes: [...sizeCount.entries()].map(([size, count]) => ({ size, count })),
      fits: tally(liveRows.map((p) => p.fit)),
      prints: tally(liveRows.map((p) => p.print_type)),
      audiences: tally(liveRows.map((p) => p.audience)),
      price: { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 },
    },
  }, 200, CACHE);
}

const colourListOf = (p: ProductRow) => parseColours(p.colours_json);
const sizeListOf = (p: ProductRow) => parseSizes(p.sizes_json);
const parseColoursNames = (p: ProductRow) => colourListOf(p).map((c) => c.name.toLowerCase());
const parseSizesLower = (p: ProductRow) => sizeListOf(p).map((s) => s.toLowerCase());

// ---------------------------------------------------------------------------
// GET /api/shop/products/:slug
// ---------------------------------------------------------------------------
async function productBySlug(env: Env, slug: string): Promise<Response> {
  const row = await env.DB_META.prepare("SELECT * FROM shop_products WHERE slug=?1 AND status='live'").bind(slug).first<ProductRow>();
  if (!row) return err(404, "not_found", "That T-shirt was not found.");
  const [liveRows, cols] = await Promise.all([loadLive(env), loadCollections(env)]);
  const cmap = collectionMap(cols);
  const live = new Map(liveRows.map((p) => [p.id, p]));

  const slotted = pick((await slotIds(env, "also_like", Date.now())).filter((id) => id !== row.id), live, 4);
  const chosen: ProductRow[] = [...slotted];
  if (chosen.length < 4) {
    const rest = liveRows.filter((p) => p.id !== row.id && !chosen.includes(p));
    const same = rest.filter((p) => row.collection_id && p.collection_id === row.collection_id).sort(byBest);
    for (const p of [...same, ...rest.filter((p) => !same.includes(p)).sort(byBest)]) {
      if (chosen.length >= 4) break;
      chosen.push(p);
    }
  }

  const card = cardOf(row, cmap);
  return json({
    product: {
      ...card,
      description: row.description,
      fit: row.fit,
      print_type: row.print_type,
      audience: row.audience,
      images: parseImages(row.images_json),
      seo_title: row.seo_title,
      seo_description: row.seo_description,
    },
    also_like: chosen.map((p) => cardOf(p, cmap)),
  }, 200, CACHE);
}

// ---------------------------------------------------------------------------
// POST /api/shop/quote
// ---------------------------------------------------------------------------
async function quote(req: Request, env: Env): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 16_384) return err(400, "invalid_request", "That request is too large.");
    const v = JSON.parse(text || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
    b = v as Record<string, unknown>;
  } catch { return err(400, "invalid_request", "Send the cart as JSON."); }

  const items = Array.isArray(b.items) ? (b.items as ShopCartItem[]) : [];
  const ids = [...new Set(items.map((i) => (i && typeof i.product_id === "string" ? i.product_id : "")).filter(Boolean))].slice(0, 25);
  const map = new Map<string, ProductRow>();
  if (ids.length) {
    const r = await env.DB_META.prepare(
      `SELECT * FROM shop_products WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...ids).all<ProductRow>();
    for (const p of r.results ?? []) map.set(p.id, p);
  }

  let coupon: CouponRow | null = null;
  const code = typeof b.coupon === "string" ? b.coupon.trim().toUpperCase().slice(0, 40) : "";
  if (code) {
    coupon = await env.DB_META.prepare("SELECT * FROM shop_coupons WHERE code=?1").bind(code).first<CouponRow>();
    if (!coupon) return err(400, "coupon_invalid", QUOTE_MESSAGES.coupon_invalid, { field: "coupon" });
  }

  const cfg = await readConfig(env);
  const result = computeShopQuote({
    items, products: map, coupon,
    gstRatePct: cfg.saathumGstEnabled === true ? Number(cfg.gstRatePct) : 0,
    now: Date.now(),
  });
  if (!result.ok) {
    return err(400, result.error, QUOTE_MESSAGES[result.error] ?? "This cart is not valid.", {
      ...(result.line !== undefined ? { line: result.line } : {}),
      ...(result.field ? { field: result.field } : {}),
    });
  }
  return json({ quote: result.quote });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function shopRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p === "/api/shop/my-orders" || p === "/api/shop/orders" || p.startsWith("/api/shop/orders/")) {
    return shopOrdersRoute(req, env, p);
  }
  const url = new URL(req.url);
  if (req.method === "GET" && p === "/api/shop/home") return guarded(env, "shop.home", () => home(env));
  if (req.method === "GET" && p === "/api/shop/products") return guarded(env, "shop.products", () => products(env, url));
  if (req.method === "GET" && p.startsWith("/api/shop/products/")) {
    const slug = decodeURIComponent(p.slice("/api/shop/products/".length));
    if (!slug || slug.includes("/") || slug.length > 120) return err(404, "not_found", "That T-shirt was not found.");
    return guarded(env, "shop.product", () => productBySlug(env, slug));
  }
  if (req.method === "POST" && p === "/api/shop/quote") return guarded(env, "shop.quote", () => quote(req, env));
  return null;
}
