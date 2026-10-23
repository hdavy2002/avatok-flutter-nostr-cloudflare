// [HF-MERCH-CORE-1 2026-10-23] Admin side of the influencer merch shop. Spec: Specs/SPEC-2026-10-23-HF-MERCH.md section 5 (Admin).
//   GET  /api/admin/merch/orders?tab=            GET  /api/admin/merch/orders/:id[?quote=1]
//   POST /api/admin/merch/orders/:id/{approve,reject,tracking,delivered,refund,refund-done}
//   GET  /api/admin/merch/products?status=       POST /api/admin/merch/products/:id/review
//   GET|PUT /api/admin/merch/settings            GET  /api/admin/merch/platform-wallet?month=YYYY-MM[&format=csv]
//   GET  /api/admin/merch/problem-photo?key=
// Admin routes are NOT behind hfMerchEnabled: the settings page is how the feature gets switched on.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { readConfig, writeConfigOverrides } from "./config";
import { emailFor } from "../lib/identity";
import { metaDb } from "../db/shard";
import { MERCH_CFG_RANGES } from "../lib/hf_merch_math";
import { fanStatusOf, parseJson, sellerStatusOf } from "../lib/hf_merch_types";
import {
  ADMIN_TABS, adminListOrders, adminTabCounts, getOrder, hostsByUids, listProductsByReview, orderEvents, platformRows, productShape, type AdminTab, type MerchProductRow,
} from "../lib/hf_merch_store";
import { approveMerchOrder, markRefundDone, merchCfg, quoteMerchOrder, rejectMerchOrder, setMerchDelivered, setMerchTracking, type FlowFail } from "../lib/hf_merch_flow";
import { reviewMerchProduct, type PFail } from "../lib/hf_merch_products";
import { merchFail, snapOf } from "../lib/hf_merch_notify";
import type { ShopOrderRow } from "../lib/shop_orders_logic";
import { bad, out } from "./hf_merch";

const failOf = (f: FlowFail | PFail): Response => bad(f.status, f.error, f.message, f.extra ?? {});
async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
async function orderDto(env: Env, row: ShopOrderRow, hosts: Map<string, { slug: string; displayName: string }>, withEvents = false) {
  const snap = snapOf(row);
  const addr = parseJson<Record<string, unknown>>(row.address_json, {});
  const seller = row.seller_uid ? hosts.get(row.seller_uid) : undefined;
  const fulfil = await metaDb(env).prepare("SELECT provider, provider_order_id, status, last_error, attempts FROM shop_fulfilments WHERE order_id=?1").bind(row.order_id).first<Record<string, unknown>>().catch(() => null);
  const problem = parseJson<Record<string, unknown> | null>(row.problem_json, null);
  const base = {
    id: row.order_id, orderNo: row.order_no, createdAt: Number(row.created_at), confirmedAt: row.confirmed_at ?? null,
    status: fanStatusOf(row), sellerStatus: sellerStatusOf(row), payStatus: row.pay_status, payMethod: row.pay_method ?? null,
    reference: row.pay_method === "cashfree" ? row.cashfree_order_id ?? null : row.wallet_op_id ?? null, totalPaise: Number(row.amount_paise),
    buyer: { uid: row.uid, name: addr.name ?? row.contact_name ?? "", phone: addr.phone ?? "", email: await emailFor(env, row.uid).catch(() => null), address: addr },
    merch: snap, seller: seller ? { uid: row.seller_uid, slug: seller.slug, displayName: seller.displayName } : { uid: row.seller_uid, slug: null, displayName: null },
    approval: { status: row.approval_status ?? "pending", by: row.approved_by ?? null, at: row.approved_at ?? null, rejectReason: row.reject_reason ?? null },
    fulfilment: {
      status: row.fulfil_status, partner: fulfil, partnerRef: row.printrove_order_ref ?? null, courier: row.courier ?? null, awb: row.awb ?? null, trackingUrl: row.tracking_url ?? null,
      sentToPrinterAt: row.sent_to_printer_at ?? null, shippedAt: row.shipped_at ?? null, deliveredAt: row.delivered_at ?? null,
    },
    refund: { status: row.refund_status ?? "none", at: row.refunded_at ?? null }, earningCreditedAt: row.earning_credited_at ?? null,
    problem: problem ? { ...problem, photoUrl: problem.photo_key ? `/api/admin/merch/problem-photo?key=${encodeURIComponent(String(problem.photo_key))}` : null } : null,
  };
  return withEvents ? { ...base, events: await orderEvents(env, row.order_id) } : base;
}
async function hostMap(env: Env, rows: Array<{ seller_uid?: string | null }>) {
  const ids = [...new Set(rows.map((r) => r.seller_uid).filter((x): x is string => !!x))];
  return ids.length ? await hostsByUids(env, ids) : new Map();
}

