// [PAY-RAIL-1] Generic multi-gateway routes — Razorpay, Paytm, Stripe (international,
// non-INR), plus Cashfree wired for completeness (see lib/payments/registry.ts).
//
//   GET  /api/pay/methods            requireUser  → gateways this buyer can use
//   POST /api/pay/:gateway/order     requireUser  → { order_id, gateway_order_id, ... }
//   POST /api/pay/:gateway/webhook   signed       → verify raw, then provision
//   GET  /api/pay/:gateway/status    requireUser  → poll while the webhook is in flight
//
// This generalises routes/cashfree.ts — read that file's header before touching this one,
// the invariants are the same:
//
//   1. The webhook is the only thing that may mark an order paid, and even it re-reads
//      the order from the gateway (where the adapter supports it) before believing itself.
//   2. The signature is verified over the RAW body, BEFORE parsing. No adapter's webhook
//      path may call req.json() before verifyWebhook() has already returned true.
//   3. Idempotent on (gateway, gateway_payment_id) — a replayed webhook is a 200 with no
//      side effect, via gateway_webhook_events (worker/migrations/2026-09-01-gateway-orders.sql).
//   4. A 200 from a refund call means "accepted", not "refunded".
//
// [PAY-RAIL-2] CLOSED the gap the paragraph below used to describe. `provisionFromGatewayPurchase`
// (routes/commercial_checkout.ts) now takes an explicit `gateway` argument — this file
// passes `gateway: adapter.id` below, so a Razorpay/Paytm/Stripe purchase is ledgered and
// receipted under ITS OWN name (order-id prefix, funding.rail, ledger source) instead of
// being mislabeled "cashfree". `commercial_refund_rail.ts` was made gateway-aware to match:
// it now also looks in `gateway_orders` (not just Cashfree's own `direct_purchases`) and
// dispatches the refund to the correct adapter. Cashfree itself is untouched — the
// argument defaults to "cashfree", so every existing Cashfree row and the dedicated
// /api/pay/cashfree/* route keep behaving byte-for-byte as before.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { taxFor } from "../lib/commercial_tax";
import { commercialLaneState } from "../lib/commercial_lane";
import { commercialEvent } from "../lib/commercial_telemetry";
import { provisionFromGatewayPurchase } from "./commercial_checkout";
import { resolveGateway, listEnabledMethods, gatewayFlagOn } from "../lib/payments/registry";
import type { GatewayAdapter } from "../lib/payments/types";
import { track, trackException } from "../hooks";
import { payAffiliateBountyOnPurchase } from "./affiliate";

const APP = "avapay";

type OrderRow = {
  order_id: string;
  gateway: string;
  gateway_order_id: string;
  uid: string;
  listing_id: string;
  booking_id: string | null;
  kind: string;
  slot_start: number | null;
  slot_end: number | null;
  amount_paise: number;
  currency: string;
  status: string;
  gateway_payment_id: string | null;
};

async function schemaReady(env: Env): Promise<boolean> {
  try {
    await metaDb(env).prepare(
      "SELECT order_id,gateway,gateway_order_id,uid,status FROM gateway_orders LIMIT 1",
    ).first();
    return true;
  } catch {
    return false;
  }
}

/** The gate every route below shares: the gateway must exist, its own flag must be on,
 *  the picker must be on, its secrets must be configured, and the correlation table must
 *  exist. Any one missing ⇒ the rail is off, loudly — never half-working. */
async function gatewayEnabled(
  env: Env, gatewayId: string,
): Promise<{ ok: true; adapter: GatewayAdapter } | { ok: false; reason: string; status: number }> {
  const adapter = resolveGateway(gatewayId);
  if (!adapter) return { ok: false, reason: "unknown_gateway", status: 404 };
  let config;
  try { config = await readConfig(env); } catch { return { ok: false, reason: "config_unavailable", status: 503 }; }
  if (config.payGatewayPickerEnabled !== true) return { ok: false, reason: "gateway_picker_disabled", status: 404 };
  if (!gatewayFlagOn(config, adapter.id)) return { ok: false, reason: "gateway_disabled", status: 404 };
  if (!adapter.configured(env)) return { ok: false, reason: "gateway_unconfigured", status: 503 };
  if (!await schemaReady(env)) return { ok: false, reason: "schema_unavailable", status: 503 };
  return { ok: true, adapter };
}

