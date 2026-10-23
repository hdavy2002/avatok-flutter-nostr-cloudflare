// [HF-MERCH-CORE-1 2026-10-23] D1 access for the merch shop. Plain queries only; the rules live in hf_merch_flow.ts / hf_merch_catalog.ts.
// Merch reuses shop_products / shop_orders / shop_order_events (see migrations/2026-10-23-hf-merch-*.sql); influencer products are stored with
// shop_products.status='hidden' so every existing house-shop query ignores them, and review_status decides visibility here.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { mediaUrl } from "./hf_host_store";
import { brandUrl } from "./brand";
import type { ShopOrderRow } from "./shop_orders_logic";
import { apiProductStatus, parseJson, type ProductMerch } from "./hf_merch_types";
import { sizePrices, sizeBreakdown, maxMarkupForBase } from "./hf_merch_math";
import { frozenOrFallback } from "./hf_merch_gst";

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------
export type MerchHost = { uid: string; slug: string; displayName: string; status: string; avatarUrl: string | null };
const HOST_SQL = `SELECT h.uid AS uid, h.slug AS slug, h.display_name AS display_name, h.status AS status,
    COALESCE((SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key
  FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id=h.avatar_id`;
type HostRowLite = { uid: string; slug: string | null; display_name: string | null; status: string; image_key: string | null };
const hostOf = (env: Env, r: HostRowLite | null): MerchHost | null =>
  r && r.slug ? { uid: r.uid, slug: r.slug, displayName: r.display_name ?? r.slug, status: r.status, avatarUrl: r.image_key ? mediaUrl(env, r.image_key) : null } : null;

