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
import { hold, refund, holdExternal, refundExternal } from "../ledger";
import { json } from "../util";
import { commercialEvent } from "../lib/commercial_telemetry";
import { commercialLaneState, commercialLaneFlags, type CommercialLaneState } from "../lib/commercial_lane";
import { taxFor, type TaxBreakdown } from "../lib/commercial_tax";
import { claimBlock, releaseBlocks } from "../cal/engine";
import { notifyCommercialUsers } from "../lib/commercial_notifications";
import type { GatewayId } from "../lib/payments/types";

type CheckoutKind = "live_event" | "consult_1to1";

// [PAY-RAIL-2] The site currency is the rupee (CLAUDE.md, spec §1) and `currency_display`
// is a genuinely multi-currency field a LISTING can set — this constant is only the
// FALLBACK for a listing that never set one. It was hardcoded "USD" in three places below;
// changing the fallback here changes all three at once and keeps them from drifting apart
// again. Existing rows that already stored "USD" from before this change are untouched —
// this only affects what a NEW listing with no currency_display gets from now on.
const DEFAULT_CURRENCY = "INR";

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
  // [COMM-REFUND-POL-1] Read by cancellationDecision() in commercial_lifecycle.ts. Their
  // absence from the snapshot is what sent every creator cancel, creator no-show,
  // provider outage and late buyer cancel to review_pending.
  creator_cancel_refund_pct: number;
  provider_failure_refund_pct: number;
  late_cancel_refund_pct: number;
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

/**
 * [COMM-REFUND-POL-1] The three refund percentages, validated as integers 0..100.
 *
 * Returns null on ANY bad value so the caller refuses the checkout rather than
 * snapshotting a NaN. A snapshot is immutable and settles a real order months later —
 * writing garbage into one is not a thing to recover from gracefully at settlement time,
 * where the only available answer is review_pending.
 */
function refundPercents(config: PlatformConfig): Pick<
  CheckoutPolicy, "creator_cancel_refund_pct" | "provider_failure_refund_pct" | "late_cancel_refund_pct"
> | null {
  const creator = Math.trunc(Number(config.commercialCreatorCancelRefundPct));
  const provider = Math.trunc(Number(config.commercialProviderFailureRefundPct));
  const late = Math.trunc(Number(config.commercialLateCancelRefundPct));
  for (const v of [creator, provider, late]) {
    if (!Number.isInteger(v) || v < 0 || v > 100) return null;
  }
  return {
    creator_cancel_refund_pct: creator,
    provider_failure_refund_pct: provider,
    late_cancel_refund_pct: late,
  };
}

function policyFor(kind: CheckoutKind, attrs: Record<string, unknown>, config: PlatformConfig): CheckoutPolicy | null {
  const pct = refundPercents(config);
  if (!pct) return null;
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
      ...pct,
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
    ...pct,
  };
}

