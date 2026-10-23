// [HF-MERCH-CORE-1 2026-10-23] The merch order lifecycle (spec sections 1, 3, 5, 6): checkout -> paid -> admin approve -> partner -> shipped -> delivered,
// and reject / refund. Every state change is a compare-and-set UPDATE (exactly one caller wins) and every money write has a fixed op id, so a retry, a
// double click, a webhook replay and the safety-net cron can all run the same step without doing it twice.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { resolveGateway } from "./payments/registry";
import { topupCustomer } from "./hf_topup_customer";
import { validateAddress, type Address } from "./saathum_checkout_logic";
import { newShopOrderId, shopOrderNo, shopReceiptNo, SHOP_REFUND_POLICY_VERSION, type ShopOrderRow } from "./shop_orders_logic";
import { appendShopEvent } from "../routes/shop_orders";
import { sendOrderToPartner, advanceOrder } from "./pod_fulfil";
import { computeMerchMoney, quoteAgainstLive, readMerchCfg, type CostQuote, type MerchCfg, type PayMethod } from "./hf_merch_math";
import { parseJson, type MerchSnapshot } from "./hf_merch_types";
import {
  getOrder, productMerch, platformEntry, saveAddress, type MerchHost, type MerchProductRow, type PlatformKind,
} from "./hf_merch_store";
import { liveBaseUnitForOrder } from "./hf_merch_catalog";
import { refundWalletForOrder, spendWalletForOrder } from "./hf_merch_wallet";
import { creditMerchEarning, reverseMerchEarning } from "./hf_merch_delivered";
import {
  alertOwnerMerchRefund, merchFail, merchPush, merchTrack, notifyMerchApproved, notifyMerchPaid, notifyMerchRejected, notifyMerchStatusPush, snapOf,
} from "./hf_merch_notify";

export type FlowFail = { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };
const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): FlowFail => ({ ok: false, status, error, message, extra });
const hexId = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function merchCfg(env: Env): Promise<{ cfg: MerchCfg; flags: { enabled: boolean; checkout: boolean; autoApprove: boolean; productReview: boolean } }> {
  const all = (await readConfig(env)) as unknown as Record<string, unknown>;
  return {
    cfg: readMerchCfg(all),
    flags: { enabled: all.hfMerchEnabled === true, checkout: all.hfMerchCheckoutEnabled === true, autoApprove: all.hfMerchAutoApprove === true, productReview: all.hfMerchProductReview !== false },
  };
}

/** Cashfree orders: how long we hold the row open waiting for the webhook / poll. A late payment is still accepted (the money is in). */
export const MERCH_PAY_WINDOW_MS = 2 * 60 * 60 * 1000;
export const MERCH_QTY_MAX = 3;

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
export type CheckoutInput = {
  uid: string; product: MerchProductRow; host: MerchHost; colour: string; size: string; qty: number; address: unknown; saveAddress: boolean;
  method: PayMethod; requestKey: string; client?: "app" | "web"; gstNote?: never;
};
export type CheckoutOk = { ok: true; order: ShopOrderRow; created: boolean; checkoutUrl?: string | null; paymentSessionId?: string | null };