/** GET /api/pay/methods */
export async function payMethods(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  try {
    const config = await readConfig(env);
    const methods = await listEnabledMethods(env, config);
    // An empty list is a legitimate answer (spec §2.4) — the client renders "payments
    // aren't open yet", not an error.
    return json({ currency: "INR", methods });
  } catch (err) {
    await trackException(env, err, { uid: auth.uid, route: "/api/pay/methods", method: "GET", handled: true, app_name: APP });
    return json({ error: "methods unavailable" }, 503);
  }
}

/** POST /api/pay/:gateway/order  { listingId, bookingId?, slot?, order_id? } */
export async function payCreateOrder(req: Request, env: Env, gatewayId: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const gate = await gatewayEnabled(env, gatewayId);
  if (!gate.ok) return json({ error: "checkout unavailable", reason: gate.reason }, gate.status);
  const adapter = gate.adapter;

  const b = (await req.json().catch(() => ({}))) as {
    listingId?: unknown; bookingId?: unknown; slot?: unknown; order_id?: unknown;
  };
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
    return json({ error: "free listings use the standard checkout" }, 400);
  }

  // Stripe is the international, non-INR lane (spec §1) — USD is the working default
  // until a per-listing/per-buyer currency exists to derive this from.
  const currency = adapter.id === "stripe" ? "USD" : "INR";
  if (adapter.id === "stripe" && currency.toUpperCase() === "INR") {
    // Belt and suspenders — the adapter itself also refuses this, per spec §1's "Stripe
    // (international, non-INR only)". A currency var misconfigured to INR must not reach
    // the adapter and get refused there LOUDLY only after a wasted round trip.
    return json({ error: "stripe is for international buyers only" }, 400);
  }

  let slotStart: number | null = null;
  let slotEnd: number | null = null;
  if (kind === "consult_1to1") {
    const raw = (b.slot && typeof b.slot === "object" && !Array.isArray(b.slot))
      ? b.slot as Record<string, unknown> : null;
    if (!raw) return json({ error: "slot {start_at,end_at} required" }, 400);
    slotStart = Math.trunc(Number(raw.start_at));
    slotEnd = Math.trunc(Number(raw.end_at ?? (slotStart + Number(listing.duration_min ?? 60) * 60_000)));
    if (!Number.isSafeInteger(slotStart) || !Number.isSafeInteger(slotEnd)
      || slotEnd <= slotStart || slotStart <= Date.now()) {
      return json({ error: "future consultation slot required" }, 400);
    }
  }

  // Reuse the caller's own order id when one is given (spec §2.4's "existing our-order-id"
  // contract), otherwise mint one — mirrors direct_purchases minting purchase_id.
  const orderId = b.order_id ? String(b.order_id) : `pay-order:${crypto.randomUUID()}`;
  const now = Date.now();

  // Row written BEFORE the gateway call, same reasoning as direct_purchases: if
  // createOrder times out after the gateway already created the order, this row is the
  // only evidence the attempt existed.
  try {
    // gateway_order_id starts as OUR order id — a placeholder that is already unique
    // (order_id is the table's primary key), so the (gateway, gateway_order_id) unique
    // index cannot collide across concurrent orders the way a shared literal like
    // 'pending' would. It is overwritten with the gateway's real id right after createOrder.
    await db.prepare(
      `INSERT INTO gateway_orders
        (order_id,gateway,gateway_order_id,uid,listing_id,booking_id,kind,
         slot_start,slot_end,amount_paise,currency,status,created_at,updated_at)
       VALUES (?1,?2,?1,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?11)`,
    ).bind(orderId, adapter.id, auth.uid, listing.id, bookingId, kind,
      slotStart, slotEnd, tax.buyerTotal * 100, currency, now).run();
  } catch (err) {
    // Most likely a reused order_id — PRIMARY KEY collision. Treat as a bad request
    // rather than a 500; a genuine retry should let the gateway mint a fresh id.
    await trackException(env, err, { uid: auth.uid, route: `/api/pay/${adapter.id}/order`, method: "POST", handled: true, app_name: APP });
    return json({ error: "order_id already used" }, 409);
  }

  let created;
  try {
    created = await adapter.createOrder(env, {
      orderId, amountPaise: tax.buyerTotal * 100, currency, uid: auth.uid,
      listingId: listing.id, kind,
    });
  } catch (err) {
    await trackException(env, err, { uid: auth.uid, route: `/api/pay/${adapter.id}/order`, method: "POST", handled: true, app_name: APP });
    created = { error: "adapter_threw", status: 502 };
  }
  if ("error" in created) {
    await db.prepare("UPDATE gateway_orders SET status='failed',last_error=?2,updated_at=?3 WHERE order_id=?1")
      .bind(orderId, created.error.slice(0, 300), Date.now()).run();
    commercialEvent(env, "checkout", auth.uid, { kind, outcome: "refused", reason: "gateway_error", gateway: adapter.id });
    return json({ error: "could not start payment", reason: created.error }, created.status);
  }

  await db.prepare("UPDATE gateway_orders SET gateway_order_id=?2,updated_at=?3 WHERE order_id=?1")
    .bind(orderId, created.gateway_order_id, Date.now()).run();

  await track(env, auth.uid, "gateway_order_created", APP, {
    listing_id: listing.id, kind, total_paise: tax.buyerTotal * 100, gateway: adapter.id,
  });
  return json({
    ok: true,
    order_id: orderId,
    gateway: created.gateway,
    gateway_order_id: created.gateway_order_id,
    amount_paise: created.amount_paise,
    currency: created.currency,
    client_payload: created.client_payload,
    base_amount: tax.taxableBase,
    gst_amount: tax.gstAmount,
    gst_rate_pct: tax.gstRatePct,
    total_amount: tax.buyerTotal,
  });
}

