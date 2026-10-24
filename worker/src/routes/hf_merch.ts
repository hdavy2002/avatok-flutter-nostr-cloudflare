// [HF-MERCH-CORE-1 2026-10-23] Influencer merch shop: influencer, public and fan routes. Spec: Specs/SPEC-2026-10-23-HF-MERCH.md section 5.
// Every response is { ok:true, ... } or { ok:false, error, message }. Everything is dark behind hfMerchEnabled (404 not_enabled);
// checkout is also behind hfMerchCheckoutEnabled (403 checkout_off). Admin routes live in routes/admin2_merch.ts.
//   Influencer: GET catalog | GET quote | POST art | GET ai | POST ai/generate | DELETE ai/pictures/:artId | POST art/:id/remove-bg | GET art/:id/file | POST print-file | POST mockup | POST/GET products | PATCH/DELETE products/:id | GET orders(/:id) | GET summary
//   Public:     GET public/:host | GET public/:host/:product | GET pincode/:pin | GET sitemap
//   Fan:        POST checkout | GET my-orders(/:id) | POST my-orders/:id/problem(-photo) | GET addresses | DELETE addresses/:id
//   Gateway:    POST webhook/cashfree
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, requireVerifiedWhatsApp } from "../authz";
import { rateLimit } from "../money";
import { metaDb } from "../db/shard";
import { BRAND } from "../lib/brand";
import { isClosing, CLOSING_MESSAGE } from "../lib/hf_exit";
import { resolveGateway } from "../lib/payments/registry";
import { getPodProvider } from "../lib/pod";
import { sha256Hex } from "../util";
import { IMAGE_EXT, parseImageInfo } from "../lib/studio_logic";
import { reportWindowOpen, type ShopOrderRow } from "../lib/shop_orders_logic";
import { alertOwnerShopProblem } from "../lib/shop_notify";
import { appendShopEvent } from "./shop_orders";
import { maskOrderForSeller, assertNoSellerLeak } from "../lib/hf_merch_mask";
import { fanStatusOf, parseJson, groupIdOf, isMerchGroupId, type MerchSnapshot } from "../lib/hf_merch_types";
import { legacyShippingPaise, merchCatalog, quoteBases } from "../lib/hf_merch_catalog";
import { gstForCategory, maxMarkupForBase, type MerchCfg } from "../lib/hf_merch_math";
import { categoryOf } from "../lib/hf_merch_families";
import {
  deleteAddress, getFanOrder, getGroupRows, getSellerTax, setSellerTax, GSTIN_RE, getProductBySlug, getProduct, getSellerOrder, hostBySlug, hostByUid, listAddresses, listFanOrders, listLiveProductsForSeller, listSellerOrders,
  listSellerProducts, productMerch, productShape, gstCtxOf, type GstCtx, sellerEarnings, sellerOrderCounts, sellerProductCounts, shopSlugFor, sitemapRows, type MerchHost, type MerchProductRow,
} from "../lib/hf_merch_store";
import {
  MERCH_QTY_MAX, confirmCashfreeRefund, confirmCashfreeRefundsForGroup, merchCfg, reconcileCashfreeOrder, startMerchCheckout, type FlowFail,
} from "../lib/hf_merch_flow";
import { startMerchBagCheckout, MERCH_BAG_MAX_LINES } from "../lib/hf_merch_group"; // [HF-CHANNEL-CORE-1]
import { createMerchProduct, deleteMerchProduct, patchMerchProduct, saveMerchArt, saveMerchMockup, saveMerchPrintFile, MERCH_ART_MAX_BYTES, type PFail } from "../lib/hf_merch_products";
import { merchFail, merchTrack, snapOf } from "../lib/hf_merch_notify";
import { AI_UNAVAILABLE, aiState, aiTableOk, deleteAiPicture, generateAiPicture, removeBackground } from "../lib/hf_merch_ai";
import { merchPublicCategory } from "../lib/hf_merch_public_category"; // [HF-CHANNEL-CORE-1]

const APP = "hf_merch";
const SELLER_STATUSES = ["new", "processing", "shipped", "delivered", "cancelled"];
const POLL_GAP_MS = 4000;
const PROBLEM_WINDOW_HOURS = 48;

export const out = (body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response =>
  json({ ok: true, ...body }, status, { "cache-control": "private, no-store", ...headers });
export const bad = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response =>
  json({ ok: false, error, message, ...extra }, status, { "cache-control": "no-store" });
const failOf = (f: FlowFail | PFail): Response => bad(f.status, f.error, f.message, f.extra ?? {});

async function readJson(req: Request, max = 20000): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > max) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
async function readBytes(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}
/** Header file names must be ASCII-safe (HTTP header trap): decode %-escapes, then keep it printable. */
const fileNameOf = (req: Request): string => {
  const raw = req.headers.get("x-file-name") ?? "art";
  let s = raw; try { s = decodeURIComponent(raw); } catch { /* keep raw */ }
  return s.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "art";
};

type SellerCtx = { uid: string; host: MerchHost };

