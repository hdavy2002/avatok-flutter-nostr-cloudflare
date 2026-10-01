// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Saa Thum Shop orders (Hindu T-shirts, print-on-demand): create, UPI payment,
// receipt, my-orders, problem report. Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.2/§4.3.
//
// The payment side deliberately MIRRORS routes/saathum_checkout.ts (event bookings) -- same unique-amount reservation,
// same "I've paid" -> 180 s -> review_pending rule, same first-writer-wins confirm shared by SMS auto-match / typed UTR /
// admin -- but on its own table (shop_orders), so event bookings are never touched. The rail's dispatcher
// (matchSaathumReceipt) asks this file for shop candidates; see findShopMatchCandidates / confirmShopOrder.
//
// Server-authoritative: the quote is ALWAYS recomputed here from D1 products (computeShopQuote); a client price is ignored.
import { BRAND } from "../lib/brand";
import type { Env } from "../types";
import { requireUser, isFail, requireVerifiedWhatsApp } from "../authz";
import { metaDb } from "../db/shard";
import { json } from "../util";
import { rateLimit } from "../money";
import { readConfig } from "./config";
import { track, trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { policy as hdfcPolicy, UUID } from "../lib/hdfc_sms_smoke";
import { MCC_RE, MERCHANT_REF_RE, readUpiSettings } from "../lib/upi_settings";
import { reserveUniqueAmount, releaseAmount, dropReservation, isMissingShopTable } from "../lib/saathum_upi3";
import {
  validateAddress, normalizeUtr, CHECKOUT_EXPIRY_MS, LATE_SMS_GRACE_MS, AMOUNT_COOLDOWN_MS, type Address,
} from "../lib/saathum_checkout_logic";
import { computeShopQuote, type ShopCartItem, type ProductRow, type CouponRow } from "../lib/shop_logic";
import {
  SHOP_ORDER_ID_RE, SHOP_REFUND_POLICY_VERSION, buildShopOrder, newShopOrderId, shopOrderNo, shopReceiptNo,
  shopExternalStatus, shopOpenForMatching, orderItems, reportWindowOpen, validHttpUrl,
  type ShopOrderRow, type ShopPayCtx, type ShopEventRow,
} from "../lib/shop_orders_logic";
import {
  readShopPolicy, renderShopReceipt, notifyShopEmail, notifyShopWhatsApp, alertOwnerNewShopOrder, alertOwnerShopProblem,
} from "../lib/shop_notify";
import {
  saveToProfile, matchSaathumReceipt, type ConfirmEvidence, type SmsReceiptEvidence,
} from "./saathum_checkout";

const APP = "saathum";
const failure = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, message: extra.message ?? error, ...extra }, status);

async function limited(env: Env, bucket: string, max: number, windowSec = 60) {
  const r = await rateLimit(env, `shop-orders:${bucket}`, max, windowSec);
  return r ? json({ error: "rate_limited", retryable: true }, 429, { "retry-after": r.headers.get("retry-after") ?? "60" }) : null;
}

// ---------------------------------------------------------------------------
// Loading + envelope
// ---------------------------------------------------------------------------
export async function loadShopOrder(env: Env, orderId: string): Promise<ShopOrderRow | null> {
  if (!SHOP_ORDER_ID_RE.test(orderId)) return null;
  return metaDb(env).prepare(`SELECT * FROM shop_orders WHERE order_id=?1`).bind(orderId).first<ShopOrderRow>();
}

/** The caller's own order -- 404 for anyone else's (never leak existence). */
async function loadOwn(env: Env, uid: string, orderId: string): Promise<ShopOrderRow | null> {
  if (!SHOP_ORDER_ID_RE.test(orderId)) return null;
  return metaDb(env).prepare(`SELECT * FROM shop_orders WHERE order_id=?1 AND uid=?2`).bind(orderId, uid).first<ShopOrderRow>();
}

export async function appendShopEvent(env: Env, orderId: string, kind: string, actor: string | null, note: string | null = null, at = Date.now()): Promise<void> {
  await metaDb(env).prepare(`INSERT INTO shop_order_events (order_id, at, kind, actor, note) VALUES (?1,?2,?3,?4,?5)`).bind(orderId, at, kind, actor, note).run();
}