/**
 * POST /api/pay/:gateway/webhook — signed by the gateway, NOT authenticated as a user.
 *
 * Order of operations, and each step is load-bearing (spec §2.5):
 *   1. read the raw body ONCE, verify the signature over it, and only then parse
 *   2. idempotency: INSERT OR IGNORE (gateway, gateway_payment_id) — a 0-row insert means
 *      this exact payment event has already been handled; return 200 and stop
 *   3. re-read the order from the gateway where the adapter supports it (fetchOrder) —
 *      the webhook body says what happened, the gateway says what is true
 *   4. verify the amount against our stored order; a mismatch is review_pending, never a
 *      silent accept
 *   5. hand off to the commercial lane via provisionFromGatewayPurchase
 *
 * Returns 200 on anything it has already handled — a webhook endpoint that 500s on a
 * duplicate gets retried forever.
 */
/**
 * [PAY-PAYTM-TEST-1] Some gateways deliver their result by REDIRECTING THE
 * BUYER'S BROWSER at this endpoint with a form POST, rather than calling it
 * server-to-server. Paytm's Show Payment Page flow does exactly that: the
 * cashier posts `application/x-www-form-urlencoded` fields to `callbackUrl`,
 * with the buyer sitting in front of it. Answering that with a JSON body leaves
 * a person staring at `{"ok":true}` and no way back to their booking.
 *
 * So: run the real handler, then, if this was a browser rather than a server,
 * send the buyer on to the web app's return page, which polls for the
 * provisioned booking. The JSON answer is still what a server-to-server caller
 * gets, and the handler itself is unchanged and unaware of the difference.
 */
export async function payWebhook(req: Request, env: Env, gatewayId: string): Promise<Response> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const browserCallback = contentType.includes("application/x-www-form-urlencoded");
  if (!browserCallback) return payWebhookInner(req, env, gatewayId);

  // The body can only be read once, and the handler needs it intact. Clone
  // first, and read the clone purely to recover the order id for the redirect —
  // this copy is never trusted for anything, since it has not been verified.
  const forRedirect = req.clone();
  const response = await payWebhookInner(req, env, gatewayId);

  let orderId = "";
  try {
    orderId = new URLSearchParams(await forRedirect.text()).get("ORDERID") ?? "";
  } catch {
    // Unreadable body — the return page copes with a missing order id by
    // pointing the buyer at their bookings list.
  }

  const webBase = String(env.WEB_BASE_URL ?? "https://avatok.ai").replace(/\/+$/, "");
  const target = new URL(`${webBase}/pay/return`);
  target.searchParams.set("gateway", gatewayId);
  if (orderId) target.searchParams.set("order_id", orderId);
  // `ok` is a hint for the first paint only. The return page still confirms
  // against /api/pay/:gateway/status before it tells the buyer anything —
  // a query parameter is not evidence that money moved.
  target.searchParams.set("ok", response.status < 400 ? "1" : "0");

  // 303: turn the gateway's POST into a GET, so a refresh on the return page
  // does not re-post the callback.
  return new Response(null, { status: 303, headers: { location: target.toString() } });
}

