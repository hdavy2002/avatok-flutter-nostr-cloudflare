// [SAATHUM-SHOP-EDITOR-1 2026-10-01] The editable /shop home page: validation, default, and server-side resolution.
//
// The page is Puck data ({ root, content[] }), one item per block, stored in shop_settings key `page_home` as
//   { published: PageData|null, published_at, published_by, history: [{data, at, by}] (last 5), draft: PageData|null, draft_at }
// Routes: admin2_shop_catalog.ts (/api/admin/v2/shop/page*) and shop.ts (GET /api/shop/home adds `page` + `resolved`).
//
// NOTE FOR AI:
//  - buildDefaultPage() MIRRORS web/src/islands/shop/blocks/defaultPage.ts (the worker cannot import web code).
//    worker/test/shop_page.test.ts imports the web file and fails if the two disagree — change both together.
//  - Stored data is a WHITELIST rebuild of what the editor sent: unknown block types are rejected, unknown props dropped,
//    strings stripped of tags and length-capped. Text is rendered by React (escaped) on the live page, never as HTML.
//  - Product / collection references are by id / slug and are resolved at render time; one that has since been archived or
//    hidden simply does not render (it never breaks the page).
import type { Env } from "../types";
import { flagOf, hasDiscount, isValidImageUrl, toShopCard, type FieldError, type ProductRow, type ShopCard } from "./shop_logic";

export const PAGE_KEY = "page_home";
export const PAGE_MAX_BYTES = 200_000;
export const PAGE_HISTORY_MAX = 5;
const MAX_BLOCKS = 40;

export const BLOCK_TYPES = ["ShopHero", "CollectionGrid", "ProductRail", "FeaturedBanner", "PhotoBanner", "TextSection"] as const;
export const RAIL_SOURCES = ["new_arrivals", "bestsellers", "sale", "collection", "manual"] as const;

export type PageItem = { type: string; props: Record<string, unknown> & { id: string } };
export type PageData = { root: { props: Record<string, unknown> }; content: PageItem[]; zones?: Record<string, unknown> };
export type PageRecord = {
  published: PageData | null; published_at: number | null; published_by: string | null;
  history: Array<{ data: PageData; at: number; by: string | null }>;
  draft: PageData | null; draft_at: number | null;
};
export type Resolved = { products: Record<string, ShopCard>; rails: Record<string, ShopCard[]> };

export const emptyRecord = (): PageRecord => ({ published: null, published_at: null, published_by: null, history: [], draft: null, draft_at: null });

export function parseRecord(raw: string | null | undefined): PageRecord {
  const base = emptyRecord();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<PageRecord> | null;
    if (!v || typeof v !== "object") return base;
    return {
      published: isPage(v.published) ? v.published : null,
      published_at: typeof v.published_at === "number" ? v.published_at : null,
      published_by: typeof v.published_by === "string" ? v.published_by : null,
      history: Array.isArray(v.history)
        ? v.history.filter((h) => h && isPage(h.data)).slice(0, PAGE_HISTORY_MAX).map((h) => ({ data: h.data, at: Number(h.at) || 0, by: typeof h.by === "string" ? h.by : null }))
        : [],
      draft: isPage(v.draft) ? v.draft : null,
      draft_at: typeof v.draft_at === "number" ? v.draft_at : null,
    };
  } catch { return base; }
}

function isPage(v: unknown): v is PageData {
  return !!v && typeof v === "object" && Array.isArray((v as PageData).content);
}

// ---------------------------------------------------------------------------
// Validation (whitelist rebuild)
// ---------------------------------------------------------------------------
type Errs = FieldError[];

function clean(v: unknown, max: number, multiline = false): string {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = multiline ? s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : s.replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}