/** UPI/payee/merchant details shared by every envelope built in one request. */
export async function loadShopPayCtx(env: Env, now = Date.now()): Promise<ShopPayCtx> {
  const [p, saved, policy] = await Promise.all([hdfcPolicy(env), readUpiSettings(env), readShopPolicy(env)]);
  // Merchant fields (MCC + static-QR ref) only when the saved ones belong to the VPA in use -- exactly as the event envelope.
  const merchant: Record<string, string> = {};
  if (saved.vpa?.trim() === p.vpa) {
    if (saved.merchant_code && MCC_RE.test(saved.merchant_code)) merchant.mc = saved.merchant_code;
    if (merchant.mc && saved.merchant_ref && MERCHANT_REF_RE.test(saved.merchant_ref)) merchant.tr = saved.merchant_ref;
  }
  return { now, canPay: p.enabled, vpa: p.vpa, payeeName: p.payee_name, merchant, note: `${BRAND.name} shop order`, reportWindowHours: policy.report_window_hours };
}

export async function shopOrderEnvelope(env: Env, row: ShopOrderRow, ctx?: ShopPayCtx) {
  const c = ctx ?? await loadShopPayCtx(env);
  const ev = await metaDb(env).prepare(`SELECT kind, at FROM shop_order_events WHERE order_id=?1 ORDER BY at ASC, id ASC LIMIT 100`).bind(row.order_id).all<ShopEventRow>()
    .catch(() => null);
  return buildShopOrder(row, c, ev?.results ?? []);
}