export async function startMerchCheckout(env: Env, i: CheckoutInput): Promise<CheckoutOk | FlowFail> {
  const db = metaDb(env);
  const { cfg } = await merchCfg(env);
  const existing = await db.prepare("SELECT * FROM shop_orders WHERE uid=?1 AND request_key=?2").bind(i.uid, i.requestKey).first<ShopOrderRow>();
  if (existing) {
    if (existing.seller_uid == null) return fail(409, "request_key_used", "That request id was already used.");
    return finishCheckout(env, existing, false, i);
  }
  const pm = productMerch(i.product);
  if (!pm || i.product.review_status !== "live" || i.product.deleted_at) return fail(410, "gone", "This product is no longer available.");
  const sz = pm.sizes.find((s) => s.size.toLowerCase() === i.size.toLowerCase());
  const col = pm.colours.find((c) => c.name.toLowerCase() === i.colour.toLowerCase());
  if (!sz) return fail(400, "bad_size", "Pick one of the sizes shown.", { field: "size" });
  if (!col) return fail(400, "bad_colour", "Pick one of the colours shown.", { field: "colour" });
  const qty = Math.trunc(i.qty);
  if (!(qty >= 1 && qty <= MERCH_QTY_MAX)) return fail(400, "bad_qty", `You can order 1 to ${MERCH_QTY_MAX} at a time.`, { field: "qty" });
  const addr = validateAddress(i.address);
  if (!addr.ok) return fail(400, addr.error, addr.message, { field: addr.field });
  const a: Address = addr.value;
  if (!a.phone) return fail(400, "invalid_phone", "A 10-digit mobile number is needed for delivery.", { field: "phone" });
  if (a.line1.length > 50 || (a.line2 ?? "").length > 50) return fail(400, "address_line_too_long", "Each address line can be at most 50 characters. Use both lines.", { field: a.line1.length > 50 ? "line1" : "line2" });

  const markupUnit = Math.trunc(Number(i.product.markup_rupees ?? 0)) * 100;
  const money = computeMerchMoney({ baseUnitPaise: sz.baseUnitPaise, markupUnitPaise: markupUnit, qty, payMethod: i.method, cfg });
  if (money.totalPaise < 100 || money.totalPaise % 100 !== 0) return fail(409, "bad_price", "This product's price is not valid right now.");
  const orderId = newShopOrderId();
  const now = Date.now();
  const snap: MerchSnapshot = {
    v: 1, sellerUid: i.product.seller_uid as string, hostSlug: i.host.slug, hostName: i.host.displayName, productId: i.product.id, productSlug: pm.productSlug, title: i.product.name,
    imageUrl: pm.mockups[0] ?? pm.printPreviewUrl ?? pm.artUrl ?? null, catalogId: pm.catalogId, catalogName: pm.catalogName, colour: col.name, size: sz.size, qty, side: pm.side,
    printFileUrl: pm.printPreviewUrl, money, payMethod: i.method, holdDays: cfg.holdDays,
    printWIn: Number((pm.placement as { print_w_in?: number }).print_w_in ?? 0), printHIn: Number((pm.placement as { print_h_in?: number }).print_h_in ?? 0), bufferRupees: pm.bufferRupees ?? 0,
  };
  const totalRupees = money.totalPaise / 100;
  const items = [{ product_id: i.product.id, slug: i.product.slug, name: i.product.name, colour: col.name, size: sz.size, qty, unit_rupees: money.unitPaise / 100, amount_rupees: totalRupees, image_url: snap.imageUrl }];
  try {
    await db.prepare(
      `INSERT INTO shop_orders (order_id, order_no, uid, request_key, items_json, subtotal_rupees, discount_rupees, coupon_code, gst_rate_pct, gst_rupees, total_rupees,
         address_json, contact_name, terms_accepted_at, refund_policy_accepted_at, refund_policy_version, pay_status, receiving_account_key, amount_paise, rounding_discount_paise,
         expires_at, fulfil_status, created_at, updated_at, seller_uid, pay_method, merch_json, approval_status, refund_status)
       VALUES (?1,?2,?3,?4,?5,?6,0,NULL,0,0,?6,?7,?8,?9,?9,?10,'awaiting_payment',?11,?12,0,?13,'new',?9,?9,?14,?15,?16,'pending','none')`,
    ).bind(orderId, shopOrderNo(orderId), i.uid, i.requestKey, JSON.stringify(items), totalRupees, JSON.stringify(a), a.name, now, SHOP_REFUND_POLICY_VERSION,
      i.method === "wallet" ? "hf_wallet" : "cashfree", money.totalPaise, now + MERCH_PAY_WINDOW_MS, i.product.seller_uid, i.method, JSON.stringify(snap)).run();
  } catch (e) {
    const again = await db.prepare("SELECT * FROM shop_orders WHERE uid=?1 AND request_key=?2").bind(i.uid, i.requestKey).first<ShopOrderRow>();
    if (again) return finishCheckout(env, again, false, i);
    await merchFail(env, e, "checkout_insert", i.uid);
    return fail(503, "checkout_unavailable", "We could not start your order. Please try again in a moment.");
  }
  await appendShopEvent(env, orderId, "created", i.uid, i.method, now).catch((e) => merchFail(env, e, "checkout_event", i.uid));
  if (i.saveAddress) await saveAddress(env, i.uid, { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, pincode: a.pincode }).catch((e) => merchFail(env, e, "save_address", i.uid));
  await merchTrack(env, i.uid, "merch_checkout_started", { order_id: orderId, product_id: i.product.id, seller_uid: i.product.seller_uid, method: i.method, total_paise: money.totalPaise, qty });
  const row = (await getOrder(env, orderId)) as ShopOrderRow;
  return finishCheckout(env, row, true, i);
}

