// [PAY-REFUND-1] Send a refund back the way the money came in.
//
// OWNER DECISION 2026-08-29: reverse to the source UPI handle by default; wallet credit
// is an opt-in.
//
// WHY NOT WALLET-ONLY (the owner's first instinct, recorded so it is not retried): a
// refund parked in the wallet is unreachable for most buyers. Cashing out runs through
// upiPayoutRequest, which requires Stripe KYC, a verified VPA, admin approval with a
// hand-entered UTR, AND `coins >= upiPayoutMinCoins` — 1,000 in production. A buyer
// refunded ₹49 for an event the creator cancelled would need full KYC and twenty more
// cancelled events before they could withdraw their own money. That lane is built for
// creator EARNINGS, not for giving a customer their money back.
//
// ASYNCHRONY IS THE TRAP. Cashfree refunds (and every other gateway's, per the shared
// GatewayAdapter.refund() contract in lib/payments/types.ts) are async: a 200 from their
// API means "accepted", not "the money is back". So a gateway reversal lands the receipt
// in `refund_pending`, never `refunded`, until their refund webhook confirms it. Marking
// it complete on the API response is how a buyer gets told they were refunded when they
// were not.
//
// [PAY-RAIL-2] GATEWAY-AWARE RAIL LOOKUP. This used to look ONLY in `direct_purchases`,
// which only routes/cashfree.ts ever writes a row into. A Razorpay/Paytm/Stripe purchase
// is funded through routes/pay.ts's `gateway_orders` table instead, so it was invisible
// here and fell through to "wallet" — a buyer who paid by card got a wallet credit they
// could not withdraw, instead of a reversal to their card. `refundRailFor` now also
// checks `gateway_orders` for every non-cashfree gateway id, recovering the gateway and
// its own order id from the commercial order-id PREFIX that
// commercial_checkout.ts's `provisionFromGatewayPurchase` mints (`${gateway}-order:${purchaseId}`,
// see [PAY-RAIL-2] there). The original `direct_purchases` lookup is untouched and tried
// FIRST, so every already-settled Cashfree order resolves exactly as it did before this
// change — this is additive, not a rewrite of the Cashfree path.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { refund, refundExternal } from "../ledger";
import { refundCashfreeOrder } from "./cashfree";
import { isGatewayId, resolveGateway } from "./payments/registry";
import type { GatewayId } from "./payments/types";

export type RefundRail =
  | { rail: "wallet" }
  | { rail: "cashfree"; purchaseId: string; gatewayOrderId: string }
  | { rail: Exclude<GatewayId, "cashfree">; purchaseId: string; gatewayOrderId: string };

// Matches the order-id shape `provisionFromGatewayPurchase` mints: `${gateway}-order:${purchaseId}`.
// `purchaseId` can itself contain "-order:" (routes/pay.ts's default id is `pay-order:<uuid>`),
// so the gateway-id group is greedy only over `[a-z]+` (no hyphens) — it naturally stops at
// the first hyphen and leaves the rest of the string, "-order:" included, as the purchase id.
const GATEWAY_ORDER_ID_RE = /^([a-z]+)-order:(.+)$/;

/**
 * How was this order funded? `direct_purchases` only has a row when Cashfree paid, so its
 * absence IS the answer for every wallet-funded order — UNLESS another gateway's adapter
 * funded it through `gateway_orders` (checked second, see file header).
 *
 * Fails to "wallet" when a table is missing (a migration not yet applied), which is
 * correct: before that migration exists, no order can have been funded on that rail.
 */