function normalizeProps(type: string, p: Record<string, unknown>, at: string, errs: Errs): Record<string, unknown> {
  const img = (k: string): string => {
    const v = p[k];
    if (v === undefined || v === null || v === "") return "";
    if (!isValidImageUrl(v)) { errs.push({ field: `${at}.${k}`, message: "The image must be an uploaded https image (or a site /assets/ path)." }); return ""; }
    return String(v);
  };
  const href = (k: string): string => {
    const s = clean(p[k], 500);
    if (!s) return "";
    if ((s.startsWith("/") && !s.startsWith("//")) || /^https:\/\//i.test(s)) return s;
    errs.push({ field: `${at}.${k}`, message: "A link must start with / or https://." });
    return "";
  };
  const arr = (k: string, max: number): unknown[] => {
    const v = p[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { errs.push({ field: `${at}.${k}`, message: "Expected a list." }); return []; }
    if (v.length > max) errs.push({ field: `${at}.${k}`, message: `Up to ${max} items.` });
    return v.slice(0, max);
  };
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  switch (type) {
    case "ShopHero":
      return {
        image: img("image"), eyebrow: clean(p.eyebrow, 80), title: clean(p.title, 120), titleEm: clean(p.titleEm, 60), lead: clean(p.lead, 300),
        ctaLabel: clean(p.ctaLabel, 40), secondCollection: clean(p.secondCollection, 80),
        ticks: arr("ticks", 6).map((t) => ({ text: clean(o(t).text, 80) })).filter((t) => t.text),
        promise: arr("promise", 3).map((q) => ({ title: clean(o(q).title, 60), sub: clean(o(q).sub, 120) })).filter((q) => q.title),
        promiseLinkLabel: clean(p.promiseLinkLabel, 60),
        hotspots: arr("hotspots", 8).map((h) => {
          const r = o(h); const x = Number(r.x); const y = Number(r.y);
          const ok = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
          if (!ok) errs.push({ field: `${at}.hotspots`, message: "Each hotspot needs x and y between 0 and 100." });
          return { product: clean(r.product, 64), x: ok ? Math.round(x * 10) / 10 : 50, y: ok ? Math.round(y * 10) / 10 : 50 };
        }).filter((h) => h.product),
      };
    case "CollectionGrid":
      return {
        title: clean(p.title, 80), subtitle: clean(p.subtitle, 200), linkLabel: clean(p.linkLabel, 40),
        tiles: arr("tiles", 12).map((t) => ({ collection: clean(o(t).collection, 80), image: (() => { const v = o(t).image; if (!v) return ""; if (isValidImageUrl(v)) return String(v); errs.push({ field: `${at}.tiles`, message: "The image must be an uploaded https image (or a site /assets/ path)." }); return ""; })(), label: clean(o(t).label, 60), blurb: clean(o(t).blurb, 80) })).filter((t) => t.collection),
      };
    case "ProductRail": {
      const source = (RAIL_SOURCES as readonly string[]).includes(String(p.source)) ? String(p.source) : "new_arrivals";
      const n = Math.round(Number(p.count));
      return {
        title: clean(p.title, 80), subtitle: clean(p.subtitle, 200), linkLabel: clean(p.linkLabel, 40), linkHref: href("linkHref"),
        source, collection: clean(p.collection, 80),
        products: arr("products", 24).map((x) => ({ product: clean(o(x).product, 64) })).filter((x) => x.product),
        count: Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : 4,
        hideWhenEmpty: p.hideWhenEmpty === true,
        emptyTitle: clean(p.emptyTitle, 80), emptyText: clean(p.emptyText, 200), emptyButtonLabel: clean(p.emptyButtonLabel, 40), emptyButtonHref: href("emptyButtonHref"),
      };
    }
    case "FeaturedBanner":
      return { eyebrow: clean(p.eyebrow, 60), title: clean(p.title, 120), text: clean(p.text, 300), ctaLabel: clean(p.ctaLabel, 40), ctaHref: href("ctaHref"), product: clean(p.product, 64), image: img("image") };
    case "PhotoBanner":
      return {
        image: img("image"), heading: clean(p.heading, 120), text: clean(p.text, 300), ctaLabel: clean(p.ctaLabel, 40), ctaHref: href("ctaHref"),
        height: p.height === "short" || p.height === "tall" ? p.height : "medium",
      };
    default: // TextSection
      return { heading: clean(p.heading, 120), text: clean(p.text, 1000, true) };
  }
}

/** Validate + rebuild a page from the editor's JSON. Never throws. */
export function validatePage(raw: unknown): { data: PageData } | { errors: Errs } {
  const errs: Errs = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [{ field: "data", message: "Send the page as an object." }] };
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { return { errors: [{ field: "data", message: "The page is not valid JSON." }] }; }
  if (size > PAGE_MAX_BYTES) return { errors: [{ field: "data", message: "This page is too large (200 KB limit)." }] };
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return { errors: [{ field: "content", message: "The page needs a content list." }] };
  if (content.length > MAX_BLOCKS) return { errors: [{ field: "content", message: `A page can hold up to ${MAX_BLOCKS} blocks.` }] };
  const seen = new Set<string>();
  const out: PageItem[] = [];
  content.forEach((it, i) => {
    const at = `content[${i}]`;
    const item = (it && typeof it === "object" ? it : {}) as { type?: unknown; props?: unknown };
    const type = String(item.type);
    if (!(BLOCK_TYPES as readonly string[]).includes(type)) { errs.push({ field: `${at}.type`, message: `Unknown block type "${clean(type, 30)}".` }); return; }
    const props = (item.props && typeof item.props === "object" ? item.props : {}) as Record<string, unknown>;
    const id = typeof props.id === "string" ? props.id : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id)) { errs.push({ field: `${at}.id`, message: "Every block needs a unique id." }); return; }
    seen.add(id);
    out.push({ type, props: { id, ...normalizeProps(type, props, at, errs) } });
  });
  if (errs.length) return { errors: errs };
  return { data: { root: { props: {} }, content: out, zones: {} } };
}

