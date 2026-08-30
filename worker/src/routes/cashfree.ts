// [PAY-CASHFREE-1] Inbound UPI: pay for a ticket with rupees, not with a topped-up wallet.
//
//   POST /api/pay/cashfree/order     requireUser  → { payment_session_id, purchase_id }
//   POST /api/pay/cashfree/webhook   signed       → funds escrow, writes the entitlement
//   GET  /api/pay/cashfree/status    requireUser  → poll while the webhook is in flight
//
// THE ONE RULE: the webhook is the only thing that may mark a purchase paid, and even it
// re-reads the order from the gateway before believing itself. A browser redirect is
// forgeable; a `?status=success` query param is a suggestion from an untrusted party.
//
// ⚠️ NEVER TESTED AGAINST A LIVE GATEWAY. No Cashfree credentials existed when this was
// written. Run the sandbox end to end before this handles a rupee.
//
// Money-in stays OFF until `cashfreeEnabled` AND `guestCheckoutEnabled` are both true and
// real credentials are configured. billingEnabled and walletRealMoney are false in prod.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { holdExternal } from "../ledger";
import { taxFor } from "../lib/commercial_tax";
import { commercialLaneState } from "../lib/commercial_lane";
import { commercialEvent } from "../lib/commercial_telemetry";
import {
  cashfreeConfigured, createCashfreeOrder, fetchCashfreeOrder, verifyCashfreeSignature,
} from "../lib/cashfree";
import { track } from "../hooks";

const APP = "avapay";

/**
 * 🚧 INCOMPLETE ON PURPOSE, AND FENCED SO IT CANNOT SHIP HALF-DONE.
 *
 * The rail below funds escrow correctly, but the step AFTER that — creating the
 * commercial order, the immutable policy snapshot, the booking and the ENTITLEMENT — is
 * not wired yet. Without it a buyer pays, escrow fills, and they receive no ticket: the
 * exact shape of the bugs Phase 1 existed to remove.
 *
 * Flags alone are not enough protection here. `cashfreeEnabled` is one KV write away
 * from true, and a flag flip is not a code review. So order creation refuses outright
 * while this is false, which makes "charged but nothing delivered" unreachable rather
 * than merely unlikely.
 *
 * TO FINISH: extract the order/snapshot/booking/entitlement block from
 * commercialCheckout (routes/commercial_checkout.ts) into a function both lanes call,
 * with the funding step passed in — hold() for the wallet lane, holdExternal() for this
 * one. Then flip this to true, run the Cashfree sandbox end to end, and confirm a real
 * entitlement row exists before the flags go on.
 */
const ENTITLEMENT_HANDOFF_IMPLEMENTED = false;

type PurchaseRow = {
  purchase_id: string; gateway_order_id: string; uid: string; listing_id: string;
  booking_id: string | null; kind: string; base_paise: number; gst_paise: number;
  total_paise: number; status: string; affiliate_uid: string | null; order_id: string | null;
};

async function schemaReady(env: Env): Promise<boolean> {
  try {
    await metaDb(env).prepare(
      "SELECT purchase_id,gateway_order_id,uid,listing_id,status FROM direct_purchases LIMIT 1",
    ).first();
    return true;
  } catch { return false; }
}

/** Both switches, plus real credentials. Any one missing ⇒ the lane is off, loudly. */
async function payEnabled(env: Env): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  if (!cashfreeConfigured(env)) return { ok: false, reason: "gateway_unconfigured", status: 503 };
  let cfg;
  try { cfg = await readConfig(env); } catch { return { ok: false, reason: "config_unavailable", status: 503 }; }
  if (cfg.cashfreeEnabled !== true) return { ok: false, reason: "gateway_disabled", status: 404 };
  if (cfg.guestCheckoutEnabled !== true) return { ok: false, reason: "checkout_disabled", status: 404 };
  if (!await schemaReady(env)) return { ok: false, reason: "schema_unavailable", status: 503 };
  return { ok: true };
}

/** The affiliate to credit, from the public click cookie. Best-effort by design: a
 *  missing cookie means an organic purchase, not an error. [GUEST-AFFIL-BOUNTY-1] */
function affiliateDeviceFrom(req: Request): string | null {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ava_aff_dev=([A-Za-z0-9-]{8,64})/);
  return m ? m[1] : null;
}