export async function hostByUid(env: Env, uid: string): Promise<MerchHost | null> {
  return hostOf(env, await metaDb(env).prepare(`${HOST_SQL} WHERE h.uid=?1`).bind(uid).first<HostRowLite>());
}
export async function hostBySlug(env: Env, slug: string): Promise<MerchHost | null> {
  return hostOf(env, await metaDb(env).prepare(`${HOST_SQL} WHERE h.slug=?1`).bind(slug).first<HostRowLite>());
}
export async function hostsByUids(env: Env, uids: string[]): Promise<Map<string, MerchHost>> {
  const out = new Map<string, MerchHost>();
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return out;
  const rs = (await metaDb(env).prepare(`${HOST_SQL} WHERE h.uid IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`).bind(...ids).all<HostRowLite>()).results ?? [];
  for (const r of rs) { const h = hostOf(env, r); if (h) out.set(h.uid, h); }
  return out;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export type MerchProductRow = {
  id: string; slug: string; name: string; description: string; price_rupees: number; colours_json: string; sizes_json: string; images_json: string;
  status: string; sold_count: number; created_at: number; updated_at: number;
  seller_uid: string | null; review_status: string | null; review_note: string | null; markup_rupees: number | null; design_id: string | null; deleted_at: number | null; merch_json: string | null;
};
const PCOLS = "id, slug, name, description, price_rupees, colours_json, sizes_json, images_json, status, sold_count, created_at, updated_at, seller_uid, review_status, review_note, markup_rupees, design_id, deleted_at, merch_json";

export const productMerch = (row: Pick<MerchProductRow, "merch_json">): ProductMerch | null => {
  const m = parseJson<ProductMerch | null>(row.merch_json, null);
  return m && m.v === 1 ? m : null;
};

export async function getProduct(env: Env, id: string): Promise<MerchProductRow | null> {
  return (await metaDb(env).prepare(`SELECT ${PCOLS} FROM shop_products WHERE id=?1 AND seller_uid IS NOT NULL`).bind(id).first<MerchProductRow>()) ?? null;
}
export async function getProductBySlug(env: Env, shopSlug: string): Promise<MerchProductRow | null> {
  return (await metaDb(env).prepare(`SELECT ${PCOLS} FROM shop_products WHERE slug=?1 AND seller_uid IS NOT NULL`).bind(shopSlug).first<MerchProductRow>()) ?? null;
}
export const shopSlugFor = (hostSlug: string, productSlug: string): string => `${hostSlug}--${productSlug}`;

export async function listSellerProducts(env: Env, sellerUid: string): Promise<MerchProductRow[]> {
  return (await metaDb(env).prepare(`SELECT ${PCOLS} FROM shop_products WHERE seller_uid=?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`).bind(sellerUid).all<MerchProductRow>()).results ?? [];
}
export async function listLiveProductsForSeller(env: Env, sellerUid: string): Promise<MerchProductRow[]> {
  return (await metaDb(env).prepare(
    `SELECT ${PCOLS} FROM shop_products WHERE seller_uid=?1 AND review_status='live' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`, // [HF-CHANNEL-CORE-1] public channel lists every live product (<= 200)
  ).bind(sellerUid).all<MerchProductRow>()).results ?? [];
}
export async function listProductsByReview(env: Env, review: string | null, limit = 100): Promise<MerchProductRow[]> {
  const where = review ? "AND review_status=?1" : "";
  const st = metaDb(env).prepare(`SELECT ${PCOLS} FROM shop_products WHERE seller_uid IS NOT NULL AND deleted_at IS NULL ${where} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`);
  return (await (review ? st.bind(review) : st).all<MerchProductRow>()).results ?? [];
}
export async function sellerProductCounts(env: Env, sellerUid: string): Promise<{ live: number; pending: number; hidden: number }> {
  const r = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CASE WHEN review_status='live' THEN 1 ELSE 0 END),0) AS live,
            COALESCE(SUM(CASE WHEN review_status IN ('pending','draft') THEN 1 ELSE 0 END),0) AS pending,
            COALESCE(SUM(CASE WHEN review_status='hidden' THEN 1 ELSE 0 END),0) AS hidden
       FROM shop_products WHERE seller_uid=?1 AND deleted_at IS NULL`,
  ).bind(sellerUid).first<{ live: number; pending: number; hidden: number }>();
  return { live: Number(r?.live ?? 0), pending: Number(r?.pending ?? 0), hidden: Number(r?.hidden ?? 0) };
}

/** Orders that are paid-or-paying and not finished: block deleting the product. */
export async function openOrdersForProduct(env: Env, productId: string): Promise<number> {
  const r = await metaDb(env).prepare(
    `SELECT COUNT(*) AS c FROM shop_orders
      WHERE seller_uid IS NOT NULL AND items_json LIKE ?1 AND fulfil_status IN ('new','at_printer','shipped')
        AND (pay_status='confirmed' OR (pay_status IN ('awaiting_payment','review_pending') AND expires_at>?2))
        AND COALESCE(approval_status,'pending')<>'rejected'`,
  ).bind(`%"${productId}"%`, Date.now()).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

export type ProductShape = {
  id: string; slug: string; title: string; description: string; status: "pending" | "live" | "rejected" | "hidden"; reviewNote: string | null;
  imageUrl: string | null; mockups: string[]; catalogName: string; colours: Array<{ name: string; hex: string }>;
  /** pricePaise is GST-inclusive; youEarnPaise is the design royalty; maxMarkupRupees is present when the cap is passed in AND the product's category has a cap. */
  sizes: Array<{ size: string; basePaise: number; pricePaise: number; youEarnPaise: number; printingPaise: number; shippingPaise: number; bufferPaise: number; maxMarkupRupees?: number }>;
  /** [HF-MERCH-GST-1] The product's FROZEN category GST: rate (bps) included in the price, HSN ("" = to be confirmed), whether the price cap applies, and the smallest per-size
   *  max markup (null/absent when no cap). */
  gstRateBps: number; hsn: string; capApplies: boolean; maxMarkupRupees: number | null;
  /** true when the printing / shipping split was worked back from today's shipping quote because the product predates the frozen breakdown. */
  breakdownEstimated: boolean; markupRupees: number; soldCount: number; publicUrl: string; createdAt: number;
};
/** The settings a product's GST view needs: the cap and the flat fallback for a product made before the category table. */
export type GstCtx = { capPaise: number; rateBps: number; hsn: string };
export const gstCtxOf = (cfg: { priceCapPaise: number; gstRateBps: number; hsn: string }): GstCtx => ({ capPaise: cfg.priceCapPaise, rateBps: cfg.gstRateBps, hsn: cfg.hsn });
export function productShape(row: MerchProductRow, host: Pick<MerchHost, "slug">, shareBps: number, legacyShipPaise = 0, gctx?: GstCtx): ProductShape {
  const m = productMerch(row);
  const g = frozenOrFallback(m?.gst, { rateBps: gctx?.rateBps ?? 500, hsn: gctx?.hsn ?? "6109" });
  const capPaise = gctx && g.capApplies ? gctx.capPaise : undefined;
  const mockups = m?.mockups ?? [];
  const markup = Math.trunc(Number(row.markup_rupees ?? 0));
  const bufferPaise = Math.max(0, Math.trunc(Number(m?.bufferRupees ?? 0))) * 100;
  const parts = (m?.sizes ?? []).map((x) => sizeBreakdown(x, legacyShipPaise, bufferPaise));
  return {
    id: row.id, slug: m?.productSlug ?? row.slug, title: row.name, description: row.description, status: apiProductStatus(row.review_status), reviewNote: row.review_note,
    imageUrl: mockups[0] ?? m?.printPreviewUrl ?? m?.artUrl ?? null, mockups, catalogName: m?.catalogName ?? "", colours: m?.colours ?? [],
    sizes: sizePrices(m?.sizes ?? [], markup, shareBps, capPaise).map((x, i) => ({ ...x, printingPaise: parts[i].printingPaise, shippingPaise: parts[i].shippingPaise, bufferPaise: parts[i].bufferPaise })),
    gstRateBps: g.rateBps, hsn: g.hsn, capApplies: g.capApplies,
    maxMarkupRupees: capPaise != null && (m?.sizes ?? []).length ? Math.min(...(m?.sizes ?? []).map((s) => maxMarkupForBase(s.baseUnitPaise, capPaise))) : null,
    breakdownEstimated: parts.some((x) => x.estimated), markupRupees: markup, soldCount: Number(row.sold_count ?? 0),
    publicUrl: brandUrl(`/h/${host.slug}/merch/${m?.productSlug ?? row.slug}`), createdAt: Number(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export async function getOrder(env: Env, orderId: string): Promise<ShopOrderRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM shop_orders WHERE order_id=?1 AND seller_uid IS NOT NULL").bind(orderId).first<ShopOrderRow>()) ?? null;
}
export async function getOrderByRequestKey(env: Env, uid: string, requestKey: string): Promise<ShopOrderRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM shop_orders WHERE uid=?1 AND request_key=?2 AND seller_uid IS NOT NULL").bind(uid, requestKey).first<ShopOrderRow>()) ?? null;
}

/** [HF-CHANNEL-CORE-1] Every order of a bag payment, oldest line first. Looked up by the shared Cashfree order id (= group id), falling back to the snapshot's groupId
 *  (rows created but not yet linked to a gateway order). `uid` narrows to one buyer when the caller is a fan. */
export async function getGroupRows(env: Env, groupId: string, uid?: string): Promise<ShopOrderRow[]> {
  const db = metaDb(env);
  const who = uid ? "AND uid=?2" : "";
  const bind = (st: D1PreparedStatement) => (uid ? st.bind(groupId, uid) : st.bind(groupId));
  const a = (await bind(db.prepare(`SELECT * FROM shop_orders WHERE cashfree_order_id=?1 ${who} AND seller_uid IS NOT NULL ORDER BY request_key`)).all<ShopOrderRow>()).results ?? [];
  if (a.length) return a;
  return (await bind(db.prepare(`SELECT * FROM shop_orders WHERE json_extract(merch_json,'$.groupId')=?1 ${who} AND seller_uid IS NOT NULL ORDER BY request_key`)).all<ShopOrderRow>()).results ?? [];
}

const SELLER_STATUS_SQL: Record<string, string> = {
  new: "(approval_status IS NULL OR approval_status='pending') AND fulfil_status='new'",
  processing: "approval_status='approved' AND fulfil_status IN ('new','at_printer')",
  shipped: "fulfil_status='shipped'",
  delivered: "fulfil_status='delivered'",
  cancelled: "(fulfil_status IN ('cancelled','refunded') OR approval_status='rejected')",
};
/** Only orders the buyer has PAID are shown to the influencer (an unpaid Cashfree order is not an order yet). */
export async function listSellerOrders(env: Env, sellerUid: string, status: string | null, limit = 100): Promise<ShopOrderRow[]> {
  const cond = status && SELLER_STATUS_SQL[status] ? `AND ${SELLER_STATUS_SQL[status]}` : "";
  return (await metaDb(env).prepare(
    `SELECT * FROM shop_orders WHERE seller_uid=?1 AND pay_status='confirmed' ${cond} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  ).bind(sellerUid).all<ShopOrderRow>()).results ?? [];
}
export async function getSellerOrder(env: Env, sellerUid: string, orderId: string): Promise<ShopOrderRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM shop_orders WHERE order_id=?1 AND seller_uid=?2 AND pay_status='confirmed'").bind(orderId, sellerUid).first<ShopOrderRow>()) ?? null;
}
export async function sellerOrderCounts(env: Env, sellerUid: string): Promise<{ new: number; processing: number; shipped: number; delivered: number }> {
  const r = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${SELLER_STATUS_SQL.new} THEN 1 ELSE 0 END),0) AS n, COALESCE(SUM(CASE WHEN ${SELLER_STATUS_SQL.processing} THEN 1 ELSE 0 END),0) AS p,
            COALESCE(SUM(CASE WHEN ${SELLER_STATUS_SQL.shipped} AND COALESCE(approval_status,'')<>'rejected' THEN 1 ELSE 0 END),0) AS s,
            COALESCE(SUM(CASE WHEN ${SELLER_STATUS_SQL.delivered} THEN 1 ELSE 0 END),0) AS d
       FROM shop_orders WHERE seller_uid=?1 AND pay_status='confirmed'`,
  ).bind(sellerUid).first<{ n: number; p: number; s: number; d: number }>();
  return { new: Number(r?.n ?? 0), processing: Number(r?.p ?? 0), shipped: Number(r?.s ?? 0), delivered: Number(r?.d ?? 0) };
}
export async function listFanOrders(env: Env, uid: string, limit = 100): Promise<ShopOrderRow[]> {
  return (await metaDb(env).prepare(
    `SELECT * FROM shop_orders WHERE uid=?1 AND seller_uid IS NOT NULL AND (pay_status='confirmed' OR (pay_status IN ('awaiting_payment','review_pending') AND expires_at>?2))
      ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  ).bind(uid, Date.now()).all<ShopOrderRow>()).results ?? [];
}
export async function getFanOrder(env: Env, uid: string, orderId: string): Promise<ShopOrderRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM shop_orders WHERE order_id=?1 AND uid=?2 AND seller_uid IS NOT NULL").bind(orderId, uid).first<ShopOrderRow>()) ?? null;
}