async function listOrders(req: Request, env: Env): Promise<Response> {
  const tab = (new URL(req.url).searchParams.get("tab") ?? "pending") as AdminTab;
  if (!ADMIN_TABS.includes(tab)) return bad(400, "invalid_tab", `Tab must be one of ${ADMIN_TABS.join(", ")}.`);
  const rows = await adminListOrders(env, tab);
  const hosts = await hostMap(env, rows);
  const [orders, counts] = await Promise.all([Promise.all(rows.map((r) => orderDto(env, r, hosts))), adminTabCounts(env)]);
  return out({ orders, counts });
}
async function getOrderRoute(req: Request, env: Env, id: string): Promise<Response> {
  const row = await getOrder(env, id);
  if (!row || !row.seller_uid) return bad(404, "not_found", "No such order.");
  const dto = await orderDto(env, row, await hostMap(env, [row]), true);
  let liveQuote: Record<string, unknown> | undefined;
  if (new URL(req.url).searchParams.get("quote") === "1") {
    const q = await quoteMerchOrder(env, row);
    liveQuote = q.ok
      ? { quoteAvailable: true, liveBasePaise: q.quote.liveBasePaise, platformNetAfterPaise: q.quote.platformNetAfterPaise, costRose: q.quote.costRose, canApprove: q.quote.canApprove, risePaise: q.quote.risePaise, stale: q.quote.stale, source: q.quote.source }
      : { quoteAvailable: false, message: q.message, canApprove: false, canForce: true, costRose: false };
  }
  return out({ order: liveQuote ? { ...dto, liveQuote } : dto });
}