/** POST /api/pay/cashfree/order  { listingId, bookingId? } */
export async function cashfreeCreateOrder(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const gate = await payEnabled(env);
  if (!gate.ok) return json({ error: "checkout unavailable", reason: gate.reason }, gate.status);
  // See ENTITLEMENT_HANDOFF_IMPLEMENTED. Refuse to take money we cannot yet turn into a
  // ticket, no matter what the flags say.
  if (!ENTITLEMENT_HANDOFF_IMPLEMENTED) {
    return json({ error: "checkout unavailable", reason: "entitlement_handoff_incomplete" }, 503);
  }

  const b = (await req.json().catch(() => ({}))) as { listingId?: unknown; bookingId?: unknown };
  const listingId = String(b.listingId || "");
  const bookingId = b.bookingId ? String(b.bookingId) : null;
  if (!listingId) return json({ error: "listingId required" }, 400);

  const db = metaDb(env);
  const listing = await db.prepare(
    "SELECT id,creator_id,kind,title,price,status,starts_at,duration_min,capacity FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing || !["published", "live"].includes(String(listing.status))) {
    return json({ error: "listing not available" }, 404);
  }
  if (listing.creator_id === auth.uid) return json({ error: "cannot buy your own service" }, 400);

  const kind = listing.kind === "live_event" ? "live_event" : "consult_1to1";
  const config = await readConfig(env);
  // Same lane predicate as every other purchase surface — a half-configured commercial
  // lane must not be reachable through a new door. [COMM-FLAG-UNIFY-1]
  if (commercialLaneState(config, kind) !== "on") {
    return json({ error: "checkout unavailable", reason: "lane_not_open" }, 503);
  }

  // THE PRICE IS COMPUTED HERE, FROM THE LISTING. The client sends no amount and could
  // not be believed if it did.
  const base = Math.trunc(Number(listing.price));
  if (!Number.isSafeInteger(base) || base < 0) return json({ error: "invalid price" }, 409);
  const tax = taxFor(config, base);
  if (!tax) return json({ error: "tax configuration invalid" }, 503);
  if (tax.buyerTotal <= 0) {
    // Free listings do not belong on a payment rail; they go through the ordinary
    // commercial checkout, which handles price === 0 correctly.
    return json({ error: "free listings use the standard checkout" }, 400);
  }

  const purchaseId = crypto.randomUUID();
  const gatewayOrderId = `avatok_${purchaseId.replace(/-/g, "").slice(0, 24)}`;
  const now = Date.now();

  // Row written BEFORE the gateway call. If createCashfreeOrder times out after Cashfree
  // has already created the order, this row is the only evidence the attempt existed —
  // without it a buyer could pay against an order we have no record of.
  await db.prepare(
    `INSERT INTO direct_purchases
      (purchase_id,gateway,gateway_order_id,uid,listing_id,booking_id,kind,
       base_paise,gst_paise,total_paise,status,affiliate_uid,created_at,updated_at)
     VALUES (?1,'cashfree',?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10,?11,?11)`,
  ).bind(purchaseId, gatewayOrderId, auth.uid, listing.id, bookingId, kind,
    tax.taxableBase * 100, tax.gstAmount * 100, tax.buyerTotal * 100,
    affiliateDeviceFrom(req), now).run();

  const origin = new URL(req.url).origin;
  const created = await createCashfreeOrder(env, {
    orderId: gatewayOrderId,
    amountPaise: tax.buyerTotal * 100,
    customerId: auth.uid,
    customerEmail: null,
    customerPhone: null,
    returnUrl: env.CASHFREE_RETURN_URL ? `${env.CASHFREE_RETURN_URL}?purchase=${purchaseId}` : null,
    notifyUrl: `${origin}/api/pay/cashfree/webhook`,
  });
  if ("error" in created) {
    await db.prepare("UPDATE direct_purchases SET status='failed',last_error=?2,updated_at=?3 WHERE purchase_id=?1")
      .bind(purchaseId, created.error.slice(0, 300), Date.now()).run();
    commercialEvent(env, "checkout", auth.uid, { kind, outcome: "refused", reason: "gateway_error" });
    return json({ error: "could not start payment", reason: created.error }, created.status);
  }

  track(env, auth.uid, "cashfree_order_created", APP, {
    listing_id: listing.id, kind, total_paise: tax.buyerTotal * 100,
  });
  return json({
    ok: true,
    purchase_id: purchaseId,
    payment_session_id: created.payment_session_id,
    gateway_order_id: gatewayOrderId,
    // Itemised so the buyer sees exactly what they are paying, per [TAX-GST-1].
    base_amount: tax.taxableBase,
    gst_amount: tax.gstAmount,
    gst_rate_pct: tax.gstRatePct,
    total_amount: tax.buyerTotal,
    currency: "INR",
  });
}

/**
 * POST /api/pay/cashfree/webhook — signed by Cashfree, NOT authenticated as a user.
 *
 * Order of operations, and each step is load-bearing:
 *   1. verify the signature over the RAW body (parse after, never before)
 *   2. re-read the order FROM THE GATEWAY — the webhook body says what happened; the
 *      gateway says what is true, and only one of those is worth funding escrow on
 *   3. fund escrow via holdExternal, idempotent on the gateway order id
 *   4. hand off to the commercial lane for the order/snapshot/entitlement
 *
 * Returns 200 on anything it has already handled. A webhook endpoint that 500s on a
 * duplicate gets retried forever.
 */