export async function refundRailFor(env: Env, orderId: string): Promise<RefundRail> {
  try {
    const row = await metaDb(env).prepare(
      `SELECT purchase_id, gateway_order_id FROM direct_purchases
        WHERE order_id=?1 AND status IN ('credited','paid') LIMIT 1`,
    ).bind(orderId).first<{ purchase_id: string; gateway_order_id: string }>();
    if (row) return { rail: "cashfree", purchaseId: row.purchase_id, gatewayOrderId: row.gateway_order_id };
  } catch {
    return { rail: "wallet" };
  }

  const match = GATEWAY_ORDER_ID_RE.exec(orderId);
  if (match) {
    const [, maybeGateway, purchaseId] = match;
    if (isGatewayId(maybeGateway) && maybeGateway !== "cashfree") {
      try {
        const row = await metaDb(env).prepare(
          `SELECT order_id, gateway_order_id FROM gateway_orders
             WHERE order_id=?1 AND gateway=?2 AND status IN ('credited','paid') LIMIT 1`,
        ).bind(purchaseId, maybeGateway).first<{ order_id: string; gateway_order_id: string }>();
        if (row) {
          return {
            rail: maybeGateway as Exclude<GatewayId, "cashfree">,
            purchaseId: row.order_id,
            gatewayOrderId: row.gateway_order_id,
          };
        }
      } catch {
        return { rail: "wallet" };
      }
    }
  }
  return { rail: "wallet" };
}

export type RefundOutcome =
  | { ok: true; state: "refunded"; rail: "wallet" }
  | { ok: true; state: "refund_pending"; rail: GatewayId }
  | { ok: false; error: string };

/**
 * Execute a refund on the correct rail.
 *
 * `walletCredit` is the buyer's OPT-IN: honour it even for a gateway-funded purchase,
 * because someone who intends to rebook is better served by credit than by a three-day
 * bank reversal. It is never the default and never the only option.
 */
export async function executeCommercialRefund(env: Env, args: {
  orderId: string;
  buyerId: string;
  amount: number;          // whole tokens, base + tax
  reason: string;
  walletCredit?: boolean;
}): Promise<RefundOutcome> {
  if (!(args.amount > 0)) return { ok: true, state: "refunded", rail: "wallet" };
  const rail = await refundRailFor(env, args.orderId);

  if (rail.rail === "wallet" || args.walletCredit === true) {
    const r = await refund(env, args.orderId, args.buyerId, args.amount, {
      opId: `commercial:refund:${args.orderId}`,
      reason: args.reason,
    });
    return r.ok ? { ok: true, state: "refunded", rail: "wallet" } : { ok: false, error: "refund_ledger_failed" };
  }

  // Ledger FIRST: it is the record that the money left escrow, and it refuses when
  // escrow is short rather than reversing money that is not there. Asking the gateway
  // first and failing here would leave the gateway reversing money the books still show
  // as held. `opId`/`source` are keyed on `rail.rail` (was hardcoded "cashfree") — for a
  // Cashfree order rail.rail is still literally "cashfree", so this branch produces the
  // exact same ledger row it always did for every existing Cashfree refund.
  const ledger = await refundExternal(env, args.orderId, args.amount, {
    opId: `${rail.rail}:reverse:${rail.gatewayOrderId}`,
    uid: args.buyerId,
    source: rail.rail,
    reason: args.reason,
    ref: rail.gatewayOrderId,
  });
  if (!ledger.ok) return { ok: false, error: "refund_ledger_failed" };

  if (rail.rail === "cashfree") {
    // UNCHANGED from before [PAY-RAIL-2] — same call, same idempotency key, same table.
    const reversed = await refundCashfreeOrder(env, {
      orderId: rail.gatewayOrderId,
      // Stable, derived from the order — the gateway's own idempotency key, so a retry
      // cannot issue a second reversal.
      refundId: `avatok_rf_${rail.purchaseId.replace(/-/g, "").slice(0, 24)}`,
      amountPaise: args.amount * 100,
      note: args.reason,
    });
    if (!reversed.ok) return { ok: false, error: `gateway_refund_failed:${reversed.error}` };

    await metaDb(env).prepare(
      "UPDATE direct_purchases SET status='refunded',updated_at=?2 WHERE purchase_id=?1",
    ).bind(rail.purchaseId, Date.now()).run();

    // NOT "refunded". Cashfree has accepted, not completed.
    return { ok: true, state: "refund_pending", rail: "cashfree" };
  }

  // [PAY-RAIL-2] Any other gateway — go through the SAME GatewayAdapter.refund() contract
  // routes/pay.ts's webhook already trusts (spec §2.3), instead of falling through to a
  // wallet credit the buyer never asked for and cannot easily use (see file header).
  const adapter = resolveGateway(rail.rail);
  if (!adapter) return { ok: false, error: "gateway_unresolved" };
  const reversed = await adapter.refund(env, {
    gatewayOrderId: rail.gatewayOrderId,
    amountPaise: args.amount * 100,
    reason: args.reason,
    // Same convention as the Cashfree refundId above — stable and derived from the order,
    // so a retry cannot issue a second reversal at the gateway.
    opId: `avatok_rf_${rail.purchaseId.replace(/-/g, "").slice(0, 24)}`,
  });
  if (!reversed.accepted) return { ok: false, error: `gateway_refund_failed:${reversed.error ?? "unknown"}` };

  await metaDb(env).prepare(
    "UPDATE gateway_orders SET status='refunded',updated_at=?2 WHERE order_id=?1 AND gateway=?3",
  ).bind(rail.purchaseId, Date.now(), rail.rail).run();

  // NOT "refunded" — same asynchrony caveat as Cashfree (file header): a 200 from the
  // gateway means accepted, not completed, until its refund webhook confirms it.
  return { ok: true, state: "refund_pending", rail: rail.rail };
}