/** Influencer gate: signed in and a live host. */
async function sellerCtx(req: Request, env: Env): Promise<SellerCtx | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, u.error === "auth not configured" ? "unavailable" : "unauthorized", "Please sign in.");
  const host = await hostByUid(env, u.uid);
  if (!host || host.status !== "live") return bad(403, "not_a_host", "Merch is for approved hosts.");
  return { uid: u.uid, host };
}

// ---------------------------------------------------------------------------
// Influencer
// ---------------------------------------------------------------------------
async function catalogRoute(env: Env): Promise<Response> {
  const { cfg } = await merchCfg(env);
  const c = await merchCatalog(env, cfg);
  if (!c.ok) return bad(503, c.error, c.message);
  // [HF-MERCH-GST-1] priceCapPaise / gstRateBps are top-level (the cap and the flat fallback rate); every item carries its own category gstRateBps / hsn / capApplies and every size
  // its maxMarkupRupees (null when the category has no cap; the "up to" size here, re-quoted exactly by /quote).
  const items = c.items;
  return out({ items, shippingPaise: c.shippingPaise, bufferPaise: c.bufferPaise, minMarkupRupees: cfg.minMarkupRupees, platformShareBps: cfg.platformShareBps, holdDays: cfg.holdDays, priceCapPaise: cfg.priceCapPaise, gstRateBps: cfg.gstRateBps }, 200, { "cache-control": "private, max-age=300" });
}

/** Extension: live base price for the chosen colours and print size (the studio asks this while the influencer resizes). */
async function quoteRoute(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { cfg } = await merchCfg(env);
  const side = q.get("side") === "back" ? "back" : "front";
  const r = await quoteBases(env, cfg, {
    catalogId: q.get("catalogId") ?? "", colours: (q.get("colours") ?? "").split(",").map((s) => s.trim()).filter(Boolean), side,
    wIn: Number(q.get("w")), hIn: Number(q.get("h")), sizes: ((l) => (l.length ? l : undefined))((q.get("sizes") ?? "").split(",").map((s) => s.trim()).filter(Boolean)), // [HF-MERCH-QUOTE-SIZES-1] no sizes = all sizes ([] used to filter every size out)
  });
  if (!r.ok) return bad(r.error === "catalog_unavailable" ? 503 : 400, r.error, r.message);
  const shippingPaise = Math.max(0, Math.round((r.shippingRupees ?? 0) * 100));
  const gst = gstForCategory(cfg, r.product ? categoryOf(r.product.kind).slug : null); // [HF-MERCH-GST-1] this product's category rate; maxMarkupRupees is null where no cap applies
  return out({
    sizes: r.sizes.map((s) => ({ size: s.size, basePaise: s.baseUnitPaise, baseRupees: s.baseUnitPaise / 100, printingPaise: s.printingPaise, shippingPaise: s.shippingPaise, maxMarkupRupees: gst.capApplies ? maxMarkupForBase(s.baseUnitPaise, cfg.priceCapPaise) : null })),
    shippingPaise, bufferPaise: cfg.baseBufferRupees * 100, priceCapPaise: gst.capApplies ? cfg.priceCapPaise : null, gstRateBps: gst.rateBps, hsn: gst.hsn, capApplies: gst.capApplies,
  });
}

async function artRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const limited = await rateLimit(env, `merch:art:${s.uid}`, 40, 3600); if (limited) return limited;
  const bytes = await readBytes(req, MERCH_ART_MAX_BYTES);
  if (!bytes) return bad(413, "too_large", "The art must be 15 MB or smaller.");
  const r = await saveMerchArt(env, s.uid, bytes, (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), fileNameOf(req));
  return r.ok ? out({ artId: r.artId, url: r.url, width: r.width, height: r.height, checks: r.checks }) : failOf(r);
}
async function printFileRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const artId = (req.headers.get("x-art-id") ?? "").trim();
  if (!/^dsn-[a-f0-9]{8}$/.test(artId)) return bad(400, "art_required", "Send the art id in the x-art-id header.");
  const limited = await rateLimit(env, `merch:print:${s.uid}`, 60, 3600); if (limited) return limited;
  const bytes = await readBytes(req, 15 * 1024 * 1024);
  if (!bytes) return bad(413, "too_large", "The print file must be 15 MB or smaller.");
  const r = await saveMerchPrintFile(env, s.uid, artId, bytes);
  // [HF-MERCH-ART-REUSE-1] artId is the design the client must use from now on (a fresh copy when the art was already on a product).
  return r.ok ? out({ printFileId: r.printFileId, artId: r.printFileId, forkedFrom: r.forkedFrom ?? null, url: r.url, width: r.width, height: r.height }) : failOf(r);
}
async function mockupRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const limited = await rateLimit(env, `merch:mockup:${s.uid}`, 60, 3600); if (limited) return limited;
  const bytes = await readBytes(req, 3 * 1024 * 1024);
  if (!bytes) return bad(413, "too_large", "The picture must be 3 MB or smaller.");
  const r = await saveMerchMockup(env, s.uid, bytes);
  return r.ok ? out({ url: r.url }) : failOf(r);
}