/** Take the money for an order that exists (also the retry path of an idempotent request). */
async function finishCheckout(env: Env, row: ShopOrderRow, created: boolean, i: CheckoutInput): Promise<CheckoutOk | FlowFail> {
  if (row.pay_status === "confirmed") return { ok: true, order: row, created };
  if (row.pay_status === "cancelled" || row.pay_status === "expired") return fail(409, "order_closed", "That order was cancelled. Please start again.");
  if (row.pay_method === "wallet") {
    const s = await spendWalletForOrder(env, row.uid, row.order_id, row.amount_paise);
    if (!s.ok) {
      if (s.reason === "insufficient") {
        await cancelUnpaid(env, row.order_id, "insufficient_balance");
        return fail(402, "insufficient_balance", "Your wallet does not have enough money for this order.", { shortPaise: s.shortPaise, balancePaise: s.balancePaise, ...(s.testCreditNotUsable ? { testCreditNotUsable: true } : {}) });
      }
      await cancelUnpaid(env, row.order_id, `wallet_${s.reason}`);
      return fail(s.reason === "debt" ? 409 : 503, s.reason === "debt" ? "wallet_debt" : "wallet_unavailable", s.reason === "debt" ? "Clear the amount you owe in your wallet first." : "The wallet could not be charged. Please try again.");
    }
    await metaDb(env).prepare("UPDATE shop_orders SET wallet_op_id=?2 WHERE order_id=?1 AND wallet_op_id IS NULL").bind(row.order_id, `hftset:merch:${row.order_id}`).run();
    const done = await settleMerchPayment(env, row.order_id, { via: "wallet", reference: `hftset:merch:${row.order_id}` });
    const fresh = (await getOrder(env, row.order_id)) ?? row;
    return done === "failed" ? fail(503, "checkout_unavailable", "Your payment went through but the order is not confirmed yet. We will fix it shortly; check My orders.") : { ok: true, order: fresh, created };
  }
  // Cashfree
  // A retry of the same request must not create the Cashfree order a second time (same id -> gateway error): reuse the stored session.
  if (row.cashfree_order_id) {
    const was = await reconcileCashfreeOrder(env, row.order_id).catch(() => "unavailable" as const);
    if (was === "confirmed" || was === "duplicate") return { ok: true, order: (await getOrder(env, row.order_id)) ?? row, created };
    const kept = await env.TOKENS.get(`merch:cfs:${row.order_id}`, "json").catch(() => null) as { checkoutUrl?: string | null; paymentSessionId?: string | null } | null;
    if (kept && (kept.checkoutUrl || kept.paymentSessionId)) return { ok: true, order: row, created, checkoutUrl: kept.checkoutUrl ?? null, paymentSessionId: kept.paymentSessionId ?? null };
  }
  const adapter = resolveGateway("cashfree");
  if (!adapter || !adapter.configured(env)) {
    await cancelUnpaid(env, row.order_id, "gateway_unconfigured");
    return fail(503, "payments_unavailable", "Card and UPI payments are not available right now. You can pay from your wallet instead.");
  }
  const client = i.client === "app" ? "app" : "web";
  const given = parseJson<Partial<Address>>(row.address_json, {});
  const customer = await topupCustomer(env, row.uid, { name: given.name ?? null }).catch(() => ({ phone: null, email: null, name: null }));
  const gw = await adapter.createOrder(env, { orderId: row.order_id, amountPaise: row.amount_paise, currency: "INR", uid: row.uid, listingId: "", kind: "hf_merch", client, customer, checkoutMode: "web" });
  if ("error" in gw) {
    if (gw.error === "customer_phone_required") return fail(409, "whatsapp_required", "Verify your WhatsApp number in Settings before paying.", { reason: "whatsapp_required" });
    await merchFail(env, new Error(`cashfree_create_order:${gw.error}`), "cashfree_create", row.uid, { order_id: row.order_id });
    return fail(502, "gateway_error", "We could not start the payment. Please try again in a moment.");
  }
  await metaDb(env).prepare("UPDATE shop_orders SET cashfree_order_id=?2, updated_at=?3 WHERE order_id=?1").bind(row.order_id, gw.gateway_order_id, Date.now()).run();
  const cp = (gw.client_payload ?? {}) as Record<string, unknown>;
  const kept = { checkoutUrl: typeof cp.checkout_url === "string" ? cp.checkout_url : null, paymentSessionId: typeof cp.payment_session_id === "string" ? cp.payment_session_id : null };
  await env.TOKENS.put(`merch:cfs:${row.order_id}`, JSON.stringify(kept), { expirationTtl: 3 * 3600 }).catch(() => undefined);
  return {
    ok: true, order: (await getOrder(env, row.order_id)) ?? row, created,
    checkoutUrl: typeof cp.checkout_url === "string" ? cp.checkout_url : null, paymentSessionId: typeof cp.payment_session_id === "string" ? cp.payment_session_id : null,
  };
}