// ---------------------------------------------------------------------------
// Default page — MIRROR of web/src/islands/shop/blocks/defaultPage.ts (parity test enforces it)
// ---------------------------------------------------------------------------
export type DefaultHero = {
  image_url?: string | null; eyebrow?: string; title?: string; title_em?: string; lead?: string; cta_label?: string;
  second_cta_collection?: string | null; ticks?: string[]; promise?: { title: string; sub: string }[];
  hotspots?: { product_id: string; x: number; y: number }[];
};
export type DefaultBanner = { product_id: string; eyebrow?: string; title?: string; text?: string; cta_label?: string; image_url?: string | null };

export function buildDefaultPage(i: { brandName: string; hero?: DefaultHero | null; banner?: DefaultBanner | null }): PageData {
  const hero = i.hero ?? {};
  const b = i.banner;
  const content: PageItem[] = [
    {
      type: "ShopHero",
      props: {
        id: "hero",
        image: hero.image_url || "",
        eyebrow: hero.eyebrow || `The ${i.brandName} Shop · New season`,
        title: hero.title || "Wear your faith,",
        titleEm: hero.title_em ?? (hero.title ? "" : "softly."),
        lead: hero.lead || "Pure cotton T-shirts with Mahadev, Krishna, lotus and Himalayan temple art — designed by us, printed to order in India and delivered free, pan India.",
        ctaLabel: hero.cta_label || "Shop all T-shirts →",
        secondCollection: hero.second_cta_collection || "",
        ticks: (hero.ticks?.length ? hero.ticks : ["100% cotton, 180 GSM", "Sizes S to 3XL + kids", "Pay by UPI"]).map((text) => ({ text })),
        promise: hero.promise?.length ? hero.promise.map((p) => ({ title: p.title, sub: p.sub })) : [
          { title: "Free shipping", sub: "Pan India, every order" },
          { title: "Printed to order", sub: "Made just for you" },
          { title: "Pay by any UPI app", sub: "Scan the QR, done" },
        ],
        promiseLinkLabel: "Tap a dot to shop the stack →",
        hotspots: (hero.hotspots ?? []).filter((s) => s?.product_id).map((s) => ({ product: s.product_id, x: Number(s.x), y: Number(s.y) })),
      },
    },
    {
      type: "CollectionGrid",
      props: { id: "collections", title: "Shop by collection", subtitle: "Every design starts from a story — a deity, a temple, a mantra.", linkLabel: "All collections", tiles: [] },
    },
    {
      type: "ProductRail",
      props: {
        id: "new-arrivals", title: "New arrivals", subtitle: "Fresh off the press this week.", linkLabel: "View all", linkHref: "/shop/all?tag=new",
        source: "new_arrivals", collection: "", products: [], count: 4, hideWhenEmpty: false,
        emptyTitle: "New T-shirts are coming soon", emptyText: "We are printing our first designs. Please check back shortly.",
        emptyButtonLabel: "Explore pujas and havans", emptyButtonHref: "/marketplace",
      },
    },
    {
      type: "FeaturedBanner",
      props: {
        id: "banner", eyebrow: b?.eyebrow || "Featured · Navratri drop", title: b?.title || "The Lotus & Diya tee — light for every home.",
        text: b?.text || "Hand-drawn folk lotus with a lit diya at its heart. Off-white cotton, soft red and gold ink.",
        ctaLabel: b?.cta_label || "See the tee →", ctaHref: "/shop/all", product: b?.product_id || "", image: b?.image_url || "",
      },
    },
    {
      type: "ProductRail",
      props: {
        id: "bestsellers", title: "Bestsellers", subtitle: "What devotees are wearing the most.", linkLabel: "View all", linkHref: "/shop/all?tag=best",
        source: "bestsellers", collection: "", products: [], count: 4, hideWhenEmpty: true,
        emptyTitle: "", emptyText: "", emptyButtonLabel: "", emptyButtonHref: "",
      },
    },
  ];
  return { root: { props: {} }, content, zones: {} };
}