/**
 * [COMM-NOSHOW-1] Write the terminal refund record: receipt, order, booking,
 * entitlements, settlement job. Everything except moving the money, which
 * `executeCommercialRefund` has already done.
 *
 * Shared by the admin claims route and the settlement cron so the two cannot disagree
 * about what "refunded" leaves behind. Idempotent — `INSERT OR IGNORE` on a receipt id
 * derived from the order, and every UPDATE is a state assignment rather than a delta.
 */
export async function finalizeCommercialRefund(env: Env, args: {
  orderId: string;
  sessionId: string | null;
  listingId: string;
  bookingId: string | null;
  buyerId: string;
  creatorId: string;
  kind: string;
  grossAmount: number;      // taxable base
  refundedAmount: number;   // what the buyer gets back: base + tax
  gstAmount: number;
  currency: string;
  policySnapshotId: string;
  reason: string;
  actor: "buyer" | "creator" | "provider" | "system";
}): Promise<string> {
  const receiptId = `commercial-refund:${args.orderId}`;
  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_refund_receipts
       (refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,creator_id,
        kind,gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,
        currency,settlement_state,reason,actor,policy_snapshot_id,issued_at,gst_amount)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,0,0,?11,'refunded',?12,?13,?14,?15,?16)`,
    ).bind(receiptId, args.orderId, args.sessionId, args.listingId, args.bookingId,
      args.buyerId, args.creatorId, args.kind, args.grossAmount, args.refundedAmount,
      args.currency, args.reason.slice(0, 200), args.actor, args.policySnapshotId, now, args.gstAmount),
    metaDb(env).prepare("UPDATE orders SET status='refunded',updated_at=?2 WHERE id=?1").bind(args.orderId, now),
    metaDb(env).prepare("UPDATE bookings SET status='refunded',updated_at=?2 WHERE order_id=?1").bind(args.orderId, now),
    metaDb(env).prepare(
      "UPDATE commercial_entitlements SET state='refunded',updated_at=?2 WHERE order_id=?1",
    ).bind(args.orderId, now),
    metaDb(env).prepare(
      "UPDATE commercial_settlement_jobs SET state='refunded',last_error=?2,updated_at=?3 WHERE order_id=?1",
    ).bind(args.orderId, args.reason.slice(0, 500), now),
  ]);
  return receiptId;
}