async function orderAction(req: Request, env: Env, admin: string, id: string, action: string): Promise<Response> {
  const b = await readJson(req);
  switch (action) {
    case "approve": {
      const r = await approveMerchOrder(env, id, admin, { acceptStaleQuote: b.force === true });
      return r.ok ? out({ fulfilment: r.fulfilment, manual: r.manual, partnerError: r.partnerError }) : failOf(r);
    }
    case "reject": {
      const r = await rejectMerchOrder(env, id, admin, str(b.reason, 300));
      return r.ok ? out({ refund: r.refund }) : failOf(r);
    }
    case "refund": { // a problem order after the print partner has it / after delivery
      const r = await rejectMerchOrder(env, id, admin, str(b.reason, 300), { afterDelivery: true });
      return r.ok ? out({ refund: r.refund }) : failOf(r);
    }
    case "tracking": {
      const courier = str(b.courier, 60), awb = str(b.awb, 60), trackingUrl = str(b.trackingUrl, 300);
      if (!courier || !awb) return bad(400, "tracking_required", "Enter the courier and the AWB number.", { field: courier ? "awb" : "courier" });
      if (trackingUrl && !/^https:\/\/[^\s]+$/i.test(trackingUrl)) return bad(400, "invalid_url", "The tracking link must start with https://.", { field: "trackingUrl" });
      const r = await setMerchTracking(env, id, admin, { courier, awb, trackingUrl: trackingUrl || null });
      return r.ok ? out({}) : failOf(r);
    }
    case "delivered": {
      const r = await setMerchDelivered(env, id, admin);
      return r.ok ? out({}) : failOf(r);
    }
    case "refund-done": {
      const r = await markRefundDone(env, id, admin, str(b.note, 200) || null);
      return r.ok ? out({}) : failOf(r);
    }
  }
  return bad(404, "not_found", "No such action.");
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
const REVIEW_STATUSES = ["pending", "live", "hidden", "rejected"];
async function listProducts(req: Request, env: Env): Promise<Response> {
  const st = new URL(req.url).searchParams.get("status");
  if (st && !REVIEW_STATUSES.includes(st)) return bad(400, "invalid_status", "Status must be pending, live, hidden or rejected.");
  const { cfg } = await merchCfg(env);
  const rows = await listProductsByReview(env, st);
  const hosts = await hostMap(env, rows);
  return out({
    products: rows.map((r: MerchProductRow) => {
      const h = r.seller_uid ? hosts.get(r.seller_uid) : undefined;
      return { ...productShape(r, h ?? { slug: "" }, cfg.platformShareBps), seller: { uid: r.seller_uid, slug: h?.slug ?? null, displayName: h?.displayName ?? null }, moderation: (parseJson<{ moderation?: string }>(r.merch_json, {})).moderation ?? null };
    }),
  });
}
async function reviewRoute(req: Request, env: Env, admin: string, id: string): Promise<Response> {
  const b = await readJson(req);
  const r = await reviewMerchProduct(env, admin, id, str(b.decision, 12), str(b.note, 280));
  if (!r.ok) return failOf(r);
  const { cfg } = await merchCfg(env);
  const h = r.product.seller_uid ? (await hostMap(env, [r.product])).get(r.product.seller_uid) : undefined;
  return out({ product: productShape(r.product, h ?? { slug: "" }, cfg.platformShareBps) });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const BOOL_KEYS = ["hfMerchEnabled", "hfMerchCheckoutEnabled", "hfMerchAutoApprove", "hfMerchProductReview"] as const;
const NUM_KEYS: Record<string, readonly [number, number]> = MERCH_CFG_RANGES; // the same table readMerchCfg clamps to
async function settingsOut(env: Env): Promise<Record<string, unknown>> {
  const c = (await readConfig(env)) as unknown as Record<string, unknown>;
  const o: Record<string, unknown> = {};
  for (const k of BOOL_KEYS) o[k] = c[k] === true;
  for (const k of Object.keys(NUM_KEYS)) o[k] = Number(c[k]);
  return o;
}
async function putSettings(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const patch: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(b)) {
    if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== "boolean") return bad(400, "invalid_value", `${k} must be true or false.`, { field: k });
      patch[k] = v;
    } else if (NUM_KEYS[k]) {
      const [lo, hi] = NUM_KEYS[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) return bad(400, "invalid_value", `${k} must be a whole number from ${lo} to ${hi}.`, { field: k });
      patch[k] = v;
    } else return bad(400, "unknown_setting", `${k} is not a merch setting.`, { field: k });
  }
  if (Object.keys(patch).length) await writeConfigOverrides(env, patch); // ONE KV write
  return out({ settings: await settingsOut(env) });
}