// [COMM-FLAG-UNIFY-1] Same predicate as the legacy fence in listings.ts. This used to
// read ONLY commercial*CheckoutEnabled while that fence read ONLY commercial*ListingsEnabled,
// so a half-flip opened both lanes on one listing — two holds, two escrow buckets, two
// refund paths, one seat. `mixed` refuses here too rather than quietly behaving like off.
// `configAllows` is gone: a boolean cannot express `mixed`, and collapsing the
// misconfiguration into `false` is exactly the silence that let the double-charge window
// exist. Callers switch on the three states.
function laneState(kind: CheckoutKind, config: PlatformConfig): CommercialLaneState {
  return commercialLaneState(config, kind);
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
  // [COMM-FLAG-UNIFY-1] `mixed` is reported separately from `off`. Both refuse, but only
  // one is an operator error, and a half-configured money lane must be loud — the whole
  // reason this bug survived is that nothing anywhere said the four flags disagreed.
  const lane = laneState(route.kind, config);
  if (lane === "mixed") {
    commercialEvent(env, "checkout", auth.uid, {
      kind: route.kind, outcome: "refused", reason: "lane_misconfigured",
      ...commercialLaneFlags(config, route.kind),
    });
    return json({ error: "commercial checkout unavailable", reason: "lane_misconfigured" }, 503);
  }
  if (lane !== "on") {
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

  const policy = policyFor(route.kind, parseAttrs(listing.attrs), config);
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

  // [TAX-GST-1 fix] Computed OUT here, not inside the try, because the failure path in
  // the catch has to refund exactly what was charged. It previously refunded `price`
  // while the hold took `tax.buyerTotal` — so with GST switched on, an aborted checkout
  // would have returned the base and quietly kept the tax. Caught by reading the catch
  // block; `gstEnabled` is false in production, so it never reached a real buyer.
  const tax = taxFor(config, price);
  if (!tax) return json({ error: "commercial tax configuration invalid" }, 503);

  return await provisionCommercialPurchase(env, {
    auth, route, listing, config, policy, price, tax, startsAt, endsAt,
    slotStart, slotEnd, orderId, operationId, bookingId, requestHash,
    funding: {
      rail: "wallet",
      // The original behaviour, unchanged: debit the buyer's WalletDO balance.
      async fund(amount) {
        const r = await hold(env, auth.uid, orderId, amount, {
          opId: `commercial:hold:${orderId}`,
          title: listing.title,
          app: route.kind === "live_event" ? "avalive" : "avaconsult",
        });
        return { ok: r.ok, status: r.status, duplicate: r.body?.duplicate === true };
      },
      async reverse(amount) {
        await refund(env, orderId, auth.uid, amount, {
          opId: `commercial:checkout-failure:${orderId}`,
          reason: "commercial checkout failed",
          title: listing.title,
        });
      },
    },
  });
}

/** [PAY-HANDOFF-1] How a purchase is funded. The only thing that differs between the
 *  wallet lane and the gateway lane.
 *  [PAY-RAIL-2] `rail` is widened from the original `"wallet" | "cashfree"` to every
 *  known gateway id, so a Razorpay/Paytm/Stripe purchase is ledgered and receipted under
 *  its OWN name instead of being mislabeled "cashfree". See provisionFromGatewayPurchase
 *  below and lib/commercial_refund_rail.ts, which reads this label back to pick the
 *  refund adapter. */
export type PurchaseFunding = {
  rail: "wallet" | GatewayId;
  /** Move `amount` into escrow:<orderId>. `duplicate` means it was already there. */
  fund(amount: number): Promise<{ ok: boolean; status: number; duplicate: boolean }>;
  /** Take `amount` back out of escrow when provisioning fails after funding. */
  reverse(amount: number): Promise<void>;
};

/**
 * [PAY-HANDOFF-1] Everything that turns MONEY IN ESCROW into A TICKET: the order row,
 * the immutable policy snapshot, the consult booking and calendar events, and both
 * entitlements — each one written, then read back and verified before the next.
 *
 * WHY IT IS ITS OWN FUNCTION. Cashfree needed the same steps, and the alternative was a
 * second copy of ~370 lines of money code. Two copies of a settlement path do not stay
 * identical; they drift, and the drift shows up as a buyer who paid and cannot get in.
 * The same argument is written into commercial_admin_claims.ts for why the admin route
 * hands work back to the cron instead of re-implementing the split.
 *
 * HOW IT WAS EXTRACTED, because it matters. The body was MOVED VERBATIM out of
 * commercialCheckout and the parameter object destructures to the SAME identifier names
 * it already used, so not one variable was renamed. The failure this avoids is swapping
 * a buyer uid for a creator uid — same type, invisible to tsc, and it sends money to the
 * wrong person. Only two things changed: the funding call and its reversal, which are
 * the only real difference between the rails.
 *
 * THROWS NOTHING. Every path returns a Response; the catch is part of the moved body and
 * owns the recovery decision (when to refund, when a retry is still safe, when a
 * concurrent buyer won the ticket).
 */
export async function provisionCommercialPurchase(env: Env, ctx: {
  auth: { uid: string };
  route: { kind: CheckoutKind };
  listing: Listing;
  config: PlatformConfig;
  policy: CheckoutPolicy;
  price: number;
  tax: TaxBreakdown;
  startsAt: number | null;
  endsAt: number | null;
  slotStart: number | null;
  slotEnd: number | null;
  orderId: string;
  operationId: string;
  bookingId: string | null;
  requestHash: string;
  funding: PurchaseFunding;
}): Promise<Response> {
  const {
    auth, route, listing, config, policy, price, tax, startsAt, endsAt,
    slotStart, slotEnd, orderId, operationId, bookingId, requestHash, funding,
  } = ctx;
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
    // [TAX-GST-1] The buyer is charged base + tax in ONE debit, and the whole amount sits
    // in escrow. Two separate debits (one to escrow, one to platform:tax) would leave a
    // window where the base is held and the tax is not, and would put two lines on the
    // buyer's statement for one purchase. Settlement pays the tax leg out of escrow to
    // 'platform:tax' before splitting, and a refund returns everything the buyer paid
    // because everything the buyer paid is in one place.
    if (tax.buyerTotal > 0) {
      // [PAY-HANDOFF-1] The ONLY difference between the two purchase rails. The wallet
      // lane debits the buyer's balance; the Cashfree lane credits escrow from money
      // already taken at the gateway. Everything else below is identical, which is the
      // whole reason this function exists rather than a second copy of it.
      const held = await funding.fund(tax.buyerTotal);
      if (!held.ok) {
        commercialEvent(env, "checkout_hold", auth.uid, { kind: route.kind, outcome: "refused", reason: held.status === 402 ? "insufficient_funds" : "wallet_failure", rail: funding.rail });
        for (const claim of calendarClaims) await releaseBlocks(env, "avaconsult", claim.sourceRef);
        const response = { error: held.status === 402 ? "insufficient_funds" : "payment_failed", needed: tax.buyerTotal };
        await finishOperation(env, operationId, "failed", response);
        return json(response, held.status === 402 ? 402 : 502);
      }
      holdWasFresh = held.duplicate !== true;
      commercialEvent(env, "checkout_hold", auth.uid, { kind: route.kind, outcome: "authorized", duplicate: !holdWasFresh, rail: funding.rail });
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
          conversion_snapshot_json,policy_version,created_at,gst_rate_pct,gst_amount,taxable_base)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
      ).bind(policySnapshotId, orderId, listing.id, bookingId, auth.uid, listing.creator_id, route.kind, price,
        listing.currency_display ?? DEFAULT_CURRENCY, creatorFeePct, settlementHoldHours, platformFeeAmount, creatorAmount,
        policyJson, JSON.stringify({ request_sha256: requestHash, price_source: "listing.price" }),
        CHECKOUT_POLICY_VERSION, now, tax.gstRatePct, tax.gstAmount, tax.taxableBase),
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
      || policyRow.currency !== (listing.currency_display ?? DEFAULT_CURRENCY)
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

    // [COMM-CONSULT-ENT-1] The consult creator's own admission.
    //
    // commercialConsultJoin (commercial_stream_sessions.ts) requires the creator to hold
    // an entitlement with role='creator'. Before this, NOTHING in the repo ever wrote one
    // — checkout wrote the buyer's row and live_event hosts self-granted 'host', and that
    // was the entire set. So every paid consult 403'd the expert out of their own
    // session, produced zero creator×buyer overlap, failed the two-party delivery check
    // in commercial_settlement.ts, and parked the buyer's money in review_pending. The
    // product could not run, once, ever.
    //
    // Written HERE and not lazily at join time, deliberately. The live_event host
    // self-grant is what makes [COMM-LIVE-AUTH-1] possible (a NULL order_id landing on a
    // shared session row), and — more importantly — the refund and lifecycle paths sweep
    // commercial_entitlements BY order_id (commercial_lifecycle.ts:245-268). A row that
    // exists only after someone joins is a row those sweeps can miss.
    //
    // Idempotent for the same reason the buyer row is: INSERT OR IGNORE against
    // UNIQUE(kind, listing_id, booking_id, account_id, role).
    const creatorEntitlementId = `${entitlementId}:creator`;
    if (route.kind === "consult_1to1") {
      await metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_entitlements
         (entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'creator',?7,?8,?9,?10,?10)`,
      ).bind(creatorEntitlementId, route.kind, listing.id, bookingId, orderId, listing.creator_id,
        price > 0 ? "held" : "reserved", slotStart, slotEnd, now).run();
    }
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
    // [COMM-CONSULT-ENT-1] Read the creator row back and hold it to the same standard as
    // the buyer's. A consult authorized with only half its entitlements is exactly the
    // failure this issue exists to remove, so a partial write must abort the checkout
    // rather than return ok:true and fail invisibly at join time an hour later.
    if (route.kind === "consult_1to1") {
      const creatorGrant = await metaDb(env).prepare(
        `SELECT entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at
           FROM commercial_entitlements WHERE entitlement_id=?1`,
      ).bind(creatorEntitlementId).first<{
        entitlement_id: string; kind: CheckoutKind; listing_id: string; booking_id: string | null;
        order_id: string; account_id: string; role: string; state: string;
        starts_at: number | null; ends_at: number | null;
      }>();
      if (!creatorGrant) throw new Error("creator entitlement missing");
      if (creatorGrant.kind !== route.kind || creatorGrant.listing_id !== listing.id
        || (creatorGrant.booking_id ?? null) !== bookingId || creatorGrant.order_id !== orderId
        || creatorGrant.account_id !== listing.creator_id || creatorGrant.role !== "creator"
        || creatorGrant.state !== expectedState
        || Number(creatorGrant.starts_at) !== slotStart || Number(creatorGrant.ends_at) !== slotEnd) {
        throw new Error("creator entitlement authority mismatch");
      }
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
      // [TAX-GST-1] gross_amount stays the SPLITTABLE base (what the 80/20 runs on).
      // The buyer's actual charge is charged_amount. Keeping gross_amount meaning the
      // same thing it always meant is why no settlement reader had to change its
      // interpretation of it.
      gross_amount: price,
      taxable_base: tax.taxableBase,
      gst_rate_pct: tax.gstRatePct,
      gst_amount: tax.gstAmount,
      charged_amount: tax.buyerTotal,
      currency: listing.currency_display ?? DEFAULT_CURRENCY,
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
    // [TAX-GST-1 fix] tax.buyerTotal, NOT price. The hold took base + tax in one debit,
    // so an aborted checkout must give back base + tax. Refunding `price` here left the
    // GST sitting in escrow on a purchase that never happened — money owed to a tax
    // authority for a supply that did not occur, and the buyer short by the tax.
    // [PAY-HANDOFF-1] Reverse on the SAME rail the money arrived on. Refunding a
    // gateway-funded purchase into a wallet the buyer never funded would invent a
    // balance out of nothing and leave the escrow leg unbalanced.
    if (!validEntitlement && tax.buyerTotal > 0) {
      try { await funding.reverse(tax.buyerTotal); } catch { /* review via ledger */ }
    }
    if (!validEntitlement && (holdWasFresh || tax.buyerTotal === 0 || collision || slotConflict || ticketRace)) {
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

/**
 * [PAY-HANDOFF-1] The gateway lane's entry into the shared provisioning path.
 *
 * Called from a gateway webhook AFTER the payment is verified against the gateway.
 * Re-derives everything from the LISTING — policy, schedule, tax — rather than trusting
 * anything carried on the purchase row, so a listing that changed between order creation
 * and payment cannot provision a ticket on stale terms. The one thing it does trust is
 * `chargedTokens`, because that is what the buyer actually paid; if it disagrees with
 * what the listing now costs, the purchase is refused rather than silently reconciled.
 *
 * `funding.fund` is holdExternal — money already taken at the gateway, credited into the
 * same escrow bucket the wallet lane uses, so release/split/settlement/refund all run
 * unchanged. `funding.reverse` is refundExternal, which records the money going back OUT
 * to the gateway; the actual reversal to the payer's source (UPI/card/wallet) is the
 * caller's job.
 *
 * [PAY-RAIL-2] `args.gateway` names WHICH gateway actually settled the payment.
 * It defaults to `"cashfree"` — the ORIGINAL, hardcoded behaviour — so this function is
 * BYTE-IDENTICAL for every caller that omits it (today: routes/cashfree.ts, and any other
 * caller written before this change). Only routes/pay.ts's generic webhook passes it
 * explicitly, one per adapter. Before this fix, EVERY caller was forced into the literal
 * strings `cashfree-order:…` / rail `"cashfree"` / ledger source `"cashfree"` regardless
 * of which gateway actually took the money — so a Razorpay- or Paytm-funded purchase was
 * ledgered, receipted, and (see lib/commercial_refund_rail.ts) refunded as if it were a
 * Cashfree charge. Generalising the prefix/rail/source to the real gateway id is the whole
 * fix; nothing else about the shape changes, and no already-settled Cashfree row is
 * touched or reinterpreted — they keep the exact `cashfree-order:` prefix and `"cashfree"`
 * rail they were written with, because `gateway` defaults to `"cashfree"` for them too.
 */
export async function provisionFromGatewayPurchase(env: Env, args: {
  uid: string;
  listingId: string;
  bookingId: string | null;
  kind: CheckoutKind;
  chargedTokens: number;
  purchaseId: string;
  gatewayRef: string;
  slot?: { start_at: number; end_at: number } | null;
  gateway?: GatewayId;
}): Promise<Response> {
  const gateway: GatewayId = args.gateway ?? "cashfree";
  const config = await readConfig(env);
  const listing = await metaDb(env).prepare(
    `SELECT id,creator_id,kind,title,status,price,currency_display,starts_at,duration_min,capacity,attrs
       FROM listings WHERE id=?1`,
  ).bind(args.listingId).first<Listing>();
  if (!listing) return json({ error: "listing unavailable" }, 404);
  if (listing.creator_id === args.uid) return json({ error: "cannot buy your own service" }, 400);

  const policy = policyFor(args.kind, parseAttrs(listing.attrs), config);
  if (!policy) return json({ error: "commercial policy unavailable" }, 409);
  const price = Math.trunc(Number(listing.price));
  if (!Number.isSafeInteger(price) || price < 0) return json({ error: "invalid commercial price" }, 409);
  const tax = taxFor(config, price);
  if (!tax) return json({ error: "commercial tax configuration invalid" }, 503);
  // The buyer paid a specific number. If the listing no longer agrees, do NOT provision:
  // an under-charge silently gifts the difference and an over-charge silently keeps it.
  if (tax.buyerTotal !== Math.trunc(args.chargedTokens)) {
    return json({ error: "price changed since payment", charged: args.chargedTokens, now: tax.buyerTotal }, 409);
  }

  const startsAt = args.kind === "live_event" ? Math.trunc(Number(listing.starts_at)) : null;
  const endsAt = args.kind === "live_event" && startsAt !== null
    ? startsAt + Math.max(1, Math.trunc(Number(listing.duration_min ?? 60))) * 60_000
    : null;
  if (args.kind === "live_event"
    && (startsAt === null || endsAt === null || !Number.isSafeInteger(startsAt) || startsAt <= 0 || endsAt <= startsAt)) {
    return json({ error: "event schedule unavailable" }, 409);
  }
  const slotStart = args.kind === "consult_1to1" ? Math.trunc(Number(args.slot?.start_at)) : null;
  const slotEnd = args.kind === "consult_1to1" ? Math.trunc(Number(args.slot?.end_at)) : null;
  if (args.kind === "consult_1to1"
    && (slotStart === null || slotEnd === null || !Number.isSafeInteger(slotStart)
      || !Number.isSafeInteger(slotEnd) || slotEnd <= slotStart)) {
    return json({ error: "consultation slot required" }, 400);
  }

  // Derived from the purchase, so a webhook redelivery lands on the same ids and the
  // whole path is idempotent exactly as the wallet lane's is. Prefixed with the ACTUAL
  // gateway (defaults to "cashfree", see this function's header) so the commercial order,
  // the checkout operation and the ledger source all carry the true rail — this is what
  // lets commercial_refund_rail.ts find a Razorpay/Paytm/Stripe purchase and reverse it on
  // the right adapter instead of falling through to a wallet credit.
  const orderId = `${gateway}-order:${args.purchaseId}`;
  const operationId = `commercial-checkout:${gateway}:${args.purchaseId}`;
  const requestHash = await sha256Hex(`${gateway}:${args.purchaseId}:${args.gatewayRef}`);
  if (!await assertCheckoutSchema(env)) return json({ error: "commercial checkout unavailable" }, 503);
  // finishOperation() UPDATEs this row; without it the outcome would be recorded nowhere.
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_checkout_operations
       (operation_id,account_id,kind,listing_id,request_sha256,order_id,state,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'started',?7,?7)`,
  ).bind(operationId, args.uid, args.kind, listing.id, requestHash, orderId, Date.now()).run();

  return await provisionCommercialPurchase(env, {
    auth: { uid: args.uid },
    route: { kind: args.kind },
    listing, config, policy, price, tax,
    startsAt, endsAt, slotStart, slotEnd,
    orderId, operationId,
    bookingId: args.bookingId,
    requestHash,
    funding: {
      rail: gateway,
      async fund(amount) {
        const r = await holdExternal(env, orderId, amount, {
          opId: `${gateway}:hold:${args.gatewayRef}`,
          uid: args.uid,
          source: gateway,
          ref: args.gatewayRef,
          title: listing.title,
        });
        // holdExternal is a queued ledger row, idempotent on opId at the consumer, so it
        // has no "already existed" signal to report. `false` is the safe answer: it only
        // widens the failure path's cleanup, never narrows it.
        return { ok: r.ok, status: r.status, duplicate: false };
      },
      async reverse(amount) {
        await refundExternal(env, orderId, amount, {
          opId: `${gateway}:reverse:${args.gatewayRef}`,
          uid: args.uid,
          source: gateway,
          reason: "commercial provisioning failed",
          ref: args.gatewayRef,
        });
      },
    },
  });
}