// ---------------------------------------------------------------------------
// POST /api/shop/orders
// ---------------------------------------------------------------------------
async function createOrder(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const { uid } = auth;
  // Same owner rule as events: no checkout without a verified WhatsApp number.
  const waGate = await requireVerifiedWhatsApp(env, uid);
  if (waGate) {
    void track(env, uid, "whatsapp_required_blocked", APP, { route: "/api/shop/orders" });
    return failure("whatsapp_required", 403, { message: "Verify your WhatsApp number to continue." });
  }
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  if (!b || typeof b !== "object" || typeof b.request_key !== "string" || !UUID.test(b.request_key)) return failure("invalid_request");
  // Owner decision 2026-10-01: BOTH tickboxes are required, server-enforced.
  if (b.accept_terms !== true || b.refund_policy_accepted !== true) {
    return failure("terms_required", 400, { message: "Please agree to the Terms & Conditions and the Refund policy to continue." });
  }
  const throttle = await limited(env, `create:${uid}`, 10); if (throttle) return throttle;
  const db = metaDb(env);

  // Idempotent replay on (uid, request_key).
  const existing = await db.prepare(`SELECT order_id FROM shop_orders WHERE uid=?1 AND request_key=?2`).bind(uid, b.request_key).first<{ order_id: string }>();
  if (existing) {
    await finalizeShopOrderByIntent(env, existing.order_id).catch(() => {});
    const row = await loadOwn(env, uid, existing.order_id);
    if (!row) return failure("not_found", 404);
    return json({ order: await shopOrderEnvelope(env, row) });
  }

  // Address (India only, same validator as events).
  const addr = validateAddress(b.address);
  if (!addr.ok) return failure(addr.error, 400, { message: addr.message, field: addr.field });

  // Server-side quote from D1 -- never trust the client.
  const items = Array.isArray(b.items) ? (b.items as ShopCartItem[]) : null;
  if (!items || items.length < 1 || items.length > 20) return failure("invalid_items", 400, { field: "items" });
  const ids = [...new Set(items.map((i) => (i && typeof i.product_id === "string" ? i.product_id : "")).filter(Boolean))].slice(0, 20);
  if (!ids.length) return failure("invalid_items", 400, { field: "items" });
  const products = new Map<string, ProductRow>();
  const prodRows = await db.prepare(`SELECT * FROM shop_products WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`).bind(...ids).all<ProductRow>();
  for (const pr of prodRows.results ?? []) products.set(pr.id, pr);
  let coupon: CouponRow | null = null;
  if (b.coupon !== undefined && b.coupon !== null && b.coupon !== "") {
    const code = typeof b.coupon === "string" ? b.coupon.trim().toUpperCase().slice(0, 40) : "";
    coupon = code ? await db.prepare(`SELECT * FROM shop_coupons WHERE code=?1`).bind(code).first<CouponRow>() : null;
    if (!coupon) return failure("coupon_invalid", 400, { message: "That coupon code isn't valid.", field: "coupon" });
  }
  const [config, p] = await Promise.all([readConfig(env), hdfcPolicy(env)]);
  const now = Date.now();
  const q = computeShopQuote({ items, products, coupon, gstRatePct: config.saathumGstEnabled === true ? config.gstRatePct : 0, now });
  if (!q.ok) return failure(q.error, 400, { message: q.error, ...(q.field ? { field: q.field } : {}), ...(q.line !== undefined ? { line: q.line } : {}) });
  const quote = q.quote;

  const orderId = newShopOrderId();
  let reservation: Awaited<ReturnType<typeof reserveUniqueAmount>>;
  try {
    reservation = await reserveUniqueAmount(env, {
      account: p.account, totalRupees: quote.total_rupees, checkoutId: orderId, now, expiresAt: now + CHECKOUT_EXPIRY_MS,
    });
  } catch (err) {
    await trackException(env, err, { uid, route: "/api/shop/orders:reserve", method: "POST", handled: true, app_name: APP });
    return failure("checkout_unavailable", 503);
  }
  if (!reservation) {
    console.error("[shop-orders] amount_pool_exhausted", JSON.stringify({ total_rupees: quote.total_rupees }));
    return failure("amount_pool_exhausted", 503, { message: "Too many payments are in progress right now. Please try again in a few minutes.", retryable: true });
  }
  const address: Address = addr.value;
  try {
    await db.prepare(
      `INSERT INTO shop_orders
        (order_id,order_no,uid,request_key,items_json,subtotal_rupees,discount_rupees,coupon_code,gst_rate_pct,gst_rupees,total_rupees,
         address_json,contact_name,terms_accepted_at,refund_policy_accepted_at,refund_policy_version,pay_status,
         receiving_account_key,amount_paise,rounding_discount_paise,expires_at,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?15,'awaiting_payment',?16,?17,?18,?19,?14,?14)`,
    ).bind(
      orderId, shopOrderNo(orderId), uid, b.request_key, JSON.stringify(quote.lines),
      quote.subtotal_rupees, quote.discount_rupees, quote.coupon_code, quote.gst_rate_pct, quote.gst_rupees, quote.total_rupees,
      JSON.stringify(address), address.name, now, SHOP_REFUND_POLICY_VERSION,
      p.account, reservation.amountPaise, reservation.roundingDiscountPaise, now + CHECKOUT_EXPIRY_MS,
    ).run();
  } catch (err) {
    await dropReservation(env, orderId);
    // A parallel request with the same (uid, request_key) won the race: return ITS order.
    const raced = await db.prepare(`SELECT order_id FROM shop_orders WHERE uid=?1 AND request_key=?2`).bind(uid, b.request_key).first<{ order_id: string }>().catch(() => null);
    if (raced) {
      const row = await loadOwn(env, uid, raced.order_id);
      if (row) return json({ order: await shopOrderEnvelope(env, row) });
    }
    await trackException(env, err, { uid, route: "/api/shop/orders", method: "POST", handled: true, app_name: APP });
    return failure("checkout_unavailable", 503);
  }
  await appendShopEvent(env, orderId, "created", uid, null, now).catch((err) => trackException(env, err, { uid, route: "/api/shop/orders:event", handled: true, app_name: APP }));
  // Delivery address saved to the profile (same store the dashboard profile page reads).
  await saveToProfile(env, uid, { address }, now);
  const email = await emailFor(env, uid).catch(() => null);
  await trackUser(env, uid, email, "shop_order_created", APP, {
    order_id: orderId, total_rupees: quote.total_rupees, items: quote.lines.reduce((s, l) => s + l.qty, 0), coupon: quote.coupon_code ?? undefined,
    refund_policy_version: SHOP_REFUND_POLICY_VERSION,
  });
  const created = await loadOwn(env, uid, orderId);
  if (!created) return failure("checkout_unavailable", 503);
  return json({ order: await shopOrderEnvelope(env, created) });
}

