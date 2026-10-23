// [HF-CHANNEL-CORE-1 2026-10-23] Bag checkout (spec C3, owner decision D8): a fan pays ONCE for up to 10 lines (any influencers). The server makes one ordinary
// merch order per line (own money snapshot, admin approval, Printrove, influencer earning -- all unchanged) linked by `merch_json.groupId`.
//   wallet   : balance pre-checked for the whole bag, then one charge per order; if a later charge fails the earlier ones are given back and every order is cancelled.
//   cashfree : ONE gateway order whose id IS the group id and whose amount is the SUM; every row stores cashfree_order_id = group id (reconcile: hf_merch_flow.ts).
// Same requestKey again = same result: rows are keyed `<requestKey>:<n>` and an existing group is finished, never recreated.
// The single-item checkout (startMerchCheckout) is untouched; the snapshot/insert below deliberately mirrors it so a bag line is an ordinary order.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { resolveGateway } from "./payments/registry";
import { topupCustomer } from "./hf_topup_customer";
import { validateAddress, type Address } from "./saathum_checkout_logic";
import { newShopOrderId, shopOrderNo, SHOP_REFUND_POLICY_VERSION, type ShopOrderRow } from "./shop_orders_logic";
import { appendShopEvent } from "../routes/shop_orders";
import { computeMerchMoney, maxMarkupForBase, rupeesText, sizeBreakdown, type PayMethod } from "./hf_merch_math";
import { frozenOrFallback } from "./hf_merch_gst";
import { legacyShippingPaise } from "./hf_merch_catalog";
import { parseJson, newMerchGroupId, groupIdOf, type MerchSnapshot } from "./hf_merch_types";
import { getGroupRows, getProduct, hostByUid, productMerch, saveAddress, type MerchHost, type MerchProductRow } from "./hf_merch_store";
import { balanceSummary } from "./hf_token_ledger";
import { refundWalletForOrder, spendWalletForOrder, walletSpentForOrder } from "./hf_merch_wallet";
import { merchFail, merchTrack } from "./hf_merch_notify";
import {
  MERCH_PAY_WINDOW_MS, MERCH_QTY_MAX, cancelUnpaid, merchCfg, reconcileCashfreeOrder, settleMerchPayment, type FlowFail,
} from "./hf_merch_flow";

export const MERCH_BAG_MAX_LINES = 10;

const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): FlowFail => ({ ok: false, status, error, message, extra });

export type BagLineInput = { productId: string; colour: string; size: string; qty: number };
export type BagCheckoutInput = {
  uid: string; lines: BagLineInput[]; address: unknown; saveAddress: boolean; method: PayMethod; requestKey: string; client?: "app" | "web";
};
export type BagCheckoutOk = { ok: true; groupId: string; rows: ShopOrderRow[]; created: boolean; checkoutUrl?: string | null; paymentSessionId?: string | null };

type Prepared = { product: MerchProductRow; host: MerchHost; orderId: string; snap: MerchSnapshot; totalPaise: number; colour: string; size: string; qty: number };

const unavailable = (productId: string, reason: "gone" | "bad_size" | "bad_colour") =>
  fail(409, "item_unavailable", reason === "gone" ? "An item in your bag is no longer available." : "An item in your bag is no longer available in that size or colour.", { productId, reason });