export async function cashfreeWebhook(req: Request, env: Env): Promise<Response> {
  if (!cashfreeConfigured(env)) return json({ error: "unconfigured" }, 503);
  const raw = await req.text();
  const ok = await verifyCashfreeSignature(
    env, raw, req.headers.get("x-webhook-signature"), req.headers.get("x-webhook-timestamp"),
  );
  // 401 and nothing else. An unsigned body is not evidence of anything, and must never
  // reach the parsing below.
  if (!ok) return json({ error: "bad signature" }, 401);

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return json({ error: "bad body" }, 400); }
  const gatewayOrderId = String(payload?.data?.order?.order_id ?? "");
  if (!gatewayOrderId) return json({ ok: true, ignored: "no order id" });

  const db = metaDb(env);
  const row = await db.prepare(
    `SELECT purchase_id,gateway_order_id,uid,listing_id,booking_id,kind,base_paise,gst_paise,
            total_paise,status,affiliate_uid,order_id
       FROM direct_purchases WHERE gateway_order_id=?1`,
  ).bind(gatewayOrderId).first<PurchaseRow>();
  if (!row) return json({ ok: true, ignored: "unknown order" });
  // Already done. 200, not an error — this is the normal duplicate-delivery path.
  if (row.status === "credited" || row.status === "refunded") return json({ ok: true, duplicate: true });

  // Step 2. The gateway is the authority, not the body we were handed.
  const truth = await fetchCashfreeOrder(env, gatewayOrderId);
  if (!truth) return json({ error: "could not verify with gateway" }, 502);
  if (truth.order_status !== "PAID") {
    await db.prepare("UPDATE direct_purchases SET status=?2,updated_at=?3 WHERE purchase_id=?1")
      .bind(row.purchase_id, truth.order_status === "EXPIRED" ? "failed" : row.status, Date.now()).run();
    return json({ ok: true, order_status: truth.order_status });
  }
  // Amount check. A mismatch means the order was tampered with or the price moved
  // between creation and payment; either way this must not silently fund escrow for a
  // different number than the buyer agreed to.
  const paidPaise = Math.round(Number(truth.order_amount) * 100);
  if (paidPaise !== row.total_paise) {
    await db.prepare("UPDATE direct_purchases SET status='failed',last_error=?2,updated_at=?3 WHERE purchase_id=?1")
      .bind(row.purchase_id, `amount mismatch: gateway ${paidPaise} vs expected ${row.total_paise}`, Date.now()).run();
    track(env, row.uid, "cashfree_amount_mismatch", APP, { expected: row.total_paise, got: paidPaise });
    return json({ ok: true, mismatch: true });
  }

  await db.prepare("UPDATE direct_purchases SET status='paid',cf_order_id=?2,updated_at=?3 WHERE purchase_id=?1")
    .bind(row.purchase_id, truth.cf_order_id ?? null, Date.now()).run();

  // Step 3. Fund escrow. Internal amounts are whole tokens (1 token = ₹1); paise exist
  // only at the gateway boundary.
  const orderId = `cashfree-order:${row.purchase_id}`;
  const totalTokens = Math.round(row.total_paise / 100);
  const funded = await holdExternal(env, orderId, totalTokens, {
    opId: `cashfree:hold:${gatewayOrderId}`,
    uid: row.uid,
    source: "cashfree",
    ref: gatewayOrderId,
  });
  if (!funded.ok) {
    await db.prepare("UPDATE direct_purchases SET last_error=?2,updated_at=?3 WHERE purchase_id=?1")
      .bind(row.purchase_id, "escrow funding failed", Date.now()).run();
    // 500 so Cashfree retries: the money IS taken and the buyer has nothing yet, so
    // giving up quietly is the worst available option.
    return json({ error: "escrow funding failed" }, 500);
  }

  await db.prepare("UPDATE direct_purchases SET status='credited',order_id=?2,updated_at=?3 WHERE purchase_id=?1")
    .bind(row.purchase_id, orderId, Date.now()).run();

  track(env, row.uid, "cashfree_payment_credited", APP, {
    listing_id: row.listing_id, kind: row.kind, total_paise: row.total_paise,
  });
  commercialEvent(env, "checkout", row.uid, { kind: row.kind, outcome: "authorized", rail: "cashfree" });
  return json({ ok: true, purchase_id: row.purchase_id, order_id: orderId });
}

/** GET /api/pay/cashfree/status?purchase=<id> — poll while the webhook is in flight. */
export async function cashfreeStatus(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const purchaseId = new URL(req.url).searchParams.get("purchase") || "";
  if (!purchaseId) return json({ error: "purchase required" }, 400);
  const row = await metaDb(env).prepare(
    "SELECT purchase_id,uid,listing_id,kind,status,order_id,total_paise FROM direct_purchases WHERE purchase_id=?1",
  ).bind(purchaseId).first<PurchaseRow>();
  if (!row || row.uid !== auth.uid) return json({ error: "not found" }, 404);
  return json({
    ok: true,
    purchase_id: row.purchase_id,
    status: row.status,
    listing_id: row.listing_id,
    order_id: row.order_id,
    total_amount: Math.round(Number(row.total_paise) / 100),
  });
}