// [HF-MERCH-STUDIO-2] AI pictures and the background remover. Logic lives in lib/hf_merch_ai.ts.
async function aiStateRoute(env: Env, s: SellerCtx): Promise<Response> {
  if (!(await aiTableOk(env))) { const f = AI_UNAVAILABLE(); return bad(f.status, f.error, f.message); }
  return out(await aiState(env, s.uid));
}
async function aiGenerateRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const limited = await rateLimit(env, `merch:ai:${s.uid}`, 30, 3600); if (limited) return limited;
  const r = await generateAiPicture(env, s.uid, await readJson(req, 8000));
  return r.ok ? out(r.body) : failOf(r);
}
/** [HF-MERCH-STUDIO-2] The influencer's own art bytes with CORS, so the browser studio can draw it on a canvas (the public media bucket sends no CORS headers). */
async function artFileRoute(env: Env, s: SellerCtx, artId: string): Promise<Response> {
  if (!/^dsn-[a-f0-9]{8}$/.test(artId)) return bad(400, "invalid_art", "That art id is not valid.");
  const d = await metaDb(env).prepare("SELECT art_key, art_mime FROM studio_designs WHERE id=?1 AND created_by=?2 AND step='merch'").bind(artId, s.uid)
    .first<{ art_key: string | null; art_mime: string | null }>();
  if (!d?.art_key) return bad(404, "not_found", "That picture was not found.");
  const obj = await env.DIGITAL.get(d.art_key);
  if (!obj) return bad(404, "not_found", "That picture was not found.");
  return new Response(obj.body, { headers: { "content-type": d.art_mime || "image/png", "cache-control": "private, max-age=3600", "access-control-allow-origin": "*" } });
}
async function aiDeleteRoute(env: Env, s: SellerCtx, artId: string): Promise<Response> {
  const r = await deleteAiPicture(env, s.uid, artId);
  return r.ok ? out({ removed: r.removed }) : failOf(r);
}
async function removeBgRoute(env: Env, s: SellerCtx, artId: string): Promise<Response> {
  const limited = await rateLimit(env, `merch:bgrm:${s.uid}`, 60, 3600); if (limited) return limited;
  const r = await removeBackground(env, s.uid, artId);
  return r.ok ? out({ art: r.art }) : failOf(r);
}

/** Products made before the breakdown was frozen need today's reference shipping to show a split; fetched only when one is present. */
async function shipFor(env: Env, rows: MerchProductRow[]): Promise<number> {
  return rows.some((r) => (productMerch(r)?.sizes ?? []).some((x) => typeof x.shippingPaise !== "number")) ? legacyShippingPaise(env) : 0;
}
async function productDto(env: Env, row: MerchProductRow, host: MerchHost, shareBps: number, gctx?: GstCtx) {
  return productShape(row, host, shareBps, await shipFor(env, [row]), gctx);
}

async function createProductRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const limited = await rateLimit(env, `merch:create:${s.uid}`, 30, 3600); if (limited) return limited;
  const { cfg, flags } = await merchCfg(env);
  const b = await readJson(req);
  const r = await createMerchProduct(env, cfg, { productReview: flags.productReview }, s.host, b);
  if (!r.ok) return failOf(r);
  return out({ product: await productDto(env, r.product, s.host, cfg.platformShareBps, gstCtxOf(cfg)), gstRateBps: cfg.gstRateBps, priceCapPaise: cfg.priceCapPaise }, 201);
}
async function listProductsRoute(env: Env, s: SellerCtx): Promise<Response> {
  const { cfg } = await merchCfg(env);
  const rows = await listSellerProducts(env, s.uid);
  const ship = await shipFor(env, rows);
  return out({ products: rows.map((r) => productShape(r, s.host, cfg.platformShareBps, ship, gstCtxOf(cfg))), gstRateBps: cfg.gstRateBps, priceCapPaise: cfg.priceCapPaise });
}
async function patchProductRoute(req: Request, env: Env, s: SellerCtx, id: string): Promise<Response> {
  const { cfg } = await merchCfg(env);
  const r = await patchMerchProduct(env, cfg, s.host, id, await readJson(req));
  return r.ok ? out({ product: await productDto(env, r.product, s.host, cfg.platformShareBps, gstCtxOf(cfg)), gstRateBps: cfg.gstRateBps, priceCapPaise: cfg.priceCapPaise }) : failOf(r);
}
async function deleteProductRoute(env: Env, s: SellerCtx, id: string): Promise<Response> {
  const r = await deleteMerchProduct(env, s.host, id);
  return r.ok ? out({}) : failOf(r);
}