// ---------------------------------------------------------------------------
// Resolution: what the blocks need to render on the server
// ---------------------------------------------------------------------------
export type CollectionRow = { id: string; slug: string; name: string; blurb: string; image_url: string | null; sort: number; active: number };
export type Snapshot = { live: ProductRow[]; cols: CollectionRow[] };

const byNewest = (a: ProductRow, b: ProductRow) => Number(b.created_at) - Number(a.created_at);
const byBest = (a: ProductRow, b: ProductRow) => Number(b.sold_count) - Number(a.sold_count) || byNewest(a, b);
const discount = (p: ProductRow) => (p.mrp_rupees && Number(p.mrp_rupees) > Number(p.price_rupees) ? (Number(p.mrp_rupees) - Number(p.price_rupees)) / Number(p.mrp_rupees) : 0);

function pickIds(ids: string[], live: Map<string, ProductRow>, limit: number): ProductRow[] {
  const out: ProductRow[] = [];
  for (const id of ids) {
    const p = live.get(id);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export function resolvePage(data: PageData, snap: Snapshot): Resolved {
  const live = new Map(snap.live.map((p) => [p.id, p]));
  const cmap = new Map(snap.cols.map((c) => [c.id, { slug: c.slug, name: c.name }]));
  const colBySlug = new Map(snap.cols.map((c) => [c.slug, c.id]));
  const card = (p: ProductRow) => toShopCard(p, p.collection_id ? cmap.get(p.collection_id) ?? null : null);
  const products: Record<string, ShopCard> = {};
  const add = (id: unknown) => { const p = typeof id === "string" ? live.get(id) : undefined; if (p) products[p.id] = card(p); };
  const rails: Record<string, ShopCard[]> = {};

  for (const it of data.content) {
    const p = it.props as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (it.type === "ShopHero") for (const h of p.hotspots ?? []) add(h.product);
    else if (it.type === "FeaturedBanner") add(p.product);
    else if (it.type === "ProductRail") {
      const n = Math.min(12, Math.max(1, Number(p.count) || 4));
      let rows: ProductRow[] = [];
      switch (p.source) {
        // [SAATHUM-SHOP-EDITOR-2] The product flags are the only source: New arrivals = flagged new (newest first),
        // Bestsellers = flagged bestseller (most sold first). Nothing flagged = an empty row (the live page shows its coming-soon box / hides it).
        case "new_arrivals":
          rows = snap.live.filter((x) => flagOf(x.is_new)).sort(byNewest).slice(0, n);
          break;
        case "bestsellers":
          rows = snap.live.filter((x) => flagOf(x.is_bestseller)).sort(byBest).slice(0, n);
          break;
        case "sale":
          rows = snap.live.filter((x) => x.badge === "sale" || hasDiscount(x)).sort((a, b) => discount(b) - discount(a) || byNewest(a, b)).slice(0, n);
          break;
        case "collection": {
          const cid = colBySlug.get(String(p.collection));
          rows = cid ? snap.live.filter((x) => x.collection_id === cid).sort(byBest).slice(0, n) : [];
          break;
        }
        default:
          rows = pickIds((p.products ?? []).map((x: { product: string }) => x.product), live, n);
      }
      rails[String(p.id)] = rows.map(card);
    }
  }
  return { products, rails };
}

export async function loadSnapshot(env: Env): Promise<Snapshot> {
  const [liveR, colR] = await Promise.all([
    env.DB_META.prepare("SELECT * FROM shop_products WHERE status='live'").all<ProductRow>(),
    env.DB_META.prepare("SELECT id, slug, name, blurb, image_url, sort, active FROM shop_collections WHERE active=1 ORDER BY sort ASC, name ASC").all<CollectionRow>(),
  ]);
  return { live: liveR.results ?? [], cols: colR.results ?? [] };
}

export async function readPageRecord(env: Env): Promise<PageRecord> {
  const r = await env.DB_META.prepare("SELECT value_json FROM shop_settings WHERE key=?1").bind(PAGE_KEY).first<{ value_json: string }>();
  return parseRecord(r?.value_json);
}

export async function writePageRecord(env: Env, rec: PageRecord): Promise<void> {
  await env.DB_META.prepare(
    "INSERT INTO shop_settings (key, value_json, updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
  ).bind(PAGE_KEY, JSON.stringify(rec), Date.now()).run();
}