/** An order that was never paid: close it so it disappears from lists (no money moved). */
export async function cancelUnpaid(env: Env, orderId: string, reason: string): Promise<boolean> {
  const r = await metaDb(env).prepare(
    "UPDATE shop_orders SET pay_status='cancelled', reason_code=?2, cancel_reason=?2, updated_at=?3 WHERE order_id=?1 AND pay_status IN ('awaiting_payment','review_pending') AND confirmed_at IS NULL",
  ).bind(orderId, reason.slice(0, 80), Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Payment confirmed (wallet charge done, or Cashfree verified by a server-to-server read)
// ---------------------------------------------------------------------------
export type PaidEvidence = { via: "wallet" | "cashfree"; reference: string };
export async function settleMerchPayment(env: Env, orderId: string, ev: PaidEvidence): Promise<"confirmed" | "duplicate" | "failed"> {
  const db = metaDb(env);
  const now = Date.now();
  const claim = await db.prepare(
    `UPDATE shop_orders SET pay_status='confirmed', confirmed_at=?2, confirm_source=?3, utr=NULL, reason_code=NULL, updated_at=?2, receipt_no=COALESCE(receipt_no,?4),
            cashfree_order_id=COALESCE(cashfree_order_id,?5)
      WHERE order_id=?1 AND seller_uid IS NOT NULL AND pay_status IN ('awaiting_payment','review_pending','expired') AND confirmed_at IS NULL`,
  ).bind(orderId, now, ev.via, shopReceiptNo(orderId, now), ev.via === "cashfree" ? orderId : null).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) {
    const cur = await getOrder(env, orderId);
    return cur?.pay_status === "confirmed" ? "duplicate" : "failed";
  }
  const row = await getOrder(env, orderId);
  if (!row) return "failed";
  try {
    const stmts: D1PreparedStatement[] = [
      db.prepare("INSERT INTO shop_order_events (order_id, at, kind, actor, note) VALUES (?1,?2,'confirmed',?3,?4)").bind(orderId, now, ev.via, ev.via),
    ];
    const snap = snapOf(row);
    if (snap.productId) stmts.push(db.prepare("UPDATE shop_products SET sold_count=sold_count+?2 WHERE id=?1").bind(snap.productId, Number(snap.qty ?? 1)));
    await db.batch(stmts);
  } catch (e) { await merchFail(env, e, "settle_bookkeeping", row.uid, { order_id: orderId }); }
  const snap = snapOf(row);
  await merchTrack(env, row.uid, "merch_order_paid", {
    order_id: orderId, seller_uid: row.seller_uid, method: ev.via, total_paise: row.amount_paise, qty: snap.qty, influencer_paise: snap.money?.influencerPaise, platform_paise: snap.money?.platformPaise,
  });
  await notifyMerchPaid(env, row);
  const { flags } = await merchCfg(env);
  if (flags.autoApprove) {
    const r = await approveMerchOrder(env, orderId, "system:auto", { auto: true });
    if (!r.ok) await merchTrack(env, row.uid, "merch_auto_approve_skipped", { order_id: orderId, error: r.error });
  }
  return "confirmed";
}

/** Cashfree evidence: webhook or poll. The gateway is asked server-to-server; only PAID for the same amount confirms. */
export async function reconcileCashfreeOrder(env: Env, orderId: string): Promise<"confirmed" | "duplicate" | "pending" | "failed" | "mismatch" | "unavailable"> {
  const row = await getOrder(env, orderId);
  if (!row || row.pay_method !== "cashfree") return "failed";
  if (row.pay_status === "confirmed") return "duplicate";
  if (row.pay_status === "cancelled") return "failed";
  const adapter = resolveGateway("cashfree");
  if (!adapter || !adapter.configured(env)) return "unavailable";
  const truth = await adapter.fetchOrder(env, row.cashfree_order_id ?? row.order_id);
  if (!truth) return "unavailable";
  const st = String(truth.status).toUpperCase();
  if (st !== "PAID") return st === "EXPIRED" || st === "TERMINATED" ? "failed" : "pending";
  if (truth.amount_paise !== row.amount_paise) { await merchFail(env, new Error("merch_amount_mismatch"), "cashfree_amount", row.uid, { order_id: orderId, paid: truth.amount_paise, expected: row.amount_paise }); return "mismatch"; }
  const r = await settleMerchPayment(env, orderId, { via: "cashfree", reference: row.cashfree_order_id ?? row.order_id });
  return r === "confirmed" ? "confirmed" : r === "duplicate" ? "duplicate" : "failed";
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------
export type LiveQuote = CostQuote & { stale: boolean; liveBaseUnitPaise: number; frozenBaseUnitPaise: number; source: string };
export type QuoteResult = { ok: true; quote: LiveQuote } | { ok: false; error: "quote_unavailable"; message: string };

export async function quoteMerchOrder(env: Env, row: ShopOrderRow): Promise<QuoteResult> {
  const snap = snapOf(row);
  const addr = parseJson<Partial<Address>>(row.address_json, {});
  const live = await liveBaseUnitForOrder(env, snap, addr.pincode ?? null);
  if (!live.ok || !snap.money) return { ok: false, error: "quote_unavailable", message: live.ok ? "This order has no price snapshot." : live.message };
  const q = quoteAgainstLive(snap.money, live.liveBaseUnitPaise);
  return { ok: true, quote: { ...q, stale: live.stale, liveBaseUnitPaise: live.liveBaseUnitPaise, frozenBaseUnitPaise: snap.money.baseUnitPaise, source: live.source } };
}

export type ApproveOk = { ok: true; fulfilment: { provider_order_id: string | null; status: string } | null; manual: boolean; partnerError: string | null; quote: LiveQuote | null };

export async function approveMerchOrder(env: Env, orderId: string, actor: string, opts: { auto?: boolean; acceptStaleQuote?: boolean } = {}): Promise<ApproveOk | FlowFail> {
  const row = await getOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.pay_status !== "confirmed") return fail(409, "not_paid", "This order has not been paid yet.");
  if (row.approval_status === "approved") return fail(409, "already_approved", "This order is already approved.");
  if (row.approval_status !== "pending" || row.fulfil_status !== "new" || (row.refund_status && row.refund_status !== "none")) return fail(409, "bad_transition", "This order can no longer be approved.");

  const q = await quoteMerchOrder(env, row);
  let quote: LiveQuote | null = null;
  if (q.ok) {
    quote = q.quote;
    if (quote.costRose) {
      await merchTrack(env, actor.startsWith("system:") ? row.uid : actor, "merch_cost_rose", {
        order_id: orderId, rise_paise: quote.risePaise, platform_net_after_paise: quote.platformNetAfterPaise, frozen_base_unit_paise: quote.frozenBaseUnitPaise, live_base_unit_paise: quote.liveBaseUnitPaise,
      });
      return fail(409, "cost_rose", "The print cost went up and this order would now lose money. Reject and refund it, or ask the buyer to reorder.", { liveQuote: quote });
    }
  } else if (!opts.acceptStaleQuote) {
    return fail(503, "quote_unavailable", `${q.message} Try again, or approve anyway if you accept the risk.`, { canForce: !opts.auto });
  }

  const now = Date.now();
  const db = metaDb(env);
  const claim = await db.prepare(
    "UPDATE shop_orders SET approval_status='approved', approved_by=?2, approved_at=?3, updated_at=?3 WHERE order_id=?1 AND approval_status='pending' AND pay_status='confirmed' AND fulfil_status='new'",
  ).bind(orderId, actor, now).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return fail(409, "bad_transition", "Someone else just changed this order. Reload and try again.");
  const snap = snapOf(row);
  const m = snap.money;
  if (m) {
    const baseOwed = quote ? quote.liveBasePaise : m.basePaise;
    await platformEntry(env, "merch_share", m.platformPaise, orderId, row.seller_uid ?? null, "markup share");
    await platformEntry(env, "printrove_cost", -baseOwed, orderId, row.seller_uid ?? null, "print partner cost payable");
    if (m.cashfreeFeeEstPaise > 0) await platformEntry(env, "cashfree_fee", -m.cashfreeFeeEstPaise, orderId, row.seller_uid ?? null, "estimate");
    await platformEntry(env, "gst", -m.gstEstPaise, orderId, row.seller_uid ?? null, "estimate");
  }
  await appendShopEvent(env, orderId, "approved", actor, opts.auto ? "auto" : null, now).catch((e) => merchFail(env, e, "approve_event", row.uid));
  await merchTrack(env, actor.startsWith("system:") ? row.uid : actor, "merch_order_approved", {
    order_id: orderId, seller_uid: row.seller_uid, buyer_uid: row.uid, auto: !!opts.auto, platform_net_after_paise: quote?.platformNetAfterPaise, quote_stale: quote?.stale ?? true,
  });

  // Queue it with the print partner (the same idempotent path the rest of the shop uses).
  let fulfilment: ApproveOk["fulfilment"] = null, manual = false, partnerError: string | null = null;
  const sent = await sendOrderToPartner(env, orderId, actor.startsWith("system:") ? actor : actor);
  if (sent.ok) fulfilment = sent.fulfilment ? { provider_order_id: sent.fulfilment.provider_order_id, status: sent.fulfilment.status } : null;
  else if (sent.error === "manual_provider") manual = true;
  else partnerError = sent.message;
  const after = (await getOrder(env, orderId)) ?? row;
  // When the partner took it, the shop's own "gone to print" message follows; otherwise tell the buyer it is approved.
  if (after.fulfil_status !== "at_printer") await notifyMerchApproved(env, after);
  return { ok: true, fulfilment, manual, partnerError, quote };
}

// ---------------------------------------------------------------------------
// Reject / refund
// ---------------------------------------------------------------------------
export type RefundResult = "done" | "pending_manual" | "pending_gateway";
export const merchRefundId = (orderId: string) => `mrf_${orderId.replace(/^shp_/, "")}`;

/** Give the buyer's money back the way it came. Wallet: instant + idempotent. Cashfree: refund API, else a person is alerted. Never throws. */
export async function refundMerchPayment(env: Env, row: ShopOrderRow): Promise<RefundResult> {
  const db = metaDb(env);
  const done = async (note: string): Promise<RefundResult> => {
    await db.prepare("UPDATE shop_orders SET refund_status='done', refunded_at=COALESCE(refunded_at,?2), updated_at=?2 WHERE order_id=?1 AND COALESCE(refund_status,'none')<>'done'").bind(row.order_id, Date.now()).run();
    await appendShopEvent(env, row.order_id, "refunded", "system", note).catch(() => undefined);
    return "done";
  };
  const manual = async (why: string): Promise<RefundResult> => {
    const r = await db.prepare("UPDATE shop_orders SET refund_status='pending_manual', updated_at=?2 WHERE order_id=?1 AND COALESCE(refund_status,'none') NOT IN ('done','pending_manual')").bind(row.order_id, Date.now()).run();
    if (Number(r.meta?.changes ?? 0) === 1) { await appendShopEvent(env, row.order_id, "refund_pending", "system", why.slice(0, 200)).catch(() => undefined); await alertOwnerMerchRefund(env, row, why); }
    return "pending_manual";
  };
  try {
    if (row.pay_method === "wallet") {
      const r = await refundWalletForOrder(env, row.uid, row.order_id);
      if (r.ok || r.reason === "nothing_spent") return done(r.ok ? `wallet ${r.refundedPaise}` : "nothing charged");
      return manual("The wallet refund did not go through.");
    }
    const adapter = resolveGateway("cashfree");
    if (!adapter || !adapter.configured(env)) return manual("Cashfree is not configured, refund by hand.");
    const opId = merchRefundId(row.order_id);
    const rf = await adapter.refund(env, { gatewayOrderId: row.cashfree_order_id ?? row.order_id, amountPaise: row.amount_paise, reason: `Order ${row.order_no} cancelled`, opId });
    if (rf.accepted) {
      // Cashfree ACCEPTED the refund; it is not money back yet. Stay 'pending_gateway' until Cashfree says SUCCESS (tick / refund webhook).
      const r = await db.prepare("UPDATE shop_orders SET refund_status='pending_gateway', updated_at=?2 WHERE order_id=?1 AND COALESCE(refund_status,'none') IN ('none','refunding')").bind(row.order_id, Date.now()).run();
      if (Number(r.meta?.changes ?? 0) === 1) await appendShopEvent(env, row.order_id, "refund_started", "system", `cashfree refund ${opId}`).catch(() => undefined);
      return "pending_gateway";
    }
    return manual(`Cashfree said: ${rf.error ?? "refund not accepted"}`);
  } catch (e) {
    await merchFail(env, e, "refund", row.uid, { order_id: row.order_id });
    return manual("The refund hit an error; check it by hand.");
  }
}

/**
 * A Cashfree refund that was accepted: ask Cashfree whether it finished. SUCCESS -> done (+ push); FAILED / CANCELLED / not found for an hour -> a person (pending_manual + owner alert);
 * still PENDING -> wait (a week at most). Idempotent; never throws.
 */
export async function confirmCashfreeRefund(env: Env, orderId: string): Promise<"done" | "pending" | "manual" | "unknown"> {
  try {
    const row = await getOrder(env, orderId);
    if (!row || row.refund_status !== "pending_gateway") return row?.refund_status === "done" ? "done" : "unknown";
    const adapter = resolveGateway("cashfree");
    if (!adapter?.listRefunds || !adapter.configured(env)) return "unknown";
    const f = await adapter.listRefunds(env, { gatewayOrderId: row.cashfree_order_id ?? row.order_id, opId: merchRefundId(orderId) });
    if (!f) return "unknown";
    const db = metaDb(env);
    const now = Date.now();
    const age = now - Number(row.updated_at);
    if (f.found && f.status === "SUCCESS") {
      const r = await db.prepare("UPDATE shop_orders SET refund_status='done', refunded_at=COALESCE(refunded_at,?2), fulfil_status=CASE WHEN fulfil_status='cancelled' THEN 'refunded' ELSE fulfil_status END, updated_at=?2 WHERE order_id=?1 AND refund_status='pending_gateway'").bind(orderId, now).run();
      if (Number(r.meta?.changes ?? 0) === 1) {
        await appendShopEvent(env, orderId, "refunded", "system", `cashfree refund ${merchRefundId(orderId)} succeeded`).catch(() => undefined);
        await merchPush(env, row.uid, "merch_update", `Order ${row.order_no} refunded`, "Your refund has been sent back to the account you paid from.", `/dashboard/orders?order=${row.order_id}`);
      }
      return "done";
    }
    const failed = f.found && (f.status === "FAILED" || f.status === "CANCELLED");
    if (failed || (!f.found && age > 3_600_000) || age > 7 * 86_400_000) {
      const r = await db.prepare("UPDATE shop_orders SET refund_status='pending_manual', updated_at=?2 WHERE order_id=?1 AND refund_status='pending_gateway'").bind(orderId, now).run();
      if (Number(r.meta?.changes ?? 0) === 1) {
        await appendShopEvent(env, orderId, "refund_pending", "system", `cashfree refund ${f.status ?? (f.found ? "stuck" : "not found")}`).catch(() => undefined);
        await alertOwnerMerchRefund(env, row, `Cashfree refund ${f.status ?? (f.found ? "did not finish" : "was not found")}.`);
      }
      return "manual";
    }
    return "pending";
  } catch (e) { await merchFail(env, e, "refund_confirm"); return "unknown"; }
}

/** Reverse the platform ledger rows an approved order wrote, and the influencer's earning if it was already credited. */
async function reverseOrderMoney(env: Env, row: ShopOrderRow): Promise<void> {
  const db = metaDb(env);
  // Cashfree keeps its fee on a refund, so cashfree_fee is never reversed. The print partner is owed its cost once it has the order, so printrove_cost is reversed only if it never got there.
  const reachedPrinter = !!(row.sent_to_printer_at || row.printrove_order_ref) || !!(await db.prepare("SELECT 1 AS x FROM shop_fulfilments WHERE order_id=?1 AND status IN ('sent','printing','shipped','delivered')").bind(row.order_id).first());
  const kinds = reachedPrinter ? "'merch_share','gst'" : "'merch_share','printrove_cost','gst'";
  const rows = (await db.prepare(`SELECT kind, amount_paise FROM hf_platform_ledger WHERE order_id=?1 AND kind IN (${kinds})`).bind(row.order_id).all<{ kind: string; amount_paise: number }>()).results ?? [];
  const map: Record<string, PlatformKind> = { merch_share: "refund_share", printrove_cost: "refund_printrove_cost", cashfree_fee: "refund_cashfree_fee", gst: "refund_gst" };
  for (const r of rows) await platformEntry(env, map[r.kind], -Number(r.amount_paise), row.order_id, row.seller_uid ?? null, "reversal");
  const rev = await reverseMerchEarning(env, row);
  if (rev === "after_hold_platform_absorbs") {
    const earn = Math.trunc(Number(snapOf(row).money?.influencerPaise ?? 0));
    await platformEntry(env, "refund_after_hold", -earn, row.order_id, row.seller_uid ?? null, "influencer already withdrawable: platform absorbs");
  }
}

export type RejectOk = { ok: true; refund: RefundResult };

/** Reject before it prints (or refund a problem order later). Idempotent: a second call just reports the refund state. */
export async function rejectMerchOrder(env: Env, orderId: string, actor: string, reason: string, opts: { afterDelivery?: boolean } = {}): Promise<RejectOk | FlowFail> {
  const row = await getOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.pay_status !== "confirmed") return fail(409, "not_paid", "This order was never paid, so there is nothing to refund.");
  const why = reason.trim().slice(0, 300);
  if (!why) return fail(400, "reason_required", "Please give a reason.", { field: "reason" });
  const now = Date.now();
  const db = metaDb(env);
  if (row.approval_status !== "rejected") {
    // Before the print partner has it: pending, or approved but not yet on the printer. After that only a refund (problem) is possible.
    const early = row.fulfil_status === "new";
    if (!early && !opts.afterDelivery) return fail(409, "bad_transition", "This order is already with the print partner. Use Refund for a problem order.");
    const f = await db.prepare("SELECT status FROM shop_fulfilments WHERE order_id=?1").bind(orderId).first<{ status: string }>();
    if (early && f && !["problem", "cancelled"].includes(f.status)) return fail(409, "bad_transition", "This order is already with the print partner. Use Refund for a problem order.");
    const claim = await db.prepare(
      `UPDATE shop_orders SET approval_status='rejected', reject_reason=?2, cancel_reason=?2, fulfil_status=CASE WHEN fulfil_status IN ('new') THEN 'cancelled' ELSE fulfil_status END,
              updated_at=?3, refund_status=CASE WHEN COALESCE(refund_status,'none')='none' THEN 'refunding' ELSE refund_status END
        WHERE order_id=?1 AND pay_status='confirmed' AND approval_status IN ('pending','approved') AND COALESCE(refund_status,'none') IN ('none','refunding')
          ${opts.afterDelivery ? "" : "AND fulfil_status='new'"}
          AND (fulfil_status<>'new' OR NOT EXISTS (SELECT 1 FROM shop_fulfilments f WHERE f.order_id=shop_orders.order_id AND f.status NOT IN ('problem','cancelled')))`,
    ).bind(orderId, why, now).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) return fail(409, "bad_transition", "Someone else just changed this order. Reload and try again.");
    // A failed-send ('problem') fulfilment row must not keep a retry time: it would starve the retry list for a refunded order.
    await db.prepare("UPDATE shop_fulfilments SET status='cancelled', next_attempt_at=NULL, updated_at=?2 WHERE order_id=?1 AND status='problem'").bind(orderId, now).run();
    await appendShopEvent(env, orderId, "rejected", actor, why, now).catch((e) => merchFail(env, e, "reject_event", row.uid));
    const snap = snapOf(row);
    if (snap.productId) await db.prepare("UPDATE shop_products SET sold_count=MAX(0,sold_count-?2) WHERE id=?1").bind(snap.productId, Number(snap.qty ?? 1)).run().catch(() => undefined);
    await merchTrack(env, actor.startsWith("system:") ? row.uid : actor, "merch_order_rejected", { order_id: orderId, seller_uid: row.seller_uid, buyer_uid: row.uid, reason: why, method: row.pay_method, after_delivery: !!opts.afterDelivery });
  }
  const fresh = (await getOrder(env, orderId)) ?? row;
  await reverseOrderMoney(env, fresh).catch((e) => merchFail(env, e, "reverse_money", row.uid, { order_id: orderId }));
  const refund = fresh.refund_status === "done" ? "done" : fresh.refund_status === "pending_manual" ? "pending_manual" : fresh.refund_status === "pending_gateway" ? "pending_gateway" : await refundMerchPayment(env, fresh);
  const after = (await getOrder(env, orderId)) ?? fresh;
  if (refund === "done" && after.fulfil_status === "cancelled") {
    await db.prepare("UPDATE shop_orders SET fulfil_status='refunded', updated_at=?2 WHERE order_id=?1 AND fulfil_status='cancelled'").bind(orderId, Date.now()).run();
  }
  if (row.approval_status !== "rejected") await notifyMerchRejected(env, (await getOrder(env, orderId)) ?? after);
  return { ok: true, refund };
}

