// Phase 2C — server-authoritative commercial checkout.
//
// This is deliberately a separate lane from the legacy listing-book route. A
// public listing URL is discovery only; this route requires an authenticated account,
// a caller-owned idempotency key, and an explicit policy confirmation. It
// creates the order, immutable commercial policy snapshot, escrow hold (when
// priced), and account-bound entitlement before any GetStream admission can
// occur.

import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig, type PlatformConfig } from "./config";
import { hold, refund } from "../ledger";
import { json } from "../util";
import { commercialEvent } from "../lib/commercial_telemetry";
import { claimBlock, releaseBlocks } from "../cal/engine";
import { notifyCommercialUsers } from "../lib/commercial_notifications";

type CheckoutKind = "live_event" | "consult_1to1";

type Listing = {
  id: string;
  creator_id: string;
  kind: string;
  title: string;
  status: string;
  price: number;
  currency_display: string | null;
  starts_at: number | null;
  duration_min: number | null;
  capacity: number | null;
  attrs: string | null;
};

type CheckoutOperation = {
  operation_id: string;
  account_id: string;
  kind: CheckoutKind;
  listing_id: string;
  request_sha256: string;
  order_id: string;
  state: "started" | "completed" | "failed";
  response_json: string | null;
};

type OrderAuthority = {
  id: string;
  listing_id: string;
  buyer_id: string;
  creator_id: string;
  amount: number;
  status: string;
  kind: string;
  fee_pct: number;
  escrow_account: string | null;
  booking_id: string | null;
};

type PolicyAuthority = {
  policy_snapshot_id: string;
  order_id: string;
  listing_id: string;
  booking_id: string | null;
  buyer_id: string;
  creator_id: string;
  kind: CheckoutKind;
  gross_amount: number;
  currency: string;
  creator_fee_pct: number;
  settlement_hold_hours: number;
  platform_fee_amount: number;
  creator_amount: number;
  cancellation_policy_json: string;
  conversion_snapshot_json: string | null;
  policy_version: string;
};

type CheckoutPolicy = {
  refund_window_hours: number;
  cancellation_window_hours: number;
  booking_notice_hours: number;
  reschedule_allowed: boolean;
  preparation_instructions: string;
  no_show_policy: "session_charged";
  auto_release_on_provider_end: true;
  min_connected_ms: number;
};

type CalendarClaim = { userId: string; sourceRef: string; blockId: string };

async function claimCommercialBlock(env: Env, args: {
  userId: string; sourceRef: string; start: number; end: number; title: string;
}): Promise<{ ok: true; claim: CalendarClaim } | { ok: false; conflict: Record<string, unknown> }> {
  const existing = await metaDb(env).prepare(
    `SELECT id,starts_at,ends_at FROM calendar_blocks
       WHERE user_id=?1 AND source_app='avaconsult' AND source_ref=?2 AND status='busy' LIMIT 1`,
  ).bind(args.userId, args.sourceRef).first<{ id: string; starts_at: number; ends_at: number }>();
  if (existing) {
    if (Number(existing.starts_at) === args.start && Number(existing.ends_at) === args.end) {
      return { ok: true, claim: { userId: args.userId, sourceRef: args.sourceRef, blockId: existing.id } };
    }
    return { ok: false, conflict: { source_app: "avaconsult", title: args.title, starts_at: existing.starts_at, ends_at: existing.ends_at } };
  }
  const claim = await claimBlock(env, {
    userId: args.userId, sourceApp: "avaconsult", sourceRef: args.sourceRef,
    start: args.start, end: args.end, title: args.title,
  });
  return claim.ok
    ? { ok: true, claim: { userId: args.userId, sourceRef: args.sourceRef, blockId: claim.id } }
    : { ok: false, conflict: claim.conflict as unknown as Record<string, unknown> };
}

const CHECKOUT_POLICY_VERSION = "commercial-policy-v1";
const CHECKOUT_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
const REFUND_WINDOWS = new Set([0, 12, 24, 48]);
const BOOKING_NOTICE_HOURS = new Set([1, 2, 6, 24]);