// ---------------------------------------------------------------------------
// GET /api/shop/orders/:id   (also reconciles) · POST :id/paid · POST :id/utr
// ---------------------------------------------------------------------------
async function getOrder(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (shopOpenForMatching(row)) {
    await reconcileOpenShopOrder(env, row.order_id).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/shop/orders/:id", method: "GET", handled: true, app_name: APP }));
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  return json({ order: await shopOrderEnvelope(env, row) });
}

async function markPaid(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const throttle = await limited(env, `paid:${auth.uid}`, 20); if (throttle) return throttle;
  let row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  const now = Date.now();
  if (row.pay_status === "awaiting_payment" && row.expires_at > now && !row.paid_claimed_at) {
    const res = await metaDb(env).prepare(
      `UPDATE shop_orders SET paid_claimed_at=?3, updated_at=?3 WHERE order_id=?1 AND uid=?2 AND pay_status='awaiting_payment' AND paid_claimed_at IS NULL`,
    ).bind(id, auth.uid, now).run();
    if (Number((res as any).meta?.changes ?? 0) === 1) await appendShopEvent(env, id, "paid_claimed", auth.uid, null, now).catch(() => {});
    await track(env, auth.uid, "shop_order_paid_claimed", APP, { order_id: id });
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  if (shopOpenForMatching(row)) {
    await reconcileOpenShopOrder(env, row.order_id).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/shop/orders/:id/paid", method: "POST", handled: true, app_name: APP }));
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  return json({ order: await shopOrderEnvelope(env, row) });
}

async function submitUtr(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  const utr = normalizeUtr(b?.utr);
  if (!utr) return failure("reference_must_be_12_digits");
  if (!Number.isSafeInteger(b.expected_reference_revision) || Number(b.expected_reference_revision) < 0) return failure("invalid_request");
  const throttle = await limited(env, `utr:${auth.uid}`, 20); if (throttle) return throttle;
  const row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (row.pay_status !== "awaiting_payment") {
    await track(env, auth.uid, "shop_order_utr_submitted", APP, { ok: false, reason: `status_${row.pay_status}` });
    return json({ order: await shopOrderEnvelope(env, row) });
  }
  const db = metaDb(env);
  // A UTR an EVENT booking already carries on this account is never claimable here either.
  const eventHas = await db.prepare(`SELECT 1 AS x FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 LIMIT 1`).bind(row.receiving_account_key, utr).first().catch(() => null);
  if (eventHas) {
    await track(env, auth.uid, "shop_order_utr_submitted", APP, { ok: false, reason: "reference_conflict" });
    return failure("reference_conflict", 409);
  }
  const now = Date.now();
  try {
    await db.prepare(
      `UPDATE shop_orders SET payer_reference=?3, reference_revision=reference_revision+1, updated_at=?4
       WHERE order_id=?1 AND uid=?2 AND pay_status='awaiting_payment' AND reference_revision=?5 AND payer_reference IS NOT ?3`,
    ).bind(id, auth.uid, utr, now, Number(b.expected_reference_revision)).run();
  } catch {
    // UNIQUE(receiving_account_key, payer_reference): already claimed by another shop order.
    await track(env, auth.uid, "shop_order_utr_submitted", APP, { ok: false, reason: "reference_conflict" });
    return failure("reference_conflict", 409);
  }
  const after = await loadOwn(env, auth.uid, id);
  if (!after) return failure("not_found", 404);
  if (after.payer_reference !== utr) {
    await track(env, auth.uid, "shop_order_utr_submitted", APP, { ok: false, reason: "reference_conflict" });
    return failure("reference_conflict", 409);
  }
  await track(env, auth.uid, "shop_order_utr_submitted", APP, { ok: true });
  await finalizeShopOrderByIntent(env, id).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/shop/orders/:id/utr", method: "POST", handled: true, app_name: APP }));
  const final = (await loadOwn(env, auth.uid, id)) ?? after;
  return json({ order: await shopOrderEnvelope(env, final) });
}

// ---------------------------------------------------------------------------
// GET /api/shop/my-orders · GET :id/receipt.pdf · POST :id/problem
// ---------------------------------------------------------------------------
async function myOrders(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const rows = await metaDb(env).prepare(
    `SELECT * FROM shop_orders WHERE uid=?1 AND NOT (pay_status IN ('expired','cancelled') AND confirmed_at IS NULL)
      ORDER BY created_at DESC LIMIT 100`,
  ).bind(auth.uid).all<ShopOrderRow>();
  const ctx = await loadShopPayCtx(env);
  const out = [];
  for (const row of rows.results ?? []) {
    // A never-paid order whose window passed is effectively expired (computed on read, no cron): hide it too.
    if (!row.confirmed_at && !row.paid_claimed_at && shopExternalStatus(row, ctx.now) === "expired") continue;
    out.push(await shopOrderEnvelope(env, row, ctx));
  }
  return json({ items: out }, 200, { "cache-control": "private, no-store" });
}

export async function shopReceiptPdf(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (shopExternalStatus(row) !== "confirmed" || !row.receipt_no) return failure("not_confirmed", 409, { message: "A receipt is available once the payment is confirmed." });
  const key = `shop-receipts/${auth.uid}/${row.receipt_no}.pdf`;
  const headers = { "content-type": "application/pdf", "content-disposition": `attachment; filename="${row.receipt_no}.pdf"`, "cache-control": "private, no-store" };
  try {
    const cached = await env.DIGITAL.get(key);
    if (cached) return new Response(cached.body, { headers });
  } catch { /* fall through to render */ }
  const email = await emailFor(env, auth.uid).catch(() => null);
  const pdf = await renderShopReceipt(env, row, email);
  try { await env.DIGITAL.put(key, pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { uid: auth.uid, order_id: row.order_id } }); } catch { /* best-effort cache */ }
  return new Response(pdf, { headers });
}

async function reportProblem(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  const message = typeof b?.message === "string" ? b.message.trim() : "";
  if (message.length < 10 || message.length > 1000) return failure("invalid_message", 400, { message: "Please describe the problem in 10 to 1000 characters.", field: "message" });
  let photo: string | null = null;
  if (b.photo_url !== undefined && b.photo_url !== null && b.photo_url !== "") {
    photo = validHttpUrl(b.photo_url);
    if (!photo) return failure("invalid_photo_url", 400, { field: "photo_url" });
  }
  const throttle = await limited(env, `problem:${auth.uid}`, 5, 3600); if (throttle) return throttle;
  const row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  const policy = await readShopPolicy(env);
  const now = Date.now();
  if (row.problem_json) return failure("already_reported", 409, { message: "You have already reported a problem with this order." });
  if (row.fulfil_status !== "delivered") return failure("not_delivered", 409, { message: "You can report a problem once your order is delivered." });
  if (!reportWindowOpen(row, policy.report_window_hours, now)) {
    return failure("window_closed", 409, { message: `Problems must be reported within ${policy.report_window_hours} hours of delivery.` });
  }
  const res = await metaDb(env).prepare(
    `UPDATE shop_orders SET problem_json=?2, updated_at=?3 WHERE order_id=?1 AND problem_json IS NULL AND fulfil_status='delivered'`,
  ).bind(id, JSON.stringify({ message, photo_url: photo, reported_at: now }), now).run();
  if (Number((res as any).meta?.changes ?? 0) !== 1) return failure("already_reported", 409);
  await appendShopEvent(env, id, "problem_reported", auth.uid, message.slice(0, 300), now).catch(() => {});
  const email = await emailFor(env, auth.uid).catch(() => null);
  await trackUser(env, auth.uid, email, "shop_problem_reported", APP, { order_id: id, has_photo: !!photo });
  await alertOwnerShopProblem(env, row, message);
  const after = (await loadOwn(env, auth.uid, id)) ?? row;
  return json({ ok: true, order: await shopOrderEnvelope(env, after) });
}

// ---------------------------------------------------------------------------
// Dispatcher -- routes/shop.ts (catalog) delegates every /api/shop/orders* and /api/shop/my-orders path here.
// ---------------------------------------------------------------------------
export async function shopOrdersRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/shop/orders" && m === "POST") return await createOrder(req, env);
    if (p === "/api/shop/my-orders" && m === "GET") return await myOrders(req, env);
    if (p.startsWith("/api/shop/orders/")) {
      const rest = p.slice("/api/shop/orders/".length).split("/");
      let id: string;
      try { id = decodeURIComponent(rest[0] ?? ""); } catch { return failure("not_found", 404); }
      if (rest.length === 1 && m === "GET") return await getOrder(req, env, id);
      if (rest.length === 2 && rest[1] === "paid" && m === "POST") return await markPaid(req, env, id);
      if (rest.length === 2 && rest[1] === "utr" && m === "POST") return await submitUtr(req, env, id);
      if (rest.length === 2 && rest[1] === "receipt.pdf" && m === "GET") return await shopReceiptPdf(req, env, id);
      if (rest.length === 2 && rest[1] === "problem" && m === "POST") return await reportProblem(req, env, id);
    }
    return null;
  } catch (err) {
    await trackException(env, err, { route: p, method: m, handled: true, app_name: APP, extra: { area: "shop_orders" } });
    return failure("internal", 500, { message: "Something went wrong. Please try again." });
  }
}