/** Admin: the manual refund (Cashfree dashboard / bank) has been sent. */
export async function markRefundDone(env: Env, orderId: string, actor: string, note: string | null): Promise<{ ok: true } | FlowFail> {
  const row = await getOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.refund_status === "done") return { ok: true };
  if (row.refund_status !== "pending_manual" && row.refund_status !== "pending_gateway") return fail(409, "bad_transition", "This order has no refund waiting.");
  const now = Date.now();
  const r = await metaDb(env).prepare("UPDATE shop_orders SET refund_status='done', refunded_at=?2, fulfil_status=CASE WHEN fulfil_status='cancelled' THEN 'refunded' ELSE fulfil_status END, updated_at=?2 WHERE order_id=?1 AND refund_status IN ('pending_manual','pending_gateway')").bind(orderId, now).run();
  if (Number(r.meta?.changes ?? 0) === 1) await appendShopEvent(env, orderId, "refunded", actor, (note ?? "refund sent by hand").slice(0, 200), now).catch(() => undefined);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tracking / delivered (manual path; the partner poll uses the same advanceOrder)
// ---------------------------------------------------------------------------
export async function setMerchTracking(env: Env, orderId: string, actor: string, t: { courier: string; awb: string; trackingUrl: string | null }): Promise<{ ok: true } | FlowFail> {
  const row = await getOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.approval_status !== "approved" || row.pay_status !== "confirmed") return fail(409, "not_approved", "Approve the order first.");
  if (row.fulfil_status === "new" || row.fulfil_status === "at_printer") {
    const moved = await advanceOrder(env, orderId, "shipped", { courier: t.courier, awb: t.awb, tracking_url: t.trackingUrl }, actor);
    if (!moved) return fail(409, "bad_transition", "Someone else just changed this order. Reload and try again.");
    const after = (await getOrder(env, orderId)) ?? row;
    await merchTrack(env, actor, "merch_order_shipped", { order_id: orderId, seller_uid: row.seller_uid, buyer_uid: row.uid, courier: t.courier, source: "admin" });
    await notifyMerchStatusPush(env, after, "shipped");
    return { ok: true };
  }
  if (row.fulfil_status === "shipped") {
    await metaDb(env).prepare("UPDATE shop_orders SET courier=?2, awb=?3, tracking_url=?4, updated_at=?5 WHERE order_id=?1 AND fulfil_status='shipped'").bind(orderId, t.courier, t.awb, t.trackingUrl, Date.now()).run();
    await appendShopEvent(env, orderId, "shipped", actor, `tracking updated: ${t.courier} ${t.awb}`).catch(() => undefined);
    return { ok: true };
  }
  return fail(409, "bad_transition", `An order that is "${row.fulfil_status}" can't be marked shipped.`);
}