export async function startMerchBagCheckout(env: Env, i: BagCheckoutInput): Promise<BagCheckoutOk | FlowFail> {
  const db = metaDb(env);
  // Idempotent retry: the first line of a group is `<requestKey>:0`.
  const first = await db.prepare("SELECT * FROM shop_orders WHERE uid=?1 AND request_key=?2").bind(i.uid, `${i.requestKey}:0`).first<ShopOrderRow>();
  if (first) {
    const gid = groupIdOf(first);
    if (first.seller_uid == null || !gid) return fail(409, "request_key_used", "That request id was already used.");
    return finishBag(env, gid, i, false);
  }
  if (!Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > MERCH_BAG_MAX_LINES) return fail(400, "invalid_items", `Put 1 to ${MERCH_BAG_MAX_LINES} items in your bag.`, { field: "items" });
  const { cfg } = await merchCfg(env);

  // 1. Validate EVERY line before anything is written.
  const hosts = new Map<string, MerchHost | null>();
  const prepared: Prepared[] = [];
  const gid = newMerchGroupId();
  for (const line of i.lines) {
    const qty = Math.trunc(Number(line.qty));
    if (!(qty >= 1 && qty <= MERCH_QTY_MAX)) return fail(400, "bad_qty", `You can order 1 to ${MERCH_QTY_MAX} of each item.`, { field: "items", productId: line.productId });
    const product = await getProduct(env, line.productId);
    if (!product || !product.seller_uid) return unavailable(line.productId, "gone");
    if (product.seller_uid === i.uid) return fail(403, "own_product", "You cannot buy your own product.", { productId: line.productId });
    if (!hosts.has(product.seller_uid)) hosts.set(product.seller_uid, await hostByUid(env, product.seller_uid));
    const host = hosts.get(product.seller_uid);
    const pm = productMerch(product);
    if (!host || host.status !== "live" || !pm || product.review_status !== "live" || product.deleted_at) return unavailable(line.productId, "gone");
    const sz = line.size ? pm.sizes.find((s) => s.size.toLowerCase() === line.size.toLowerCase()) : pm.sizes.length === 1 ? pm.sizes[0] : undefined; // one-size items (mugs, posters) are sent with size ""
    const col = pm.colours.find((c) => c.name.toLowerCase() === line.colour.toLowerCase());
    if (!sz) return unavailable(line.productId, "bad_size");
    if (!col) return unavailable(line.productId, "bad_colour");
    const markupUnit = Math.trunc(Number(product.markup_rupees ?? 0)) * 100;
    // [HF-MERCH-GST-1] Exactly what startMerchCheckout does per order: the product's FROZEN category GST (older products: flat fallback), the price cap where the category has one,
    // and the GST-inclusive printing credit -- so a bag line is priced and snapshotted identically to a single-item order.
    const gst = frozenOrFallback(pm.gst, { rateBps: cfg.gstRateBps, hsn: cfg.hsn });
    if (gst.capApplies && sz.baseUnitPaise + markupUnit > cfg.priceCapPaise) {
      return fail(409, "over_price_cap", `An item in your bag costs more than ${rupeesText(cfg.priceCapPaise)} right now, so it cannot be sold. The creator needs to lower the price.`, { productId: line.productId, maxMarkupRupees: maxMarkupForBase(sz.baseUnitPaise, cfg.priceCapPaise), priceCapPaise: cfg.priceCapPaise });
    }
    const printingUnitPaise = typeof sz.printingPaise === "number" ? sz.printingPaise
      : sizeBreakdown(sz, await legacyShippingPaise(env), Math.max(0, Math.trunc(pm.bufferRupees ?? 0)) * 100).printingPaise;
    const money = computeMerchMoney({ baseUnitPaise: sz.baseUnitPaise, markupUnitPaise: markupUnit, qty, payMethod: i.method, cfg, printingUnitPaise, gst, ...(typeof sz.partnerGstBps === "number" ? { partnerGstBps: sz.partnerGstBps } : {}) });
    if (money.totalPaise < 100 || money.totalPaise % 100 !== 0) return fail(409, "bad_price", "An item in your bag has a price that is not valid right now.", { productId: line.productId });
    const snap: MerchSnapshot = {
      v: 1, sellerUid: product.seller_uid, hostSlug: host.slug, hostName: host.displayName, productId: product.id, productSlug: pm.productSlug, title: product.name,
      imageUrl: pm.mockups[0] ?? pm.printPreviewUrl ?? pm.artUrl ?? null, catalogId: pm.catalogId, catalogName: pm.catalogName, colour: col.name, size: sz.size, qty, side: pm.side,
      printFileUrl: pm.printPreviewUrl, money, payMethod: i.method, holdDays: cfg.holdDays,
      printWIn: Number((pm.placement as { print_w_in?: number }).print_w_in ?? 0), printHIn: Number((pm.placement as { print_h_in?: number }).print_h_in ?? 0), bufferRupees: pm.bufferRupees ?? 0,
      groupId: gid,
    };
    prepared.push({ product, host, orderId: newShopOrderId(), snap, totalPaise: money.totalPaise, colour: col.name, size: sz.size, qty });
  }
  const addr = validateAddress(i.address);
  if (!addr.ok) return fail(400, addr.error, addr.message, { field: addr.field });
  const a: Address = addr.value;
  if (!a.phone) return fail(400, "invalid_phone", "A 10-digit mobile number is needed for delivery.", { field: "phone" });
  if (a.line1.length > 50 || (a.line2 ?? "").length > 50) return fail(400, "address_line_too_long", "Each address line can be at most 50 characters. Use both lines.", { field: a.line1.length > 50 ? "line1" : "line2" });

  // 2. One atomic batch: every order row of the group or none.
  const now = Date.now();
  const insert = (p: Prepared, n: number) => {
    const rupees = p.totalPaise / 100;
    const items = [{ product_id: p.product.id, slug: p.product.slug, name: p.product.name, colour: p.colour, size: p.size, qty: p.qty, unit_rupees: p.snap.money.unitPaise / 100, amount_rupees: rupees, image_url: p.snap.imageUrl }];
    return db.prepare(
      `INSERT INTO shop_orders (order_id, order_no, uid, request_key, items_json, subtotal_rupees, discount_rupees, coupon_code, gst_rate_pct, gst_rupees, total_rupees,
         address_json, contact_name, terms_accepted_at, refund_policy_accepted_at, refund_policy_version, pay_status, receiving_account_key, amount_paise, rounding_discount_paise,
         expires_at, fulfil_status, created_at, updated_at, seller_uid, pay_method, merch_json, approval_status, refund_status)
       VALUES (?1,?2,?3,?4,?5,?6,0,NULL,0,0,?6,?7,?8,?9,?9,?10,'awaiting_payment',?11,?12,0,?13,'new',?9,?9,?14,?15,?16,'pending','none')`,
    ).bind(p.orderId, shopOrderNo(p.orderId), i.uid, `${i.requestKey}:${n}`, JSON.stringify(items), rupees, JSON.stringify(a), a.name, now, SHOP_REFUND_POLICY_VERSION,
      i.method === "wallet" ? "hf_wallet" : "cashfree", p.totalPaise, now + MERCH_PAY_WINDOW_MS, p.product.seller_uid, i.method, JSON.stringify(p.snap));
  };
  try {
    await db.batch(prepared.map((p, n) => insert(p, n)));
  } catch (e) {
    const again = await db.prepare("SELECT * FROM shop_orders WHERE uid=?1 AND request_key=?2").bind(i.uid, `${i.requestKey}:0`).first<ShopOrderRow>();
    const g = again ? groupIdOf(again) : null;
    if (g) return finishBag(env, g, i, false);
    await merchFail(env, e, "bag_checkout_insert", i.uid);
    return fail(503, "checkout_unavailable", "We could not start your order. Please try again in a moment.");
  }
  for (const p of prepared) await appendShopEvent(env, p.orderId, "created", i.uid, `${i.method} bag ${gid}`, now).catch((e) => merchFail(env, e, "checkout_event", i.uid));
  if (i.saveAddress) await saveAddress(env, i.uid, { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, pincode: a.pincode }).catch((e) => merchFail(env, e, "save_address", i.uid));
  const total = prepared.reduce((s, p) => s + p.totalPaise, 0);
  for (const p of prepared) await merchTrack(env, i.uid, "merch_checkout_started", { order_id: p.orderId, product_id: p.product.id, seller_uid: p.product.seller_uid, method: i.method, total_paise: p.totalPaise, qty: p.qty, group_id: gid });
  await merchTrack(env, i.uid, "merch_bag_checkout_started", { group_id: gid, lines: prepared.length, sellers: new Set(prepared.map((p) => p.product.seller_uid)).size, method: i.method, total_paise: total });
  return finishBag(env, gid, i, true);
}