/** Order timeline from the row's own timestamps. Nothing here depends on private columns. */
function timelineOf(row: ShopOrderRow, audience: "seller" | "fan"): Array<{ at: number; label: string }> {
  const t: Array<{ at: number; label: string }> = [];
  if (audience === "fan") t.push({ at: Number(row.created_at), label: "Order started" });
  if (row.confirmed_at) t.push({ at: Number(row.confirmed_at), label: audience === "fan" ? "Payment received" : "Order placed" });
  if (row.approved_at) t.push({ at: Number(row.approved_at), label: "Approved" });
  if (row.sent_to_printer_at) t.push({ at: Number(row.sent_to_printer_at), label: "Sent to print" });
  if (row.shipped_at) t.push({ at: Number(row.shipped_at), label: "Shipped" });
  if (row.delivered_at) t.push({ at: Number(row.delivered_at), label: "Delivered" });
  if (row.approval_status === "rejected") t.push({ at: Number(row.updated_at), label: audience === "fan" ? "Cancelled and refunded" : "Cancelled" });
  return t.sort((a, b) => a.at - b.at);
}

async function sellerOrdersRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  const st = new URL(req.url).searchParams.get("status");
  if (st && !SELLER_STATUSES.includes(st)) return bad(400, "invalid_status", "Status must be new, processing, shipped, delivered or cancelled.");
  const rows = await listSellerOrders(env, s.uid, st);
  const payload = { orders: rows.map((r) => maskOrderForSeller(r)) };
  assertNoSellerLeak(payload);
  return out(payload);
}
async function sellerOrderRoute(env: Env, s: SellerCtx, id: string): Promise<Response> {
  const row = await getSellerOrder(env, s.uid, id);
  if (!row) return bad(404, "not_found", "No such order.");
  const payload = { order: { ...maskOrderForSeller(row), timeline: timelineOf(row, "seller") } };
  assertNoSellerLeak(payload);
  return out(payload);
}
/** [HF-MERCH-GST-1] The influencer's optional GSTIN (record only; payouts do not change because of it yet). */
async function taxRoute(req: Request, env: Env, s: SellerCtx): Promise<Response> {
  if (req.method === "GET") return out({ gstin: (await getSellerTax(env, s.uid))?.gstin ?? null });
  const b = await readJson(req, 2000);
  const gstin = str(b.gstin, 20).toUpperCase().replace(/\s+/g, "");
  if (gstin && !GSTIN_RE.test(gstin)) return bad(400, "invalid_gstin", "A GSTIN has 15 letters and numbers, for example 27ABCDE1234F1Z5. Leave it empty if you do not have one.", { field: "gstin" });
  const limited = await rateLimit(env, `merch:tax:${s.uid}`, 20, 3600); if (limited) return limited;
  try { await setSellerTax(env, s.uid, gstin); } catch (e) { await merchFail(env, e, "seller_tax", s.uid); return bad(503, "unavailable", "We could not save this right now. Please try again later."); }
  return out({ gstin: gstin || null });
}
async function summaryRoute(env: Env, s: SellerCtx): Promise<Response> {
  const [products, orders, earnings] = await Promise.all([sellerProductCounts(env, s.uid), sellerOrderCounts(env, s.uid), sellerEarnings(env, s.uid)]);
  return out({ products, orders, earnings });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
const PUBLIC_CACHE = { "cache-control": "public, max-age=60, s-maxage=120" };
function publicProduct(row: MerchProductRow, host: MerchHost, shareBps: number, cfg?: MerchCfg) {
  const p = productShape(row, host, shareBps, 0, cfg ? gstCtxOf(cfg) : undefined);
  const prices = p.sizes.map((x) => x.pricePaise);
  const pm = productMerch(row);
  return {
    ...merchPublicCategory({ catalogName: pm?.catalogName ?? p.catalogName, kind: pm?.kind }), // [HF-CHANNEL-CORE-1] category + categoryLabel
    id: p.id, slug: p.slug, title: p.title, imageUrl: p.imageUrl, colours: p.colours,
    sizes: p.sizes.map((x) => ({ size: x.size, pricePaise: x.pricePaise, inStock: true })),
    fromPricePaise: prices.length ? Math.min(...prices) : 0, url: p.publicUrl, gstRateBps: p.gstRateBps, // [HF-MERCH-GST-1] this product's category GST rate, included in the price
    // [HF-MERCH-PRICE-LABELS-1] Fans see what the price covers, never the cost numbers.
    priceIncludes: ["printing", "gst", "delivery"] as const,
  };
}
async function publicHostRoute(env: Env, slug: string): Promise<Response> {
  const host = await hostBySlug(env, slug.toLowerCase());
  if (!host || host.status !== "live") return bad(404, "not_found", "No such page.");
  const { cfg, flags } = await merchCfg(env);
  const rows = await listLiveProductsForSeller(env, host.uid);
  return out({ host: { slug: host.slug, displayName: host.displayName, avatarUrl: host.avatarUrl }, checkoutEnabled: flags.checkout, gstRateBps: cfg.gstRateBps, products: rows.map((r) => publicProduct(r, host, cfg.platformShareBps, cfg)) }, 200, PUBLIC_CACHE);
}
async function publicProductRoute(env: Env, hostSlug: string, productSlug: string): Promise<Response> {
  const host = await hostBySlug(env, hostSlug.toLowerCase());
  if (!host || host.status !== "live") return bad(404, "not_found", "No such page.");
  const row = await getProductBySlug(env, shopSlugFor(host.slug, productSlug.toLowerCase()));
  if (!row || row.seller_uid !== host.uid) return bad(404, "not_found", "No such product.");
  if (row.deleted_at || row.review_status === "hidden") return bad(410, "gone", "This product is no longer available.");
  if (row.review_status !== "live") return bad(404, "not_found", "No such product.");
  const { cfg, flags } = await merchCfg(env);
  const m = productMerch(row);
  const p = productShape(row, host, cfg.platformShareBps, 0, gstCtxOf(cfg));
  return out({
    host: { slug: host.slug, displayName: host.displayName, avatarUrl: host.avatarUrl }, checkoutEnabled: flags.checkout, gstRateBps: p.gstRateBps,
    product: { ...publicProduct(row, host, cfg.platformShareBps, cfg), photos: p.mockups.length ? p.mockups : p.imageUrl ? [p.imageUrl] : [], description: row.description, side: m?.side ?? "front", maxQty: MERCH_QTY_MAX },
  }, 200, PUBLIC_CACHE);
}
async function pincodeRoute(env: Env, pin: string): Promise<Response> {
  if (!/^[1-9][0-9]{5}$/.test(pin)) return bad(400, "invalid_pincode", "Enter a 6-digit pincode.");
  const key = `merch:pin:${pin}`;
  try { const c = await env.TOKENS.get(key, "json") as { deliverable: boolean; etaDays: number | null } | null; if (c) return out(c, 200, { "cache-control": "public, max-age=3600" }); } catch { /* cache is optional */ }
  let res: { deliverable: boolean; etaDays: number | null };
  try {
    const s = await (await getPodProvider(env, "printrove")).serviceability(pin, 300);
    res = { deliverable: !!s.ok, etaDays: s.ok && typeof s.eta_days === "number" ? s.eta_days : null };
  } catch (e) { await merchFail(env, e, "pincode"); return bad(503, "unavailable", "We could not check this pincode right now."); }
  try { await env.TOKENS.put(key, JSON.stringify(res), { expirationTtl: 86400 }); } catch { /* ignore */ }
  return out(res, 200, { "cache-control": "public, max-age=3600" });
}
async function sitemapRoute(env: Env): Promise<Response> {
  return out(await sitemapRows(env), 200, PUBLIC_CACHE);
}

// ---------------------------------------------------------------------------
// Fan
// ---------------------------------------------------------------------------
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function checkoutRoute(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in to buy.");
  const { flags, gstinSet } = await merchCfg(env);
  if (!flags.checkout) return bad(403, "checkout_off", "Buying opens soon.");
  // [HF-MERCH-GST-1] We are the seller and must issue a tax invoice for every sale: no GSTIN on file => no money is taken yet.
  if (flags.requireGstin && !gstinSet) return bad(403, "gst_not_ready", "Merch checkout opens soon.");
  const wa = await requireVerifiedWhatsApp(env, u.uid);
  if (wa) return bad(403, "whatsapp_required", "Verify your WhatsApp number first.", { reason: "whatsapp_required" });
  if (await isClosing(env, u.uid)) return bad(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" });
  const b = await readJson(req);
  if (b.acceptTerms !== true || b.acceptRefund !== true) return bad(400, "terms_required", "Please accept the terms and the refund policy.", { field: "acceptTerms" });
  const method = b.method === "wallet" ? "wallet" : b.method === "cashfree" ? "cashfree" : null;
  if (!method) return bad(400, "invalid_method", "Pay from your wallet or by UPI / card.", { field: "method" });
  const requestKey = str(b.requestKey, 80);
  if (requestKey.length < 8) return bad(400, "invalid_request_key", "Missing request key.", { field: "requestKey" });
  if (Array.isArray(b.items)) return bagCheckoutRoute(req, env, u.uid, b, method, requestKey); // [HF-CHANNEL-CORE-1] bag: many lines, one payment
  const productId = str(b.productId, 40);
  const qty = Number(b.qty ?? 1);
  if (!productId) return bad(400, "invalid_product", "Pick a product.", { field: "productId" });
  const limited = await rateLimit(env, `merch:checkout:${u.uid}`, 20, 3600); if (limited) return limited;
  const product = await getProduct(env, productId);
  if (!product || !product.seller_uid) return bad(404, "not_found", "No such product.");
  if (product.seller_uid === u.uid) return bad(403, "own_product", "You cannot buy your own product.");
  const host = await hostByUid(env, product.seller_uid);
  if (!host || host.status !== "live") return bad(410, "gone", "This product is no longer available.");
  const client = (req.headers.get("x-client") ?? b.client) === "app" ? "app" : "web";
  const r = await startMerchCheckout(env, {
    uid: u.uid, product, host, colour: str(b.colour, 40), size: str(b.size, 12), qty, address: b.address, saveAddress: b.saveAddress === true, method, requestKey, client,
  });
  if (!r.ok) return failOf(r);
  const o = r.order;
  const paid = o.pay_status === "confirmed";
  return out({ orderId: o.order_id, orderNo: o.order_no, status: paid ? "paid" : "awaiting_payment", ...(r.checkoutUrl ? { checkoutUrl: r.checkoutUrl } : {}), ...(r.paymentSessionId ? { paymentSessionId: r.paymentSessionId } : {}) }, r.created ? 201 : 200);
}

/** [HF-CHANNEL-CORE-1] POST /api/hf/merch/checkout with `items:[…]` (the bag). Terms / method / requestKey / WhatsApp / closing gates already passed. */
async function bagCheckoutRoute(req: Request, env: Env, uid: string, b: Record<string, unknown>, method: "wallet" | "cashfree", requestKey: string): Promise<Response> {
  const raw = b.items as unknown[];
  if (raw.length < 1 || raw.length > MERCH_BAG_MAX_LINES) return bad(400, "invalid_items", `Put 1 to ${MERCH_BAG_MAX_LINES} items in your bag.`, { field: "items" });
  const lines = raw.map((x) => {
    const it = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return { productId: str(it.productId, 40), colour: str(it.colour, 40), size: str(it.size, 12), qty: Number(it.qty ?? 1) };
  });
  if (lines.some((l) => !l.productId)) return bad(400, "invalid_product", "Pick a product.", { field: "items" });
  const limited = await rateLimit(env, `merch:checkout:${uid}`, 20, 3600); if (limited) return limited;
  const client = (req.headers.get("x-client") ?? b.client) === "app" ? "app" : "web";
  const r = await startMerchBagCheckout(env, { uid, lines, address: b.address, saveAddress: b.saveAddress === true, method, requestKey, client });
  if (!r.ok) return failOf(r);
  const paid = r.rows.every((o) => o.pay_status === "confirmed");
  return out({
    groupId: r.groupId,
    orders: r.rows.map((o) => ({ orderId: o.order_id, orderNo: o.order_no, productId: snapOf(o).productId ?? "", amountPaise: Number(o.amount_paise) })),
    totalPaise: r.rows.reduce((s, o) => s + Number(o.amount_paise), 0), status: paid ? "paid" : "awaiting_payment",
    ...(r.checkoutUrl ? { checkoutUrl: r.checkoutUrl } : {}), ...(r.paymentSessionId ? { paymentSessionId: r.paymentSessionId } : {}),
  });
}

function fanOrderDto(row: ShopOrderRow, now = Date.now()) {
  const snap = snapOf(row) as Partial<MerchSnapshot>;
  const status = fanStatusOf(row);
  const hasShip = !!(row.courier || row.awb || row.tracking_url);
  return {
    id: row.order_id, orderNo: row.order_no, createdAt: Number(row.created_at), status, groupId: groupIdOf(row), // [HF-CHANNEL-CORE-1]
    product: { title: snap.title ?? "", imageUrl: snap.imageUrl ?? null, colour: snap.colour ?? "", size: snap.size ?? "", qty: Number(snap.qty ?? 1), hostName: snap.hostName ?? "", hostSlug: snap.hostSlug ?? "" },
    totalPaise: Number(row.amount_paise), payMethod: row.pay_method ?? null,
    shipping: hasShip ? { courier: row.courier ?? null, awb: row.awb ?? null, trackingUrl: row.tracking_url ?? null } : null,
    receiptUrl: row.pay_status === "confirmed" && row.receipt_no ? `${BRAND.apiOrigin}/api/shop/orders/${row.order_id}/receipt.pdf` : null,
    canReportProblem: row.fulfil_status === "delivered" && !row.problem_json && reportWindowOpen(row, PROBLEM_WINDOW_HOURS, now),
    refundStatus: row.refund_status ?? "none",
    rejectReason: row.approval_status === "rejected" ? row.reject_reason ?? null : null,
    deepLink: `hellofraands://orders/${row.order_id}`,
  };
}
async function myOrdersRoute(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  const rows = await listFanOrders(env, u.uid);
  return out({ orders: rows.map((r) => fanOrderDto(r)) });
}
async function myOrderRoute(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  // [HF-CHANNEL-CORE-1] The Cashfree return page of a bag payment names the group id: answer with every order of the group.
  if (isMerchGroupId(id)) {
    let rows = await getGroupRows(env, id, u.uid);
    if (!rows.length) return bad(404, "not_found", "No such order.");
    if (rows.some((r) => r.pay_method === "cashfree" && r.pay_status === "awaiting_payment" && Date.now() - Number(r.updated_at) > POLL_GAP_MS)) {
      try { await reconcileCashfreeOrder(env, id); } catch (e) { await merchFail(env, e, "poll", u.uid, { group_id: id }); }
      rows = (await getGroupRows(env, id, u.uid)) ?? rows;
    }
    const orders = rows.map((r) => ({ ...fanOrderDto(r), timeline: timelineOf(r, "fan") }));
    const status = rows.every((r) => r.pay_status === "confirmed") ? "paid" : rows.some((r) => r.pay_status === "cancelled" || r.pay_status === "expired") ? "cancelled" : "awaiting_payment";
    return out({ group: { groupId: id, status, totalPaise: rows.reduce((s, r) => s + Number(r.amount_paise), 0), orders }, order: orders[0] });
  }
  let row = await getFanOrder(env, u.uid, id);
  if (!row) return bad(404, "not_found", "No such order.");
  // The buyer came back from the payment page: ask Cashfree now instead of waiting for the webhook.
  if (row.pay_method === "cashfree" && row.pay_status === "awaiting_payment" && Date.now() - Number(row.updated_at) > POLL_GAP_MS) {
    try { await reconcileCashfreeOrder(env, id); } catch (e) { await merchFail(env, e, "poll", u.uid, { order_id: id }); }
    row = (await getFanOrder(env, u.uid, id)) ?? row;
  }
  return out({ order: { ...fanOrderDto(row), timeline: timelineOf(row, "fan") } });
}

async function problemPhotoRoute(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  const row = await getFanOrder(env, u.uid, id);
  if (!row) return bad(404, "not_found", "No such order.");
  const limited = await rateLimit(env, `merch:pphoto:${u.uid}`, 10, 3600); if (limited) return limited;
  const bytes = await readBytes(req, 5 * 1024 * 1024);
  if (!bytes || !bytes.byteLength) return bad(413, "too_large", "The photo must be 5 MB or smaller.");
  const info = parseImageInfo(bytes);
  if (!info) return bad(415, "unsupported_type", "Send a PNG, JPEG or WebP photo.");
  const key = `merch-problems/${u.uid}/${id}/${(await sha256Hex(bytes)).slice(0, 12)}.${IMAGE_EXT[info.mime]}`;
  await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  return out({ photoKey: key });
}
async function problemRoute(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  const b = await readJson(req, 4000);
  const kind = b.kind === "wrong" ? "wrong" : b.kind === "damaged" ? "damaged" : null;
  if (!kind) return bad(400, "invalid_kind", "Say whether the item is wrong or damaged.", { field: "kind" });
  const note = str(b.note, 1000);
  if (note.length < 10) return bad(400, "invalid_note", "Please describe the problem in 10 to 1000 characters.", { field: "note" });
  const photoKey = str(b.photoKey, 300);
  if (photoKey && !photoKey.startsWith(`merch-problems/${u.uid}/${id}/`)) return bad(400, "invalid_photo", "Upload the photo again.", { field: "photoKey" });
  const limited = await rateLimit(env, `merch:problem:${u.uid}`, 5, 3600); if (limited) return limited;
  const row = await getFanOrder(env, u.uid, id);
  if (!row) return bad(404, "not_found", "No such order.");
  if (row.problem_json) return bad(409, "already_reported", "You have already reported a problem with this order.");
  if (row.fulfil_status !== "delivered") return bad(409, "not_delivered", "You can report a problem once your order is delivered.");
  const now = Date.now();
  if (!reportWindowOpen(row, PROBLEM_WINDOW_HOURS, now)) return bad(409, "window_closed", `Problems must be reported within ${PROBLEM_WINDOW_HOURS} hours of delivery.`);
  const res = await metaDb(env).prepare("UPDATE shop_orders SET problem_json=?2, updated_at=?3 WHERE order_id=?1 AND problem_json IS NULL AND fulfil_status='delivered'")
    .bind(id, JSON.stringify({ kind, message: note, photo_key: photoKey || null, reported_at: now }), now).run();
  if (Number(res.meta?.changes ?? 0) !== 1) return bad(409, "already_reported", "You have already reported a problem with this order.");
  await appendShopEvent(env, id, "problem_reported", u.uid, `${kind}: ${note}`.slice(0, 300), now).catch(() => {});
  await merchTrack(env, u.uid, "merch_problem_reported", { order_id: id, kind, has_photo: !!photoKey });
  await alertOwnerShopProblem(env, row, `${kind}: ${note}`).catch((e) => merchFail(env, e, "problem_alert", u.uid));
  return out({ reported: true });
}

async function addressesRoute(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  return out({ addresses: await listAddresses(env, u.uid) });
}
async function deleteAddressRoute(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return bad(u.status, "unauthorized", "Please sign in.");
  return (await deleteAddress(env, u.uid, id)) ? out({}) : bad(404, "not_found", "No such address.");
}

// ---------------------------------------------------------------------------
// Cashfree webhook (also reached from the shared wallet top-up webhook URL for shp_ ids)
// ---------------------------------------------------------------------------
export const isMerchOrderId = (id: string): boolean => /^shp_[a-f0-9]{20}$/.test(id) || isMerchGroupId(id); // [HF-CHANNEL-CORE-1] mgp_ = a bag payment

/** Signature verified over the raw body; the amount and status are then re-read from Cashfree itself before anything is confirmed. */
export async function merchCashfreeWebhook(req: Request, env: Env, rawIn?: string): Promise<Response> {
  const adapter = resolveGateway("cashfree");
  if (!adapter || !adapter.configured(env)) return bad(503, "unconfigured", "Not configured.");
  const raw = rawIn ?? (await req.text());
  let verified = false;
  try { verified = await adapter.verifyWebhook(env, raw, req.headers); } catch (e) { await merchFail(env, e, "webhook_verify"); }
  if (!verified) return bad(401, "bad_signature", "Bad signature.");
  const parsed = adapter.parseWebhook(raw);
  if (!parsed || !isMerchOrderId(parsed.our_order_id)) return out({ ignored: "not_merch" });
  if (parsed.status === "refunded") return out({ refund: isMerchGroupId(parsed.our_order_id) ? await confirmCashfreeRefundsForGroup(env, parsed.our_order_id) : await confirmCashfreeRefund(env, parsed.our_order_id) });
  const r = await reconcileCashfreeOrder(env, parsed.our_order_id);
  return r === "unavailable" ? bad(503, "unavailable", "Try again.") : out({ result: r });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
const NOT_ENABLED = () => bad(404, "not_enabled", "Merch is not available yet.");
const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return ""; } };

export async function hfMerchRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  void ctx;
  if (!p.startsWith("/api/hf/merch/")) return null;
  const m = req.method;
  try {
    const rest = p.slice("/api/hf/merch/".length).split("/").map(dec);
    const [a, b2, c2] = rest;
    // The gateway webhook is exempt from the feature flag: a paid order must be confirmed (and a refund noted) even while merch is switched off.
    if (a === "webhook" && b2 === "cashfree" && rest.length === 2 && m === "POST") return await merchCashfreeWebhook(req, env);
    const { flags } = await merchCfg(env);
    if (!flags.enabled) return NOT_ENABLED();
    // Public
    if (a === "sitemap" && rest.length === 1 && m === "GET") return await sitemapRoute(env);
    if (a === "pincode" && rest.length === 2 && m === "GET") return await pincodeRoute(env, b2);
    if (a === "public" && m === "GET") {
      if (rest.length === 2) return await publicHostRoute(env, b2);
      if (rest.length === 3) return await publicProductRoute(env, b2, c2);
    }
    // Fan
    if (a === "checkout" && rest.length === 1 && m === "POST") return await checkoutRoute(req, env);
    if (a === "my-orders") {
      if (rest.length === 1 && m === "GET") return await myOrdersRoute(req, env);
      if (rest.length === 2 && m === "GET") return await myOrderRoute(req, env, b2);
      if (rest.length === 3 && c2 === "problem" && m === "POST") return await problemRoute(req, env, b2);
      if (rest.length === 3 && c2 === "problem-photo" && m === "POST") return await problemPhotoRoute(req, env, b2);
    }
    if (a === "addresses") {
      if (rest.length === 1 && m === "GET") return await addressesRoute(req, env);
      if (rest.length === 2 && m === "DELETE") return await deleteAddressRoute(req, env, b2);
    }
    // Influencer
    const influencer = ["catalog", "quote", "ai", "art", "print-file", "mockup", "products", "orders", "summary", "tax"];
    if (!influencer.includes(a)) return null;
    const s = await sellerCtx(req, env);
    if (s instanceof Response) return s;
    if (a === "catalog" && m === "GET") return await catalogRoute(env);
    if (a === "quote" && m === "GET") return await quoteRoute(req, env);
    if (a === "ai") {
      if (rest.length === 1 && m === "GET") return await aiStateRoute(env, s);
      if (rest.length === 2 && b2 === "generate" && m === "POST") return await aiGenerateRoute(req, env, s);
      if (rest.length === 3 && b2 === "pictures" && m === "DELETE") return await aiDeleteRoute(env, s, c2);
    }
    if (a === "art" && rest.length === 3 && c2 === "remove-bg" && m === "POST") return await removeBgRoute(env, s, b2);
    if (a === "art" && rest.length === 3 && c2 === "file" && m === "GET") return await artFileRoute(env, s, b2);
    if (a === "art" && rest.length === 1 && m === "POST") return await artRoute(req, env, s);
    if (a === "print-file" && m === "POST") return await printFileRoute(req, env, s);
    if (a === "mockup" && m === "POST") return await mockupRoute(req, env, s);
    if (a === "summary" && m === "GET") return await summaryRoute(env, s);
    if (a === "tax" && rest.length === 1 && (m === "GET" || m === "PUT")) return await taxRoute(req, env, s);
    if (a === "products") {
      if (rest.length === 1 && m === "POST") return await createProductRoute(req, env, s);
      if (rest.length === 1 && m === "GET") return await listProductsRoute(env, s);
      if (rest.length === 2 && m === "PATCH") return await patchProductRoute(req, env, s, b2);
      if (rest.length === 2 && m === "DELETE") return await deleteProductRoute(env, s, b2);
    }
    if (a === "orders") {
      if (rest.length === 1 && m === "GET") return await sellerOrdersRoute(req, env, s);
      if (rest.length === 2 && m === "GET") return await sellerOrderRoute(env, s, b2);
    }
    return null;
  } catch (e) {
    await merchFail(env, e, p);
    return bad(500, "internal_error", "Something went wrong. Please try again.");
  }
}