// ---------------------------------------------------------------------------
// Platform wallet
// ---------------------------------------------------------------------------
const IST_MS = 19_800_000;
function monthRange(month: string | null): { label: string; from: number; to: number } | null {
  const now = new Date(Date.now() + IST_MS);
  const label = month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  return { label, from: Date.UTC(y, mo - 1, 1) - IST_MS, to: Date.UTC(y, mo, 1) - IST_MS };
}
type Totals = { sharePaise: number; cashfeePaise: number; gstPaise: number; netPaise: number; printroveOwedPaise: number; refundsPaise: number };
const zero = (): Totals => ({ sharePaise: 0, cashfeePaise: 0, gstPaise: 0, netPaise: 0, printroveOwedPaise: 0, refundsPaise: 0 });
function addRow(t: Totals, kind: string, amt: number): void {
  if (kind === "merch_share" || kind === "refund_share") t.sharePaise += amt;
  else if (kind === "cashfree_fee" || kind === "refund_cashfree_fee") t.cashfeePaise -= amt;
  else if (kind === "gst" || kind === "refund_gst") t.gstPaise -= amt;
  else if (kind === "printrove_cost" || kind === "refund_printrove_cost") t.printroveOwedPaise -= amt;
  if (kind === "refund_share" || kind === "refund_after_hold") t.refundsPaise -= amt;
  if (kind === "refund_after_hold") t.sharePaise += amt; // platform absorbs the influencer's withdrawn earning
}
const finish = (t: Totals): Totals => ({ ...t, netPaise: t.sharePaise - t.cashfeePaise - t.gstPaise });
const csvCell = (v: unknown): string => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function platformWallet(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const range = monthRange(q.get("month"));
  if (!range) return bad(400, "invalid_month", "Month must look like 2026-10.");
  const rows = await platformRows(env, range.from, range.to);
  const totals = zero(); const by = new Map<string, Totals>();
  for (const r of rows) {
    addRow(totals, r.kind, Number(r.amount_paise));
    const k = r.seller_uid ?? "-";
    if (!by.has(k)) by.set(k, zero());
    addRow(by.get(k) as Totals, r.kind, Number(r.amount_paise));
  }
  if (q.get("format") === "csv") {
    const lines = ["when_ist,kind,amount_rupees,order_id,seller_uid,note"].concat(rows.map((r) => [new Date(r.created_at + IST_MS).toISOString().slice(0, 19).replace("T", " "), r.kind, (Number(r.amount_paise) / 100).toFixed(2), r.order_id, r.seller_uid, r.note].map(csvCell).join(",")));
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="merch-platform-${range.label}.csv"`, "cache-control": "private, no-store" } });
  }
  const hosts = await hostMap(env, [...by.keys()].filter((k) => k !== "-").map((seller_uid) => ({ seller_uid })));
  return out({
    month: range.label, totals: finish(totals),
    bySeller: [...by.entries()].map(([uid, t]) => ({ sellerUid: uid === "-" ? null : uid, slug: hosts.get(uid)?.slug ?? null, displayName: hosts.get(uid)?.displayName ?? null, ...finish(t) })),
    rows: rows.map((r) => ({ id: r.id, kind: r.kind, amountPaise: Number(r.amount_paise), orderId: r.order_id, sellerUid: r.seller_uid, note: r.note, createdAt: Number(r.created_at) })),
  });
}

async function problemPhoto(req: Request, env: Env): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!/^merch-problems\/[A-Za-z0-9_-]+\/shp_[a-f0-9]+\/[a-f0-9]+\.(png|jpg|jpeg|webp)$/.test(key)) return bad(400, "invalid_key", "Bad photo key.");
  const o = await env.DIGITAL.get(key);
  if (!o) return bad(404, "not_found", "No such photo.");
  return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType ?? "image/jpeg", "cache-control": "private, max-age=300" } });
}

// ---------------------------------------------------------------------------
export async function adminMerchRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/admin/merch/")) return null;
  const m = req.method;
  try {
    const a = await requireAdmin(req, env);
    if (a instanceof Response) return a;
    const rest = p.slice("/api/admin/merch/".length).split("/");
    const [x, id, act] = rest;
    if (x === "orders") {
      if (rest.length === 1 && m === "GET") return await listOrders(req, env);
      if (rest.length === 2 && m === "GET") return await getOrderRoute(req, env, id);
      if (rest.length === 3 && m === "POST") return await orderAction(req, env, a.uid, id, act);
    }
    if (x === "products") {
      if (rest.length === 1 && m === "GET") return await listProducts(req, env);
      if (rest.length === 3 && act === "review" && m === "POST") return await reviewRoute(req, env, a.uid, id);
    }
    if (x === "settings" && rest.length === 1) {
      if (m === "GET") return out({ settings: await settingsOut(env) });
      if (m === "PUT") return await putSettings(req, env);
    }
    if (x === "platform-wallet" && rest.length === 1 && m === "GET") return await platformWallet(req, env);
    if (x === "problem-photo" && rest.length === 1 && m === "GET") return await problemPhoto(req, env);
    return null;
  } catch (e) {
    await merchFail(env, e, p);
    return bad(500, "internal_error", "Something went wrong.");
  }
}