/** Take the money for a group that exists (also the retry path of an idempotent request). */
async function finishBag(env: Env, groupId: string, i: BagCheckoutInput, created: boolean): Promise<BagCheckoutOk | FlowFail> {
  const rows = await getGroupRows(env, groupId, i.uid);
  if (!rows.length) return fail(409, "order_closed", "That order was cancelled. Please start again.");
  if (rows.every((r) => r.pay_status === "confirmed")) return { ok: true, groupId, rows, created };
  if (rows.some((r) => r.pay_status === "cancelled" || r.pay_status === "expired")) return fail(409, "order_closed", "That order was cancelled. Please start again.");
  return rows[0].pay_method === "wallet" ? payBagFromWallet(env, groupId, rows, created) : payBagWithCashfree(env, groupId, rows, i, created);
}

/** Give every wallet charge of the unpaid orders back, then close them. Refund first, cancel second (a crash in between is repaired by the tick). */
async function rollbackBag(env: Env, open: ShopOrderRow[], reason: string): Promise<void> {
  for (const r of open) await refundWalletForOrder(env, r.uid, r.order_id).catch((e) => merchFail(env, e, "bag_rollback_refund", r.uid, { order_id: r.order_id }));
  for (const r of open) await cancelUnpaid(env, r.order_id, reason);
}