// ---------------------------------------------------------------------------
// Payment matching + confirmation (the shop side of the UPI rail)
// ---------------------------------------------------------------------------

/** Typed-UTR path. Idempotent -- safe from GET/UTR and the SMS webhooks. */
export async function finalizeShopOrderByIntent(env: Env, orderId: string): Promise<void> {
  const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM shop_orders WHERE order_id=?1`).bind(orderId).first<ShopOrderRow>();
  if (!row || !shopOpenForMatching(row) || !row.payer_reference) return;
  const receipt = await db.prepare(
    `SELECT message_hash, bank_reference, payer_vpa FROM hdfc_sms_smoke_receipts
      WHERE receiving_account_key=?1 AND bank_reference=?2 AND amount_paise=?3 AND disposition='accepted'
        AND received_at_end_ms>=?4 AND received_at_ms<=?5`,
  ).bind(row.receiving_account_key, row.payer_reference, row.amount_paise, row.created_at, row.expires_at + LATE_SMS_GRACE_MS).first<{ message_hash: string; bank_reference: string; payer_vpa: string | null }>();
  if (!receipt) return;
  await confirmShopOrder(env, orderId, {
    via: "utr", bankReference: row.payer_reference, payerVpa: receipt.payer_vpa, messageHash: receipt.message_hash, expectPayerReference: row.payer_reference,
  });
}

/** UTR path first, then the unique-amount rule. */
export async function reconcileOpenShopOrder(env: Env, orderId: string): Promise<void> {
  await finalizeShopOrderByIntent(env, orderId);
  const row = await metaDb(env).prepare(`SELECT * FROM shop_orders WHERE order_id=?1`).bind(orderId).first<ShopOrderRow>();
  if (!row || !shopOpenForMatching(row)) return;
  const rows = await metaDb(env).prepare(
    `SELECT message_hash, receiving_account_key, bank_reference, amount_paise, received_at_ms, received_at_end_ms, payer_vpa
       FROM hdfc_sms_smoke_receipts
      WHERE receiving_account_key=?1 AND amount_paise=?2 AND disposition='accepted' AND bank_reference IS NOT NULL
        AND claimed_intent_id IS NULL AND received_at_end_ms>=?3 AND received_at_ms<=?4
      ORDER BY received_at_ms ASC LIMIT 3`,
  ).bind(row.receiving_account_key, row.amount_paise, row.created_at, row.expires_at + LATE_SMS_GRACE_MS).all<SmsReceiptEvidence>();
  for (const r of rows.results ?? []) {
    const out = await matchSaathumReceipt(env, r);
    if (out.result === "confirmed" || out.result === "failed") return;
  }
}

/** Is this bank reference / SMS already carried by a shop order? Returns that order's id (the dispatcher's "claimed" check). */
export async function shopReferenceClaimed(env: Env, r: Pick<SmsReceiptEvidence, "receiving_account_key" | "bank_reference" | "message_hash">): Promise<string | null> {
  try {
    const row = await metaDb(env).prepare(
      `SELECT order_id FROM shop_orders WHERE receiving_account_key=?1 AND (payer_reference=?2 OR matched_message_hash=?3) LIMIT 1`,
    ).bind(r.receiving_account_key, r.bank_reference, r.message_hash).first<{ order_id: string }>();
    return row?.order_id ?? null;
  } catch (err) {
    if (!isMissingShopTable(err)) await trackException(env, err, { route: "shop_orders.claimed", handled: true, app_name: APP });
    return null;
  }
}

/** Shop orders on the same account whose payable amount equals this SMS and that are still open (same window rule as events). */
export async function findShopMatchCandidates(env: Env, r: SmsReceiptEvidence): Promise<string[]> {
  try {
    const rows = await metaDb(env).prepare(
      `SELECT order_id FROM shop_orders
        WHERE receiving_account_key=?1 AND amount_paise=?2 AND pay_status IN ('awaiting_payment','review_pending')
          AND confirmed_at IS NULL AND (reason_code IS NULL OR reason_code NOT IN ('provisioning_failed','finalize_error'))
          AND created_at<=?3 AND ?4<=expires_at+?5
        LIMIT 3`,
    ).bind(r.receiving_account_key, r.amount_paise, r.received_at_end_ms, r.received_at_ms, LATE_SMS_GRACE_MS).all<{ order_id: string }>();
    return (rows.results ?? []).map((x) => x.order_id);
  } catch (err) {
    if (!isMissingShopTable(err)) await trackException(env, err, { route: "shop_orders.candidates", handled: true, app_name: APP });
    return [];
  }
}

/** Ingest hook: a shop order waiting on exactly this (account, UTR, amount) is finalised. Never throws. */
export async function finalizeWaitingShopOrder(env: Env, receipt: { receiving_account_key: string; bank_reference: string | null; amount_paise: number }): Promise<void> {
  if (!receipt.bank_reference) return;
  try {
    const waiting = await metaDb(env).prepare(
      `SELECT order_id FROM shop_orders WHERE receiving_account_key=?1 AND payer_reference=?2 AND amount_paise=?3 AND pay_status IN ('awaiting_payment','review_pending') AND confirmed_at IS NULL`,
    ).bind(receipt.receiving_account_key, receipt.bank_reference, receipt.amount_paise).first<{ order_id: string }>();
    if (waiting) await finalizeShopOrderByIntent(env, waiting.order_id);
  } catch (err) {
    if (!isMissingShopTable(err)) await trackException(env, err, { route: "shop_orders.ingest", handled: true, app_name: APP });
  }
}

/** Ingest ack: has a shop order already been confirmed with this bank reference? Never throws. */
export async function shopOrderConfirmedForReference(env: Env, account: string, bankReference: string | null): Promise<boolean> {
  if (!bankReference) return false;
  try {
    const hit = await metaDb(env).prepare(`SELECT 1 AS x FROM shop_orders WHERE receiving_account_key=?1 AND payer_reference=?2 AND pay_status='confirmed'`).bind(account, bankReference).first();
    return !!hit;
  } catch (err) {
    if (!isMissingShopTable(err)) await trackException(env, err, { route: "shop_orders.ack", handled: true, app_name: APP });
    return false;
  }
}

/**
 * First-writer-wins confirmation shared by SMS auto-match, typed UTR and admin. "confirmed" once the claim succeeded,
 * "lost" when another writer got there first (or the bank reference is already on another order). A shop order has no
 * provisioning step, so once the claim lands the payment IS confirmed; bookkeeping/notification failures are reported to
 * PostHog but never un-confirm it ("failed" is only returned if the row vanished).
 */
export async function confirmShopOrder(env: Env, orderId: string, ev: ConfirmEvidence): Promise<"confirmed" | "lost" | "failed"> {
  const db = metaDb(env);
  const now = Date.now();
  const admin = ev.via === "admin";
  let claim;
  try {
    claim = await db.prepare(
      `UPDATE shop_orders SET pay_status='confirmed', payer_reference=COALESCE(?2,payer_reference), utr=COALESCE(?2,payer_reference),
              confirmed_at=?3, updated_at=?3, reason_code=NULL, payer_vpa=COALESCE(?4,payer_vpa), matched_message_hash=?5,
              confirm_source=?6, reviewed_by=COALESCE(?7,reviewed_by), review_note=COALESCE(?8,review_note),
              reviewed_at=CASE WHEN ?7 IS NULL THEN reviewed_at ELSE ?3 END, receipt_no=COALESCE(receipt_no,?11)
        WHERE order_id=?1 AND pay_status IN ('awaiting_payment','review_pending')
          AND (?9=1 OR confirmed_at IS NULL) AND (?10 IS NULL OR payer_reference=?10)`,
    ).bind(orderId, ev.bankReference, now, ev.payerVpa ?? null, ev.messageHash ?? null, ev.via, ev.adminUid ?? null, ev.note ?? null, admin ? 1 : 0, ev.expectPayerReference ?? null, shopReceiptNo(orderId, now)).run();
  } catch {
    // UNIQUE(receiving_account_key, payer_reference): this bank transaction is already on another shop order.
    return "lost";
  }
  if (Number((claim as any).meta?.changes ?? 0) !== 1) return "lost";
  const row = await db.prepare(`SELECT * FROM shop_orders WHERE order_id=?1`).bind(orderId).first<ShopOrderRow>();
  if (!row) return "failed";

  try {
    await releaseAmount(env, orderId, now); // payment consumed: the slot is free again
    // Bookkeeping in ONE batch: event row, product sold counts, coupon use.
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO shop_order_events (order_id, at, kind, actor, note) VALUES (?1,?2,'confirmed',?3,?4)`).bind(orderId, now, ev.adminUid ?? ev.via, ev.note ?? ev.via),
    ];
    const qtyByProduct = new Map<string, number>();
    for (const l of orderItems(row)) if (l.product_id) qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) ?? 0) + l.qty);
    for (const [pid, qty] of qtyByProduct) stmts.push(db.prepare(`UPDATE shop_products SET sold_count=sold_count+?2 WHERE id=?1`).bind(pid, qty));
    if (row.coupon_code) stmts.push(db.prepare(`UPDATE shop_coupons SET used_count=used_count+1, updated_at=?2 WHERE code=?1`).bind(row.coupon_code, now));
    await db.batch(stmts);
  } catch (err) {
    await trackException(env, err, { uid: row.uid, route: "confirmShopOrder:bookkeeping", handled: true, app_name: APP });
  }
  const email = await emailFor(env, row.uid).catch(() => null);
  await trackUser(env, row.uid, email, "shop_order_confirmed", APP, {
    order_id: orderId, total_rupees: row.total_rupees, pay_amount_paise: row.amount_paise, via: ev.via, admin_uid: ev.adminUid ?? undefined,
  });
  await notifyShopEmail(env, "confirmed", row);
  await notifyShopWhatsApp(env, "shop_order_confirmed", row);
  await alertOwnerNewShopOrder(env, row);
  return "confirmed";
}