export async function setMerchDelivered(env: Env, orderId: string, actor: string): Promise<{ ok: true } | FlowFail> {
  const row = await getOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.fulfil_status === "delivered") { await creditMerchEarning(env, row).catch(() => undefined); return { ok: true }; }
  if (row.approval_status !== "approved") return fail(409, "not_approved", "Approve the order first.");
  if (row.fulfil_status !== "shipped") return fail(409, "bad_transition", "Mark it shipped first.");
  const moved = await advanceOrder(env, orderId, "delivered", {}, actor);
  if (!moved) return fail(409, "bad_transition", "Someone else just changed this order. Reload and try again.");
  return { ok: true }; // advanceOrder -> onMerchDelivered credits the earning + sends the pushes
}

// ---------------------------------------------------------------------------
// Safety-net tick (cron): expire unpaid orders, finish stuck payments / refunds / earnings. Never throws.
// ---------------------------------------------------------------------------
export type MerchTickResult = { expired: number; polled: number; refunds: number; earnings: number };
export async function runMerchTick(env: Env): Promise<MerchTickResult> {
  const out: MerchTickResult = { expired: 0, polled: 0, refunds: 0, earnings: 0 };
  try {
    // Deliberately NOT gated by hfMerchEnabled: turning the feature off must never strand a paid order, a refund or an earning.
    const db = metaDb(env);
    const now = Date.now();
    // (a) Cashfree orders still awaiting payment: ask the gateway (the webhook may have been lost).
    const waiting = (await db.prepare("SELECT order_id FROM shop_orders WHERE seller_uid IS NOT NULL AND pay_method='cashfree' AND pay_status='awaiting_payment' AND created_at<?1 ORDER BY created_at LIMIT 20").bind(now - 90_000).all<{ order_id: string }>()).results ?? [];
    for (const w of waiting) { const r = await reconcileCashfreeOrder(env, w.order_id).catch(() => "unavailable" as const); out.polled++; if (r === "failed") await cancelUnpaid(env, w.order_id, "payment_failed"); }
    // (a2) wallet orders that were CHARGED but never confirmed (worker died between the charge and the confirm): confirm them, or give the money back. Never expire a charged order.
    const charged = (await db.prepare(
      `SELECT o.order_id AS order_id, o.pay_status AS pay_status, o.uid AS uid FROM shop_orders o JOIN hf_token_ledger l ON l.op_id='hftset:merch:'||o.order_id
        WHERE o.seller_uid IS NOT NULL AND o.pay_method='wallet' AND o.pay_status IN ('awaiting_payment','expired','cancelled') AND o.created_at<?1 AND l.rupee_value_paise>=o.amount_paise
          AND NOT EXISTS (SELECT 1 FROM hf_token_ledger r WHERE r.op_id='hfmrf:'||o.order_id||':mark') LIMIT 20`,
    ).bind(now - 60_000).all<{ order_id: string; pay_status: string; uid: string }>()).results ?? [];
    for (const c of charged) {
      if (c.pay_status === "cancelled") await refundWalletForOrder(env, c.uid, c.order_id).catch((e) => merchFail(env, e, "charged_cancelled_refund", c.uid, { order_id: c.order_id }));
      else { const r = await settleMerchPayment(env, c.order_id, { via: "wallet", reference: `hftset:merch:${c.order_id}` }); if (r === "confirmed") out.polled++; }
    }
    // (b) expire what is still unpaid after the window (a late payment is still accepted by settle: it checks 'expired' too)
    const ex = await db.prepare("UPDATE shop_orders SET pay_status='expired', updated_at=?1 WHERE seller_uid IS NOT NULL AND pay_status='awaiting_payment' AND expires_at<?1").bind(now).run();
    out.expired = Number(ex.meta?.changes ?? 0);
    // (c) rejected orders whose refund never finished
    const stuck = (await db.prepare("SELECT order_id FROM shop_orders WHERE seller_uid IS NOT NULL AND approval_status='rejected' AND pay_status='confirmed' AND COALESCE(refund_status,'none') IN ('none','refunding') AND updated_at<?1 LIMIT 20").bind(now - 120_000).all<{ order_id: string }>()).results ?? [];
    for (const s of stuck) { const r = await rejectMerchOrder(env, s.order_id, "system:retry", "retry refund"); if (r.ok) out.refunds++; }
    // (c2) Cashfree refunds Cashfree accepted: did they finish?
    const gw = (await db.prepare("SELECT order_id FROM shop_orders WHERE seller_uid IS NOT NULL AND refund_status='pending_gateway' ORDER BY updated_at LIMIT 20").all<{ order_id: string }>()).results ?? [];
    for (const g of gw) { if ((await confirmCashfreeRefund(env, g.order_id)) === "done") out.refunds++; }
    // (d) delivered orders whose earning was not credited (crash between the status change and the ledger write)
    const un = (await db.prepare("SELECT * FROM shop_orders WHERE seller_uid IS NOT NULL AND fulfil_status='delivered' AND approval_status='approved' AND earning_credited_at IS NULL AND COALESCE(refund_status,'none')='none' LIMIT 20").all<ShopOrderRow>()).results ?? [];
    for (const o of un) { if ((await creditMerchEarning(env, o)) === "credited") out.earnings++; }
  } catch (e) { await merchFail(env, e, "tick"); }
  return out;
}