function checkoutKind(pathKind: string): CheckoutKind | null {
  if (pathKind === "live") return "live_event";
  if (pathKind === "consult") return "consult_1to1";
  return null;
}

function idFrom(req: Request): { kind: CheckoutKind; listingId: string } | null {
  const match = new URL(req.url).pathname.match(
    /^\/api\/commercial\/(live|consult)\/([A-Za-z0-9-]{1,64})\/checkout$/,
  );
  if (!match) return null;
  const kind = checkoutKind(match[1]);
  return kind ? { kind, listingId: match[2] } : null;
}

function idempotencyKey(req: Request): string | null {
  const value = (req.headers.get("idempotency-key") ?? "").trim();
  return CHECKOUT_ID.test(value) ? value : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Schema is migration-owned. A read probe fails closed while the dated
 * migration is absent; checkout must never create authority tables on demand. */
async function assertCheckoutSchema(env: Env): Promise<boolean> {
  try {
    await metaDb(env).prepare(
      `SELECT operation_id,account_id,kind,listing_id,request_sha256,order_id,state,response_json
         FROM commercial_checkout_operations LIMIT 1`,
    ).first<CheckoutOperation>();
    return true;
  } catch {
    return false;
  }
}

function parseAttrs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boundedInt(value: unknown, fallback: number, allowed: Set<number>): number | null {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && allowed.has(n) ? n : null;
}

function hasAttr(attrs: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(attrs, key);
}

function policyFor(kind: CheckoutKind, attrs: Record<string, unknown>): CheckoutPolicy | null {
  if (kind === "live_event") {
    if (!hasAttr(attrs, "commercial_refund_window_hours")) return null;
    const refundWindow = boundedInt(attrs.commercial_refund_window_hours, 0, REFUND_WINDOWS);
    if (refundWindow === null) return null;
    return {
      refund_window_hours: refundWindow,
      cancellation_window_hours: 0,
      booking_notice_hours: 0,
      reschedule_allowed: false,
      preparation_instructions: "",
      no_show_policy: "session_charged",
      auto_release_on_provider_end: true,
      min_connected_ms: 60_000,
    };
  }
  const required = [
    "commercial_cancellation_window_hours",
    "commercial_booking_notice_hours",
    "commercial_reschedule_allowed",
    "commercial_preparation_instructions",
    "commercial_no_show_policy",
  ];
  if (required.some((key) => !hasAttr(attrs, key))) return null;
  const cancellation = boundedInt(attrs.commercial_cancellation_window_hours, 0, REFUND_WINDOWS);
  const notice = boundedInt(attrs.commercial_booking_notice_hours, 24, BOOKING_NOTICE_HOURS);
  const reschedule = attrs.commercial_reschedule_allowed;
  const prep = attrs.commercial_preparation_instructions;
  if (cancellation === null || notice === null || typeof reschedule !== "boolean"
    || typeof prep !== "string" || prep.length > 600
    || (attrs.commercial_no_show_policy !== undefined
      && attrs.commercial_no_show_policy !== "session_charged")) {
    return null;
  }
  return {
    refund_window_hours: 0,
    cancellation_window_hours: cancellation,
    booking_notice_hours: notice,
    reschedule_allowed: reschedule,
    preparation_instructions: prep,
    no_show_policy: "session_charged",
    auto_release_on_provider_end: true,
    min_connected_ms: 60_000,
  };
}

function configAllows(kind: CheckoutKind, config: PlatformConfig): boolean {
  return kind === "live_event"
    ? config.commercialLiveCheckoutEnabled === true
    : config.commercialConsultCheckoutEnabled === true;
}

function safeResponse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function finishOperation(
  env: Env,
  operationId: string,
  state: "completed" | "failed",
  response: Record<string, unknown>,
): Promise<void> {
  const encoded = JSON.stringify(response);
  await metaDb(env).prepare(
    `UPDATE commercial_checkout_operations SET state=?2,response_json=?3,updated_at=?4
     WHERE operation_id=?1 AND state='started'`,
  ).bind(operationId, state, encoded, Date.now()).run();
}

function canonicalRequest(args: {
  uid: string;
  kind: CheckoutKind;
  listingId: string;
  idem: string;
  slotStart: number | null;
  slotEnd: number | null;
}): string {
  return JSON.stringify({
    account_id: args.uid,
    kind: args.kind,
    listing_id: args.listingId,
    idempotency_key: args.idem,
    slot_start: args.slotStart,
    slot_end: args.slotEnd,
  });
}

/** POST /api/commercial/{live|consult}/:listingId/checkout. */
export async function commercialCheckout(req: Request, env: Env): Promise<Response> {
  const route = idFrom(req);
  if (!route) return json({ error: "bad commercial checkout path" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const idem = idempotencyKey(req);
  if (!idem) return json({ error: "valid Idempotency-Key required" }, 400);
  const config = await readConfig(env);
  if (!configAllows(route.kind, config)) {
    commercialEvent(env, "checkout", auth.uid, { kind: route.kind, outcome: "refused", reason: "checkout_disabled" });
    return json({ error: "commercial checkout disabled" }, 404);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.accept_policy !== true) {
    commercialEvent(env, "checkout_consent", auth.uid, { kind: route.kind, outcome: "refused", reason: "policy_confirmation_required" });
    return json({ error: "policy confirmation required" }, 400);
  }
  const listing = await metaDb(env).prepare(
    `SELECT id,creator_id,kind,title,status,price,currency_display,starts_at,duration_min,capacity,attrs
       FROM listings WHERE id=?1`,
  ).bind(route.listingId).first<Listing>();
  if (!listing || listing.kind !== route.kind && !(route.kind === "consult_1to1" && listing.kind === "consult")
    || !["published", "live"].includes(listing.status)) {
    return json({ error: "listing unavailable" }, 404);
  }
  if (listing.creator_id === auth.uid) return json({ error: "cannot buy your own service" }, 400);
  if (route.kind === "consult_1to1" && Number(listing.capacity ?? 1) !== 1) {
    return json({ error: "consultation must have exactly one buyer" }, 409);
  }

  const policy = policyFor(route.kind, parseAttrs(listing.attrs));
  if (!policy) return json({ error: "commercial policy unavailable" }, 409);
  const price = Math.trunc(Number(listing.price));
  if (!Number.isSafeInteger(price) || price < 0) return json({ error: "invalid commercial price" }, 409);
  const startsAt = route.kind === "live_event" ? Math.trunc(Number(listing.starts_at)) : null;
  const endsAt = route.kind === "live_event" && startsAt !== null
    ? startsAt + Math.max(1, Math.trunc(Number(listing.duration_min ?? 60))) * 60_000
    : null;
  if (route.kind === "live_event"
    && (startsAt === null || endsAt === null || !Number.isSafeInteger(startsAt)
      || startsAt <= 0 || endsAt <= startsAt)) {
    return json({ error: "event schedule unavailable" }, 409);
  }

  let slotStart: number | null = null;
  let slotEnd: number | null = null;
  if (route.kind === "consult_1to1") {
    const slot = body.slot;
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      return json({ error: "slot {start_at,end_at} required" }, 400);
    }
    const rawSlot = slot as Record<string, unknown>;
    slotStart = Math.trunc(Number(rawSlot.start_at));
    slotEnd = Math.trunc(Number(rawSlot.end_at ?? (slotStart + Number(listing.duration_min ?? 60) * 60_000)));
    if (!Number.isSafeInteger(slotStart) || !Number.isSafeInteger(slotEnd) || slotEnd <= slotStart || slotStart <= Date.now()) {
      return json({ error: "future consultation slot required" }, 400);
    }
    if (slotStart - Date.now() < policy.booking_notice_hours * 3_600_000) {
      return json({ error: "booking notice policy", booking_notice_hours: policy.booking_notice_hours }, 409);
    }
  }

  const request = canonicalRequest({ uid: auth.uid, kind: route.kind, listingId: listing.id, idem, slotStart, slotEnd });
  const requestHash = await sha256Hex(request);
  const operationHash = await sha256Hex(`${auth.uid}:${idem}`);
  const operationId = `commercial-checkout:${operationHash}`;
  const orderId = `commercial-order:${operationHash}`;
  // Keep the booking identifier URL-safe; it is used by authenticated
  // consultation join/state/control routes after checkout.
  const bookingId = route.kind === "consult_1to1" ? `commercial-booking-${operationHash}` : null;
  if (!await assertCheckoutSchema(env)) return json({ error: "commercial checkout unavailable" }, 503);

  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_checkout_operations
       (operation_id,account_id,kind,listing_id,request_sha256,order_id,state,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'started',?7,?7)`,
  ).bind(operationId, auth.uid, route.kind, listing.id, requestHash, orderId, Date.now()).run();
  const operation = await metaDb(env).prepare(
    `SELECT operation_id,account_id,kind,listing_id,request_sha256,order_id,state,response_json
       FROM commercial_checkout_operations WHERE operation_id=?1`,
  ).bind(operationId).first<CheckoutOperation>();
  if (!operation) return json({ error: "commercial checkout retryable", retryable: true }, 503);
  if (operation.account_id !== auth.uid || operation.kind !== route.kind
    || operation.listing_id !== listing.id || operation.order_id !== orderId) {
    return json({ error: "checkout authority mismatch" }, 409);
  }
  if (operation.request_sha256 !== requestHash) return json({ error: "idempotency key reused for different checkout" }, 409);
  if (operation.state === "completed") {
    commercialEvent(env, "checkout", auth.uid, { kind: route.kind, outcome: "replay" });
    return json({ ...(safeResponse(operation.response_json) ?? {}), idempotent_replay: true });
  }
  if (operation.state === "failed") {
    commercialEvent(env, "checkout", auth.uid, { kind: route.kind, outcome: "replay_failed" });
    return json({ ...(safeResponse(operation.response_json) ?? { error: "checkout failed" }), idempotent_replay: true }, 409);
  }

  const existingEntitlement = await metaDb(env).prepare(
    `SELECT entitlement_id,order_id,booking_id,state,starts_at,ends_at
       FROM commercial_entitlements WHERE kind=?1 AND listing_id=?2 AND account_id=?3
         AND role=?4 AND (?5 IS NULL OR booking_id=?5)
         AND state IN ('reserved','held','active','consumed')
       ORDER BY created_at DESC LIMIT 1`,
  ).bind(route.kind, listing.id, auth.uid, route.kind === "live_event" ? "viewer" : "buyer", bookingId)
    .first<Record<string, unknown>>();
  if (existingEntitlement && String(existingEntitlement.order_id ?? "") !== orderId) {
    commercialEvent(env, "checkout", auth.uid, { kind: route.kind, outcome: "refused", reason: route.kind === "live_event" ? "ticket_already_owned" : "consultation_already_booked" });
    return json({ error: route.kind === "live_event" ? "ticket already owned" : "consultation already booked" }, 409);
  }

  let holdWasFresh = false;
  const calendarClaims: CalendarClaim[] = [];
  try {
    if (route.kind === "consult_1to1" && bookingId && slotStart !== null && slotEnd !== null) {
      for (const participant of [
        { userId: listing.creator_id, role: "creator" },
        { userId: auth.uid, role: "buyer" },
      ]) {
        const claimed = await claimCommercialBlock(env, {
          userId: participant.userId,
          sourceRef: `commercial:${bookingId}:${participant.role}`,
          start: slotStart,
          end: slotEnd,
          title: listing.title,
        });
        if (!claimed.ok) {
          for (const prior of calendarClaims) await releaseBlocks(env, "avaconsult", prior.sourceRef);
          const response = { error: "calendar conflict", conflictWith: claimed.conflict };
          await finishOperation(env, operationId, "failed", response);
          commercialEvent(env, "checkout_booking", auth.uid, { kind: route.kind, outcome: "refused", reason: "calendar_conflict" });
          return json(response, 409);
        }
        calendarClaims.push(claimed.claim);
      }
    }
    if (price > 0) {
      const held = await hold(env, auth.uid, orderId, price, {
        opId: `commercial:hold:${orderId}`,
        title: listing.title,
        app: route.kind === "live_event" ? "avalive" : "avaconsult",
      });
      if (!held.ok) {
        commercialEvent(env, "checkout_hold", auth.uid, { kind: route.kind, outcome: "refused", reason: held.status === 402 ? "insufficient_funds" : "wallet_failure" });
        for (const claim of calendarClaims) await releaseBlocks(env, "avaconsult", claim.sourceRef);
        const response = { error: held.status === 402 ? "insufficient_funds" : "payment_failed", needed: price };
        await finishOperation(env, operationId, "failed", response);
        return json(response, held.status === 402 ? 402 : 502);
      }
      holdWasFresh = held.body?.duplicate !== true;
      commercialEvent(env, "checkout_hold", auth.uid, { kind: route.kind, outcome: "authorized", duplicate: !holdWasFresh });
    } else {
      commercialEvent(env, "checkout_hold", auth.uid, { kind: route.kind, outcome: "free" });
    }

    const creatorFeePct = Math.trunc(Number(config.commercialCreatorFeePct));
    const settlementHoldHours = Math.trunc(Number(config.commercialSettlementHoldHours));
    if (!Number.isInteger(creatorFeePct) || creatorFeePct < 0 || creatorFeePct > 100
      || !Number.isInteger(settlementHoldHours) || settlementHoldHours < 0 || settlementHoldHours > 365 * 24) {
      throw new Error("commercial settlement configuration invalid");
    }
    const creatorAmount = Math.round(price * creatorFeePct / 100);
    const platformFeeAmount = price - creatorAmount;
    const policySnapshotId = `commercial-policy:${orderId}`;
    const policyJson = JSON.stringify(policy);
    const now = Date.now();
    await metaDb(env).batch([
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO orders
         (id,listing_id,buyer_id,creator_id,amount,status,created_at,updated_at,kind,fee_pct,escrow_account,booking_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8,?9,?10,?11)`,
      ).bind(orderId, listing.id, auth.uid, listing.creator_id, price, price > 0 ? "held" : "free", now,
        route.kind === "live_event" ? "live_event" : "consult_1to1", 100 - creatorFeePct, `escrow:${orderId}`, bookingId),
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_policy_snapshots
         (policy_snapshot_id,order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
          creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,
          conversion_snapshot_json,policy_version,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
      ).bind(policySnapshotId, orderId, listing.id, bookingId, auth.uid, listing.creator_id, route.kind, price,
        listing.currency_display ?? "USD", creatorFeePct, settlementHoldHours, platformFeeAmount, creatorAmount,
        policyJson, JSON.stringify({ request_sha256: requestHash, price_source: "listing.price" }),
        CHECKOUT_POLICY_VERSION, now),
    ]);

    const order = await metaDb(env).prepare(
      `SELECT id,listing_id,buyer_id,creator_id,amount,status,kind,fee_pct,escrow_account,booking_id
         FROM orders WHERE id=?1`,
    ).bind(orderId).first<OrderAuthority>();
    if (!order) throw new Error("order authority missing");
    if (order.id !== orderId || order.listing_id !== listing.id || order.buyer_id !== auth.uid
      || order.creator_id !== listing.creator_id || Number(order.amount) !== price
      || order.kind !== (route.kind === "live_event" ? "live_event" : "consult_1to1")
      || Number(order.fee_pct) !== 100 - creatorFeePct || order.escrow_account !== `escrow:${orderId}`
      || (order.booking_id ?? null) !== bookingId
      || order.status !== (price > 0 ? "held" : "free")) {
      throw new Error("order authority mismatch");
    }
    const conversionSnapshot = JSON.stringify({ request_sha256: requestHash, price_source: "listing.price" });
    const policyRow = await metaDb(env).prepare(
      `SELECT policy_snapshot_id,order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
          creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,
          conversion_snapshot_json,policy_version
         FROM commercial_policy_snapshots WHERE order_id=?1`,
    ).bind(orderId).first<PolicyAuthority>();
    if (!policyRow) throw new Error("policy snapshot missing");
    if (policyRow.policy_snapshot_id !== policySnapshotId || policyRow.order_id !== orderId
      || policyRow.listing_id !== listing.id || (policyRow.booking_id ?? null) !== bookingId
      || policyRow.buyer_id !== auth.uid || policyRow.creator_id !== listing.creator_id
      || policyRow.kind !== route.kind || Number(policyRow.gross_amount) !== price
      || policyRow.currency !== (listing.currency_display ?? "USD")
      || Number(policyRow.creator_fee_pct) !== creatorFeePct
      || Number(policyRow.settlement_hold_hours) !== settlementHoldHours
      || Number(policyRow.platform_fee_amount) !== platformFeeAmount
      || Number(policyRow.creator_amount) !== creatorAmount
      || policyRow.cancellation_policy_json !== policyJson
      || policyRow.conversion_snapshot_json !== conversionSnapshot
      || policyRow.policy_version !== CHECKOUT_POLICY_VERSION) {
      throw new Error("policy snapshot authority mismatch");
    }

    if (bookingId) {
      await metaDb(env).prepare(
        `INSERT OR IGNORE INTO bookings
         (id,creator_id,buyer_id,listing_id,kind,starts_at,ends_at,price,order_id,status,created_at,updated_at)
         SELECT ?1,?2,?3,?4,'consult_1to1',?5,?6,?7,?8,'confirmed',?9,?9
          WHERE NOT EXISTS (
            SELECT 1 FROM bookings WHERE creator_id=?2
              AND kind='consult_1to1' AND status IN ('confirmed','completed')
              AND starts_at < ?6 AND ends_at > ?5
          )`,
      ).bind(bookingId, listing.creator_id, auth.uid, listing.id, slotStart, slotEnd, price, orderId, now).run();
      const booking = await metaDb(env).prepare(
        "SELECT buyer_id,creator_id,listing_id,kind,starts_at,ends_at,price,order_id,status FROM bookings WHERE id=?1",
      ).bind(bookingId).first<{
        buyer_id: string; creator_id: string; listing_id: string; kind: string;
        starts_at: number; ends_at: number; price: number; order_id: string | null; status: string;
      }>();
      if (!booking) {
        const conflict = await metaDb(env).prepare(
          `SELECT id FROM bookings WHERE creator_id=?1 AND kind='consult_1to1'
             AND status IN ('confirmed','completed') AND starts_at < ?3 AND ends_at > ?2 LIMIT 1`,
        ).bind(listing.creator_id, slotStart, slotEnd).first<{ id: string }>();
        if (conflict) commercialEvent(env, "checkout_booking", auth.uid, { kind: route.kind, outcome: "refused", reason: "slot_already_booked" });
        throw new Error(conflict ? "consultation slot already booked" : "consultation booking missing");
      }
      if (booking.buyer_id !== auth.uid || booking.creator_id !== listing.creator_id
        || booking.listing_id !== listing.id || booking.kind !== "consult_1to1"
        || Number(booking.starts_at) !== slotStart || Number(booking.ends_at) !== slotEnd
        || Number(booking.price) !== price || booking.order_id !== orderId || booking.status !== "confirmed") {
        throw new Error("consultation booking authority mismatch");
      }
      await metaDb(env).batch([
        metaDb(env).prepare(
          `INSERT OR IGNORE INTO calendar_events
             (id,booking_id,slot_id,owner_uid,role,host_uid,attendee_uid,title,start_at,end_at,price_coins,paid,status,source,created_at)
           VALUES (?1,?2,?3,?4,'host',?5,?6,?7,?8,?9,?10,?11,'confirmed','commercial',?12)`,
        ).bind(`commercial-calendar-event:${bookingId}:creator`, bookingId, listing.id, listing.creator_id,
          listing.creator_id, auth.uid, listing.title, slotStart, slotEnd, price, price > 0 ? 1 : 0, now),
        metaDb(env).prepare(
          `INSERT OR IGNORE INTO calendar_events
             (id,booking_id,slot_id,owner_uid,role,host_uid,attendee_uid,title,start_at,end_at,price_coins,paid,status,source,created_at)
           VALUES (?1,?2,?3,?4,'attendee',?5,?6,?7,?8,?9,?10,?11,'confirmed','commercial',?12)`,
        ).bind(`commercial-calendar-event:${bookingId}:buyer`, bookingId, listing.id, auth.uid,
          listing.creator_id, auth.uid, listing.title, slotStart, slotEnd, price, price > 0 ? 1 : 0, now),
      ]);
      commercialEvent(env, "checkout_booking", auth.uid, { kind: route.kind, outcome: "authorized" });
    }

    const entitlementId = `commercial-entitlement:${orderId}`;
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_entitlements
       (entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
    ).bind(entitlementId, route.kind, listing.id, bookingId, orderId, auth.uid,
      route.kind === "live_event" ? "viewer" : "buyer", price > 0 ? "held" : "reserved",
      route.kind === "live_event" ? startsAt : slotStart, route.kind === "live_event" ? endsAt : slotEnd, now).run();
    const entitlement = await metaDb(env).prepare(
      `SELECT entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at
         FROM commercial_entitlements WHERE entitlement_id=?1`,
    ).bind(entitlementId).first<{
      entitlement_id: string; kind: CheckoutKind; listing_id: string; booking_id: string | null;
      order_id: string; account_id: string; role: string; state: string;
      starts_at: number | null; ends_at: number | null;
    }>();
    const expectedRole = route.kind === "live_event" ? "viewer" : "buyer";
    const expectedState = price > 0 ? "held" : "reserved";
    const expectedStart = route.kind === "live_event" ? startsAt : slotStart;
    const expectedEnd = route.kind === "live_event" ? endsAt : slotEnd;
    if (!entitlement) {
      const existingTicket = route.kind === "live_event"
        ? await metaDb(env).prepare(
          `SELECT entitlement_id FROM commercial_entitlements
             WHERE kind='live_event' AND listing_id=?1 AND account_id=?2
               AND role='viewer' AND booking_id IS NULL
               AND state IN ('reserved','held','active','consumed') LIMIT 1`,
        ).bind(listing.id, auth.uid).first<{ entitlement_id: string }>()
        : null;
      if (existingTicket) throw new Error("ticket already owned");
      throw new Error("entitlement missing");
    }
    if (route.kind === "live_event" && entitlement.order_id !== orderId
      && entitlement.listing_id === listing.id && entitlement.account_id === auth.uid
      && entitlement.role === "viewer" && entitlement.booking_id === null
      && ["reserved", "held", "active", "consumed"].includes(entitlement.state)) {
      throw new Error("ticket already owned");
    }
    if (entitlement.entitlement_id !== entitlementId || entitlement.kind !== route.kind
      || entitlement.listing_id !== listing.id || (entitlement.booking_id ?? null) !== bookingId
      || entitlement.order_id !== orderId || entitlement.account_id !== auth.uid
      || entitlement.role !== expectedRole || entitlement.state !== expectedState
      || Number(entitlement.starts_at) !== expectedStart || Number(entitlement.ends_at) !== expectedEnd) {
      throw new Error("entitlement authority mismatch");
    }
    const response = {
      ok: true,
      lane: "commercial",
      kind: route.kind,
      listing_id: listing.id,
      booking_id: bookingId,
      order_id: orderId,
      entitlement_id: entitlementId,
      policy_snapshot_id: policySnapshotId,
      gross_amount: price,
      currency: listing.currency_display ?? "USD",
      starts_at: route.kind === "live_event" ? startsAt : slotStart,
      ends_at: route.kind === "live_event" ? endsAt : slotEnd,
      access: "account_bound",
    };
    commercialEvent(env, "checkout", auth.uid, { kind: route.kind, outcome: "authorized" });
    // notifyUser is reached through the stable commercial notification helper.
    await notifyCommercialUsers(env, [listing.creator_id, auth.uid], {
      type: "commercial_checkout_confirmed",
      eventId: orderId,
      listingId: listing.id,
      bookingId,
      title: "Commercial booking confirmed",
      body: listing.title,
    });
    await finishOperation(env, operationId, "completed", response);
    return json(response, 200);
  } catch (error) {
    // A request can die after the WalletDO hold but before the entitlement
    // batch. On retry the hold is a duplicate, so use the durable entitlement
    // as the recovery boundary rather than the in-memory `holdWasFresh` bit.
    // Never refund an already-admitted account entitlement.
    const persistedEntitlement = await metaDb(env).prepare(
      `SELECT entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at
         FROM commercial_entitlements WHERE order_id=?1 AND account_id=?2 LIMIT 1`,
    ).bind(orderId, auth.uid).first<{
      entitlement_id: string; kind: CheckoutKind; listing_id: string; booking_id: string | null;
      order_id: string; account_id: string; role: string; state: string;
      starts_at: number | null; ends_at: number | null;
    }>();
    const expectedStart = route.kind === "live_event" ? startsAt : slotStart;
    const expectedEnd = route.kind === "live_event" ? endsAt : slotEnd;
    const validEntitlement = Boolean(persistedEntitlement
      && persistedEntitlement.kind === route.kind
      && persistedEntitlement.listing_id === listing.id
      && (persistedEntitlement.booking_id ?? null) === bookingId
      && persistedEntitlement.order_id === orderId
      && persistedEntitlement.account_id === auth.uid
      && persistedEntitlement.role === (route.kind === "live_event" ? "viewer" : "buyer")
      && ["reserved", "held", "active", "consumed"].includes(persistedEntitlement.state)
      && Number(persistedEntitlement.starts_at) === expectedStart
      && Number(persistedEntitlement.ends_at) === expectedEnd);
    const errorText = String(error);
    const collision = errorText.includes("authority mismatch");
    const slotConflict = errorText.includes("slot already booked");
    // The live-ticket partial unique index closes the NULL booking_id race.
    // A concurrent buyer can therefore collide before the entitlement readback;
    // translate that constraint into a deterministic account-bound refusal, not
    // a generic retry that could leave the caller guessing about ownership.
    const ticketRace = errorText.includes("ticket already owned");
    commercialEvent(env, "checkout", auth.uid, {
      kind: route.kind, outcome: ticketRace || slotConflict || collision ? "refused" : "retryable",
      reason: ticketRace ? "ticket_already_owned" : slotConflict ? "slot_already_booked" : collision ? "authority_mismatch" : "transient_failure",
    });
    if (validEntitlement) {
      return collision
        ? json({ error: "checkout authority mismatch" }, 409)
        : json({ error: "commercial checkout retryable", retryable: true }, 503);
    }
    // A transient failure after order/policy/booking writes but before the
    // entitlement is durable remains resumable. Do not mark the operation
    // failed or refund a hold that a retry can safely complete.
    if (!validEntitlement && !collision && !slotConflict && !ticketRace
      && !errorText.includes("configuration invalid")) {
      return json({ error: "commercial checkout retryable", retryable: true }, 503);
    }
    if (!validEntitlement) {
      for (const claim of calendarClaims) await releaseBlocks(env, "avaconsult", claim.sourceRef);
    }
    if (!validEntitlement && price > 0) {
      try { await refund(env, orderId, auth.uid, price, { opId: `commercial:checkout-failure:${orderId}`, reason: "commercial checkout failed", title: listing.title }); } catch { /* review via ledger */ }
    }
    if (!validEntitlement && (holdWasFresh || price === 0 || collision || slotConflict || ticketRace)) {
      await metaDb(env).batch([
        metaDb(env).prepare(
          "UPDATE orders SET status='refunded',updated_at=?2 WHERE id=?1 AND status IN ('held','free')",
        ).bind(orderId, Date.now()),
        metaDb(env).prepare(
          "UPDATE commercial_entitlements SET state='refunded',updated_at=?2 WHERE order_id=?1 AND account_id=?3",
        ).bind(orderId, Date.now(), auth.uid),
      ]);
    }
    const message = ticketRace
      ? "ticket already owned"
      : slotConflict ? "consultation slot already booked" : "commercial checkout unavailable";
    const response = { error: message };
    await finishOperation(env, operationId, "failed", response);
    return json(response, ticketRace || slotConflict ? 409 : 503);
  }
}