async function payBagFromWallet(env: Env, groupId: string, rows: ShopOrderRow[], created: boolean): Promise<BagCheckoutOk | FlowFail> {
  const uid = rows[0].uid;
  const open = rows.filter((r) => r.pay_status !== "confirmed");
  // Pre-check the whole bag so a short wallet never charges anything. (Orders already charged on an earlier attempt are not counted again.)
  let needed = 0;
  for (const r of open) { const sp = await walletSpentForOrder(env, r.order_id); if (sp.paidPaise + sp.testPaise < Number(r.amount_paise)) needed += Number(r.amount_paise); }
  if (needed > 0) {
    const b = await balanceSummary(env, uid);
    if (b.availablePaidPaise < needed) {
      await rollbackBag(env, open, "insufficient_balance");
      await merchTrack(env, uid, "merch_bag_rolled_back", { group_id: groupId, reason: "insufficient_balance", orders: open.length });
      return fail(402, "insufficient_balance", "Your wallet does not have enough money for this bag.", { shortPaise: needed - b.availablePaidPaise, balancePaise: b.availablePaidPaise, ...(b.availableTestPaise > 0 ? { testCreditNotUsable: true } : {}) });
    }
  }
  for (const r of open) {
    const s = await spendWalletForOrder(env, uid, r.order_id, Number(r.amount_paise));
    if (s.ok) continue;
    await rollbackBag(env, open, s.reason === "insufficient" ? "insufficient_balance" : `wallet_${s.reason}`);
    await merchTrack(env, uid, "merch_bag_rolled_back", { group_id: groupId, reason: s.reason, orders: open.length, failed_order_id: r.order_id });
    if (s.reason === "insufficient") return fail(402, "insufficient_balance", "Your wallet does not have enough money for this bag.", { shortPaise: s.shortPaise, balancePaise: s.balancePaise, ...(s.testCreditNotUsable ? { testCreditNotUsable: true } : {}) });
    return fail(s.reason === "debt" ? 409 : 503, s.reason === "debt" ? "wallet_debt" : "wallet_unavailable", s.reason === "debt" ? "Clear the amount you owe in your wallet first." : "The wallet could not be charged. Please try again.");
  }
  // Every order is charged: settle each one.
  let failed = 0;
  for (const r of open) {
    await metaDb(env).prepare("UPDATE shop_orders SET wallet_op_id=?2 WHERE order_id=?1 AND wallet_op_id IS NULL").bind(r.order_id, `hftset:merch:${r.order_id}`).run();
    if ((await settleMerchPayment(env, r.order_id, { via: "wallet", reference: `hftset:merch:${r.order_id}` })) === "failed") failed++;
  }
  const fresh = await getGroupRows(env, groupId, uid);
  if (failed) return fail(503, "checkout_unavailable", "Your payment went through but the order is not confirmed yet. We will fix it shortly; check My orders.");
  await merchTrack(env, uid, "merch_bag_paid", { group_id: groupId, orders: fresh.length, method: "wallet", total_paise: fresh.reduce((s, r) => s + Number(r.amount_paise), 0) });
  return { ok: true, groupId, rows: fresh.length ? fresh : rows, created };
}