export type AdminTab = "pending" | "printer" | "shipped" | "delivered" | "problem" | "cancelled";
export const ADMIN_TABS: AdminTab[] = ["pending", "printer", "shipped", "delivered", "problem", "cancelled"];
const ADMIN_TAB_SQL: Record<AdminTab, string> = {
  pending: "pay_status='confirmed' AND approval_status='pending' AND fulfil_status='new'",
  printer: "pay_status='confirmed' AND approval_status='approved' AND fulfil_status IN ('new','at_printer')",
  shipped: "pay_status='confirmed' AND fulfil_status='shipped'",
  delivered: "pay_status='confirmed' AND fulfil_status='delivered'",
  problem: "(problem_json IS NOT NULL OR refund_status='pending_manual' OR EXISTS (SELECT 1 FROM shop_fulfilments f WHERE f.order_id=shop_orders.order_id AND f.status='problem'))",
  cancelled: "(approval_status='rejected' OR fulfil_status IN ('cancelled','refunded'))",
};
export async function adminListOrders(env: Env, tab: AdminTab, limit = 100): Promise<ShopOrderRow[]> {
  return (await metaDb(env).prepare(
    `SELECT * FROM shop_orders WHERE seller_uid IS NOT NULL AND ${ADMIN_TAB_SQL[tab]} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  ).all<ShopOrderRow>()).results ?? [];
}
export async function adminTabCounts(env: Env): Promise<Record<AdminTab, number>> {
  const parts = ADMIN_TABS.map((t) => `COALESCE(SUM(CASE WHEN ${ADMIN_TAB_SQL[t]} THEN 1 ELSE 0 END),0) AS ${t}`).join(", ");
  const r = await metaDb(env).prepare(`SELECT ${parts} FROM shop_orders WHERE seller_uid IS NOT NULL`).first<Record<AdminTab, number>>();
  const out = {} as Record<AdminTab, number>;
  for (const t of ADMIN_TABS) out[t] = Number(r?.[t] ?? 0);
  return out;
}

export type OrderEvent = { at: number; kind: string; actor: string | null; note: string | null };
export async function orderEvents(env: Env, orderId: string): Promise<OrderEvent[]> {
  return (await metaDb(env).prepare("SELECT at, kind, actor, note FROM shop_order_events WHERE order_id=?1 ORDER BY at ASC, id ASC LIMIT 100").bind(orderId).all<OrderEvent>()).results ?? [];
}

// ---------------------------------------------------------------------------
// Earnings (influencer summary)
// ---------------------------------------------------------------------------
export async function sellerEarnings(env: Env, sellerUid: string, now = Date.now()): Promise<{ pendingPaise: number; availablePaise: number; lifetimePaise: number }> {
  const r = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind='merch_earning' OR (kind='admin_adjust' AND available_at IS NOT NULL AND op_id LIKE 'hfmerch:earnrev:%') THEN amount_paise END),0) AS lifetime,
            COALESCE(SUM(CASE WHEN (kind='merch_earning' OR (kind='admin_adjust' AND available_at IS NOT NULL AND op_id LIKE 'hfmerch:earnrev:%')) AND available_at>?2 THEN amount_paise END),0) AS pending
       FROM hf_host_ledger WHERE host_uid=?1`,
  ).bind(sellerUid, now).first<{ lifetime: number; pending: number }>();
  const pending = Math.max(0, Number(r?.pending ?? 0));
  // Delivered but the order row says not credited yet is still "coming": count shipped-and-not-delivered earnings as pending too.
  const inFlight = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CAST(json_extract(merch_json,'$.money.influencerPaise') AS INTEGER)),0) AS v FROM shop_orders
      WHERE seller_uid=?1 AND pay_status='confirmed' AND approval_status='approved' AND fulfil_status IN ('new','at_printer','shipped') AND COALESCE(refund_status,'none')='none'`,
  ).bind(sellerUid).first<{ v: number }>().catch(() => null);
  const lifetime = Math.max(0, Number(r?.lifetime ?? 0));
  return { pendingPaise: pending + Math.max(0, Number(inFlight?.v ?? 0)), availablePaise: Math.max(0, lifetime - pending), lifetimePaise: lifetime };
}

// ---------------------------------------------------------------------------
// Addresses (max 5 per person)
// ---------------------------------------------------------------------------
export type SavedAddress = { id: string; name: string; phone: string; line1: string; line2: string | null; city: string; state: string; pincode: string; updatedAt: number };
export const MAX_ADDRESSES = 5;
export async function listAddresses(env: Env, uid: string): Promise<SavedAddress[]> {
  const rs = (await metaDb(env).prepare("SELECT id, name, phone, line1, line2, city, state, pincode, updated_at FROM hf_merch_addresses WHERE uid=?1 ORDER BY updated_at DESC LIMIT 10")
    .bind(uid).all<{ id: string; name: string; phone: string; line1: string; line2: string | null; city: string; state: string; pincode: string; updated_at: number }>()).results ?? [];
  return rs.map((r) => ({ id: r.id, name: r.name, phone: r.phone, line1: r.line1, line2: r.line2, city: r.city, state: r.state, pincode: r.pincode, updatedAt: Number(r.updated_at) }));
}
/** Save (or refresh, when the same pincode+line1 is already saved) an address; keeps only the newest MAX_ADDRESSES. */
export async function saveAddress(env: Env, uid: string, a: { name: string; phone: string; line1: string; line2?: string | null; city: string; state: string; pincode: string }): Promise<void> {
  const db = metaDb(env), now = Date.now();
  const same = await db.prepare("SELECT id FROM hf_merch_addresses WHERE uid=?1 AND pincode=?2 AND lower(line1)=lower(?3) LIMIT 1").bind(uid, a.pincode, a.line1).first<{ id: string }>();
  if (same) {
    await db.prepare("UPDATE hf_merch_addresses SET name=?2, phone=?3, line2=?4, city=?5, state=?6, updated_at=?7 WHERE id=?1").bind(same.id, a.name, a.phone, a.line2 ?? null, a.city, a.state, now).run();
    return;
  }
  await db.prepare("INSERT INTO hf_merch_addresses (id, uid, name, phone, line1, line2, city, state, pincode, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)")
    .bind(`mad_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, uid, a.name, a.phone, a.line1, a.line2 ?? null, a.city, a.state, a.pincode, now).run();
  await db.prepare(
    `DELETE FROM hf_merch_addresses WHERE uid=?1 AND id NOT IN (SELECT id FROM hf_merch_addresses WHERE uid=?1 ORDER BY updated_at DESC LIMIT ${MAX_ADDRESSES})`,
  ).bind(uid).run();
}
export async function deleteAddress(env: Env, uid: string, id: string): Promise<boolean> {
  const r = await metaDb(env).prepare("DELETE FROM hf_merch_addresses WHERE id=?1 AND uid=?2").bind(id, uid).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// [HF-MERCH-GST-1] The influencer's OPTIONAL GSTIN. Record only: payouts do not change because of it (yet). Table: hf_merch_seller_tax.
// ---------------------------------------------------------------------------
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
export async function getSellerTax(env: Env, uid: string): Promise<{ gstin: string; updatedAt: number } | null> {
  try {
    const r = await metaDb(env).prepare("SELECT gstin, updated_at FROM hf_merch_seller_tax WHERE uid=?1").bind(uid).first<{ gstin: string; updated_at: number }>();
    return r ? { gstin: r.gstin, updatedAt: Number(r.updated_at) } : null;
  } catch { return null; } // table not migrated yet: no GSTIN on file
}
/** Empty string clears it. Throws when the table is missing (the route turns that into 503). */
export async function setSellerTax(env: Env, uid: string, gstin: string): Promise<void> {
  const db = metaDb(env);
  if (!gstin) { await db.prepare("DELETE FROM hf_merch_seller_tax WHERE uid=?1").bind(uid).run(); return; }
  await db.prepare("INSERT INTO hf_merch_seller_tax (uid, gstin, updated_at) VALUES (?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET gstin=excluded.gstin, updated_at=excluded.updated_at").bind(uid, gstin, Date.now()).run();
}

// ---------------------------------------------------------------------------
// Platform ledger (append-only, UNIQUE op_id)
// ---------------------------------------------------------------------------
export type PlatformKind = "merch_share" | "printrove_cost" | "cashfree_fee" | "gst" | "gst_output" | "gst_input" | "refund_share" | "refund_printrove_cost" | "refund_cashfree_fee" | "refund_gst" | "refund_gst_output" | "refund_gst_input" | "refund_after_hold";
export const platformOpId = (kind: PlatformKind, orderId: string) => `hfplat:${kind}:${orderId}`;
export async function platformEntry(env: Env, kind: PlatformKind, amountPaise: number, orderId: string, sellerUid: string | null, note: string | null = null): Promise<boolean> {
  const amt = Math.trunc(amountPaise);
  if (amt === 0) return false;
  const r = await metaDb(env).prepare(
    "INSERT OR IGNORE INTO hf_platform_ledger (id, kind, amount_paise, order_id, seller_uid, op_id, note, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
  ).bind(crypto.randomUUID(), kind, amt, orderId, sellerUid, platformOpId(kind, orderId), note ? note.slice(0, 200) : null, Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}
export type PlatformRow = { id: string; kind: string; amount_paise: number; order_id: string | null; seller_uid: string | null; note: string | null; created_at: number };
export async function platformRows(env: Env, fromMs: number, toMs: number): Promise<PlatformRow[]> {
  return (await metaDb(env).prepare("SELECT id, kind, amount_paise, order_id, seller_uid, note, created_at FROM hf_platform_ledger WHERE created_at>=?1 AND created_at<?2 ORDER BY created_at ASC LIMIT 5000")
    .bind(fromMs, toMs).all<PlatformRow>()).results ?? [];
}

// ---------------------------------------------------------------------------
// Sitemap (public)
// ---------------------------------------------------------------------------
export async function sitemapRows(env: Env): Promise<{ hosts: Array<{ slug: string; updatedAt: number }>; products: Array<{ hostSlug: string; slug: string; updatedAt: number; imageUrl: string | null; title: string }> }> {
  const rs = (await metaDb(env).prepare(
    `SELECT p.name AS name, p.slug AS slug, p.updated_at AS updated_at, p.merch_json AS merch_json, h.slug AS host_slug
       FROM shop_products p JOIN hf_hosts h ON h.uid=p.seller_uid
      WHERE p.seller_uid IS NOT NULL AND p.review_status='live' AND p.deleted_at IS NULL AND h.status='live' AND h.slug IS NOT NULL
      ORDER BY p.updated_at DESC LIMIT 5000`,
  ).all<{ name: string; slug: string; updated_at: number; merch_json: string | null; host_slug: string }>()).results ?? [];
  const hosts = new Map<string, number>();
  const products = rs.map((r) => {
    const m = parseJson<ProductMerch | null>(r.merch_json, null);
    hosts.set(r.host_slug, Math.max(hosts.get(r.host_slug) ?? 0, Number(r.updated_at)));
    return { hostSlug: r.host_slug, slug: m?.productSlug ?? r.slug, updatedAt: Number(r.updated_at), imageUrl: m?.mockups?.[0] ?? m?.printPreviewUrl ?? m?.artUrl ?? null, title: r.name };
  });
  return { hosts: [...hosts.entries()].map(([slug, updatedAt]) => ({ slug, updatedAt })), products };
}