/**
 * Admin reject: order -> cancelled/rejected, the amount slot cools down for 2 h, the buyer hears (softly) by email +
 * WhatsApp that we could not find the payment. Only an unconfirmed order can be rejected. Returns false when not rejectable.
 */
export async function rejectShopOrder(env: Env, orderId: string, adminUid: string, reason: string): Promise<boolean> {
  const db = metaDb(env);
  const now = Date.now();
  const res = await db.prepare(
    `UPDATE shop_orders SET pay_status='cancelled', reason_code='rejected', review_note=?2, reviewed_by=?3, reviewed_at=?4, updated_at=?4
      WHERE order_id=?1 AND pay_status IN ('awaiting_payment','review_pending') AND confirmed_at IS NULL`,
  ).bind(orderId, reason, adminUid, now).run();
  if (Number((res as any).meta?.changes ?? 0) !== 1) return false;
  await releaseAmount(env, orderId, now, AMOUNT_COOLDOWN_MS);
  const row = await db.prepare(`SELECT * FROM shop_orders WHERE order_id=?1`).bind(orderId).first<ShopOrderRow>();
  if (row) {
    await appendShopEvent(env, orderId, "rejected", adminUid, reason.slice(0, 300), now).catch((err) => trackException(env, err, { uid: row.uid, route: "rejectShopOrder:event", handled: true, app_name: APP }));
    await track(env, row.uid, "shop_order_rejected", APP, { order_id: orderId, admin_uid: adminUid });
    await notifyShopWhatsApp(env, "shop_order_rejected", row);
    await notifyShopEmail(env, "rejected", row);
  }
  return true;
}