async function payBagWithCashfree(env: Env, groupId: string, rows: ShopOrderRow[], i: BagCheckoutInput, created: boolean): Promise<BagCheckoutOk | FlowFail> {
  const uid = rows[0].uid;
  const refetch = async () => { const f = await getGroupRows(env, groupId, uid); return f.length ? f : rows; };
  // A retry must not create the gateway order a second time (same id -> gateway error): reuse the stored session.
  if (rows.every((r) => r.cashfree_order_id === groupId)) {
    const was = await reconcileCashfreeOrder(env, groupId).catch(() => "unavailable" as const);
    if (was === "confirmed" || was === "duplicate") return { ok: true, groupId, rows: await refetch(), created };
    const kept = await env.TOKENS.get(`merch:cfs:${groupId}`, "json").catch(() => null) as { checkoutUrl?: string | null; paymentSessionId?: string | null } | null;
    if (kept && (kept.checkoutUrl || kept.paymentSessionId)) return { ok: true, groupId, rows: await refetch(), created, checkoutUrl: kept.checkoutUrl ?? null, paymentSessionId: kept.paymentSessionId ?? null };
  }
  const adapter = resolveGateway("cashfree");
  if (!adapter || !adapter.configured(env)) {
    for (const r of rows) await cancelUnpaid(env, r.order_id, "gateway_unconfigured");
    return fail(503, "payments_unavailable", "Card and UPI payments are not available right now. You can pay from your wallet instead.");
  }
  const total = rows.reduce((s, r) => s + Number(r.amount_paise), 0);
  const client = i.client === "app" ? "app" : "web";
  const given = parseJson<Partial<Address>>(rows[0].address_json, {});
  const customer = await topupCustomer(env, uid, { name: given.name ?? null }).catch(() => ({ phone: null, email: null, name: null }));
  const gw = await adapter.createOrder(env, { orderId: groupId, amountPaise: total, currency: "INR", uid, listingId: "", kind: "hf_merch", client, customer, checkoutMode: "web" });
  if ("error" in gw) {
    if (gw.error === "customer_phone_required") return fail(409, "whatsapp_required", "Verify your WhatsApp number in Settings before paying.", { reason: "whatsapp_required" });
    await merchFail(env, new Error(`cashfree_create_order:${gw.error}`), "cashfree_create", uid, { group_id: groupId });
    return fail(502, "gateway_error", "We could not start the payment. Please try again in a moment.");
  }
  const upd = metaDb(env).prepare("UPDATE shop_orders SET cashfree_order_id=?2, updated_at=?3 WHERE order_id=?1");
  await metaDb(env).batch(rows.map((r) => upd.bind(r.order_id, groupId, Date.now())));
  const cp = (gw.client_payload ?? {}) as Record<string, unknown>;
  const kept = { checkoutUrl: typeof cp.checkout_url === "string" ? cp.checkout_url : null, paymentSessionId: typeof cp.payment_session_id === "string" ? cp.payment_session_id : null };
  await env.TOKENS.put(`merch:cfs:${groupId}`, JSON.stringify(kept), { expirationTtl: 3 * 3600 }).catch(() => undefined);
  return { ok: true, groupId, rows: await refetch(), created, checkoutUrl: kept.checkoutUrl, paymentSessionId: kept.paymentSessionId };
}