async function payWebhookInner(req: Request, env: Env, gatewayId: string): Promise<Response> {
  const adapter = resolveGateway(gatewayId);
  if (!adapter) return json({ error: "unknown gateway" }, 404);
  if (!adapter.configured(env)) return json({ error: "unconfigured" }, 503);

  // STEP 1. Read the raw body once. Nothing below may call req.json() before this.
  const raw = await req.text();
  let verified: boolean;
  try {
    verified = await adapter.verifyWebhook(env, raw, req.headers);
  } catch (err) {
    await trackException(env, err, { route: `/api/pay/${adapter.id}/webhook`, method: "POST", handled: true, app_name: APP });
    verified = false;
  }
  // 401 and nothing else. An unsigned body is not evidence of anything and must never
  // reach parseWebhook below.
  if (!verified) return json({ error: "bad signature" }, 401);

  const parsed = adapter.parseWebhook(raw);
  if (!parsed) return json({ ok: true, ignored: "unparseable" });
  if (!parsed.gateway_payment_id) {
    // No stable payment id to dedupe on yet (e.g. an order-created event before capture).
    // Nothing to provision either — acknowledge and wait for the event that carries one.
    return json({ ok: true, ignored: "no payment id" });
  }

  const db = metaDb(env);

  // STEP 2. Idempotency. A 0-row insert IS the duplicate-delivery signal.
  const dedupe = await db.prepare(
    "INSERT OR IGNORE INTO gateway_webhook_events (gateway,gateway_payment_id,order_id,received_at) VALUES (?1,?2,?3,?4)",
  ).bind(adapter.id, parsed.gateway_payment_id, parsed.our_order_id, Date.now()).run();
  if (!dedupe.meta || dedupe.meta.changes === 0) {
    return json({ ok: true, duplicate: true });
  }

  const row = await db.prepare(
    `SELECT order_id,gateway,gateway_order_id,uid,listing_id,booking_id,kind,slot_start,slot_end,
            amount_paise,currency,status,gateway_payment_id
       FROM gateway_orders WHERE order_id=?1 AND gateway=?2`,
  ).bind(parsed.our_order_id, adapter.id).first<OrderRow>();
  if (!row) return json({ ok: true, ignored: "unknown order" });
  // Already done. 200, not an error — normal duplicate-delivery path at the ORDER level
  // (the payment-id dedupe above catches most replays; this catches a second distinct
  // payment event for an order already finished, e.g. a stray refund webhook after credit).
  if (row.status === "credited" || row.status === "refunded") return json({ ok: true, duplicate: true });

  if (parsed.status === "failed") {
    await db.prepare("UPDATE gateway_orders SET status='failed',gateway_payment_id=?2,updated_at=?3 WHERE order_id=?1")
      .bind(row.order_id, parsed.gateway_payment_id, Date.now()).run();
    return json({ ok: true, status: "failed" });
  }
  if (parsed.status !== "paid") {
    // pending / refunded-before-paid — nothing to provision yet.
    await db.prepare("UPDATE gateway_orders SET gateway_payment_id=?2,updated_at=?3 WHERE order_id=?1")
      .bind(row.order_id, parsed.gateway_payment_id, Date.now()).run();
    return json({ ok: true, status: parsed.status });
  }

  // STEP 3. Re-read from the gateway where supported. The webhook body said "paid"; ask
  // the gateway itself before believing it, same as the Cashfree lane.
  const truth = await adapter.fetchOrder(env, parsed.gateway_order_id).catch(() => null);
  const confirmedPaise = truth ? truth.amount_paise : parsed.amount_paise;

  // STEP 4. Amount check against what we stored at order-creation time.
  if (confirmedPaise !== row.amount_paise) {
    await db.prepare("UPDATE gateway_orders SET status='review_pending',last_error=?2,gateway_payment_id=?3,updated_at=?4 WHERE order_id=?1")
      .bind(row.order_id, `amount mismatch: gateway ${confirmedPaise} vs expected ${row.amount_paise}`, parsed.gateway_payment_id, Date.now()).run();
    await track(env, row.uid, "gateway_amount_mismatch", APP, {
      gateway: adapter.id, expected: row.amount_paise, got: confirmedPaise,
    });
    return json({ ok: true, review_pending: true, reason: "amount_mismatch" });
  }

  await db.prepare("UPDATE gateway_orders SET status='paid',gateway_payment_id=?2,updated_at=?3 WHERE order_id=?1")
    .bind(row.order_id, parsed.gateway_payment_id, Date.now()).run();

  // STEP 5. Fund escrow AND issue the ticket, through the SAME function the Cashfree and
  // wallet lanes use. `gateway: adapter.id` is what makes this show up under its own name
  // in the ledger, the commercial order id and commercial_refund_rail.ts (see [PAY-RAIL-2]
  // in this file's header) instead of being mislabeled "cashfree".
  const bridgeOrderId = `${adapter.id}-order:${row.order_id}`;
  const totalTokens = Math.round(row.amount_paise / 100);
  let provisioned: Response;
  try {
    provisioned = await provisionFromGatewayPurchase(env, {
      uid: row.uid,
      listingId: row.listing_id,
      bookingId: row.booking_id,
      kind: row.kind === "live_event" ? "live_event" : "consult_1to1",
      chargedTokens: totalTokens,
      purchaseId: row.order_id,
      gatewayRef: row.gateway_order_id,
      gateway: adapter.id,
      slot: row.slot_start != null && row.slot_end != null
        ? { start_at: Number(row.slot_start), end_at: Number(row.slot_end) }
        : null,
    });
  } catch (err) {
    await trackException(env, err, {
      uid: row.uid, route: `/api/pay/${adapter.id}/webhook`, method: "POST", handled: true, app_name: APP,
      extra: { order_id: row.order_id },
    });
    return json({ error: "provisioning threw", retry: true }, 500);
  }
  if (!provisioned.ok) {
    const detail = await provisioned.clone().text().catch(() => "");
    await db.prepare("UPDATE gateway_orders SET last_error=?2,updated_at=?3 WHERE order_id=?1")
      .bind(row.order_id, `provision failed: ${detail}`.slice(0, 300), Date.now()).run();
    // 5xx ⇒ transient, so 500 and let the gateway retry: the money IS taken and the
    // buyer has nothing yet. 4xx ⇒ a decided refusal (price changed, listing gone) — 200
    // stops the retries and leaves the row for a human, per spec §2.5 rule 4.
    return provisioned.status >= 500
      ? json({ error: "provisioning failed", retry: true }, 500)
      : json({ ok: true, provisioning_refused: true, status: provisioned.status });
  }

  await db.prepare("UPDATE gateway_orders SET status='credited',updated_at=?2 WHERE order_id=?1")
    .bind(row.order_id, Date.now()).run();

  // Same affiliate-bounty behaviour as the Cashfree lane — fire-and-forget, never blocks
  // the ticket. [GUEST-AFFIL-BOUNTY-1]
  try {
    const creatorPct = Math.trunc(Number((await readConfig(env)).commercialCreatorFeePct));
    // gateway_orders has no separate base/tax split (unlike direct_purchases) — the
    // platform's cut is approximated off the gross total. Acceptable for a bounty ceiling;
    // not used anywhere money-authoritative.
    const platformCut = totalTokens - Math.round(totalTokens * creatorPct / 100);
    await payAffiliateBountyOnPurchase(env, {
      referredUid: row.uid,
      purchaseId: row.order_id,
      grossCoins: totalTokens,
      platformCut,
      listingId: row.listing_id,
    });
  } catch { /* never blocks the ticket */ }

  await track(env, row.uid, "gateway_payment_credited", APP, {
    listing_id: row.listing_id, kind: row.kind, total_paise: row.amount_paise, gateway: adapter.id,
  });
  commercialEvent(env, "checkout", row.uid, { kind: row.kind, outcome: "authorized", rail: adapter.id });
  return json({ ok: true, order_id: row.order_id, bridge_order_id: bridgeOrderId });
}

/** GET /api/pay/:gateway/status?order_id=<id> — poll while the webhook is in flight. */
export async function payStatus(req: Request, env: Env, gatewayId: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const adapter = resolveGateway(gatewayId);
  if (!adapter) return json({ error: "unknown gateway" }, 404);
  const orderId = new URL(req.url).searchParams.get("order_id") || "";
  if (!orderId) return json({ error: "order_id required" }, 400);
  const row = await metaDb(env).prepare(
    "SELECT order_id,uid,listing_id,kind,status,amount_paise FROM gateway_orders WHERE order_id=?1 AND gateway=?2",
  ).bind(orderId, adapter.id).first<OrderRow>();
  if (!row || row.uid !== auth.uid) return json({ error: "not found" }, 404);
  return json({
    ok: true,
    order_id: row.order_id,
    status: row.status,
    listing_id: row.listing_id,
    total_amount: Math.round(Number(row.amount_paise) / 100),
  });
}
