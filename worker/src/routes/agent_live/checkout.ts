// [AGENT-LIVE-1] Quote + book + cancel + booking reads (BUILD SPEC §3, §11
// M2/M4/M6/M9/M12; R2 §2.2-2.4). Exports the dispatcher-facing handlers named
// in routes/agent_live/index.ts.
import type { Env } from "../../types";
import { json, sha256Hex } from "../../util";
import { requireUser, isFail } from "../../authz";
import { metaDb } from "../../db/shard";
import { hold, clerkEmail } from "../../ledger";
import { readConfig } from "../config";
import { laneGate, slotMinutesFrom, adminUid } from "../../lib/agent_live/gate";
import { seatAuthority, type SeatConfirmResult } from "../../lib/agent_live/seats";
import { decideAndEnqueue, finalizeBookedBooking, callRoom } from "../../lib/agent_live/money";
import { track, trackUser } from "../../hooks";
import {
  type AgentLiveHandler,
  type AgentQuote,
  type AgentLiveAgentRow,
  type AgentLiveBookingRow,
  type DecisionOutcome,
  AGENT_LIVE_POLICY_VERSION,
  PLATFORM_FEE_BPS,
  SLOT_GRID_MS,
  agentOrderId,
  holdOpId,
} from "../../lib/agent_live/types";

const QUOTE_VALIDITY_MS = 2 * 60_000;
const MIN_LEAD_MS = 2 * 60_000; // scheduled start must be >= now + 2 min
const CANCEL_EARLY_CUTOFF_MS = 10 * 60_000; // D7: >=10 min before start = full refund

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic field order — NEVER `JSON.stringify(untrustedObject)`, so a
 * client cannot forge a signature by reordering keys or adding extras. */
function canonicalQuote(q: AgentQuote): string {
  return JSON.stringify({
    quoteId: q.quoteId, buyerUid: q.buyerUid, agentId: q.agentId, minutes: q.minutes,
    instant: q.instant, scheduledStartMs: q.scheduledStartMs, pricePerMin: q.pricePerMin,
    amount: q.amount, beneficiaryUid: q.beneficiaryUid, feeBps: q.feeBps,
    personaVersion: q.personaVersion, policyVersion: q.policyVersion, expiresAt: q.expiresAt,
  });
}

async function signQuote(env: Env, q: AgentQuote): Promise<string> {
  // laneGate() is always checked before this is called, so JOIN_LINK_SECRET
  // is guaranteed present (D12) — no dev fallback for money-moving signatures.
  return hmacHex(env.JOIN_LINK_SECRET as string, canonicalQuote(q));
}

interface LoadedAgent extends AgentLiveAgentRow { title: string; }

async function loadAgent(env: Env, agentId: string): Promise<LoadedAgent | null> {
  const row = await metaDb(env).prepare(
    `SELECT a.*, l.title AS listing_title, l.status AS listing_status, l.kind AS listing_kind
       FROM agent_live_agents a JOIN listings l ON l.id = a.listing_id
      WHERE a.listing_id=?1`,
  ).bind(agentId).first<any>();
  if (!row) return null;
  if (row.listing_kind !== "agent" || row.listing_status !== "published") return null;
  const { listing_title, listing_status, listing_kind, ...rest } = row;
  return { ...(rest as AgentLiveAgentRow), title: String(listing_title ?? agentId) };
}

async function loadBooking(env: Env, bookingId: string): Promise<AgentLiveBookingRow | null> {
  return metaDb(env).prepare(`SELECT * FROM agent_live_bookings WHERE id=?1`).bind(bookingId).first<AgentLiveBookingRow>();
}

function parseCsvMinutes(csv: string): number[] {
  return csv.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

function allowedMinutesFor(agent: LoadedAgent, cfg: Awaited<ReturnType<typeof readConfig>>): number[] {
  const agentSet = new Set(parseCsvMinutes(agent.slot_minutes));
  return slotMinutesFrom(cfg).filter((m) => agentSet.has(m));
}

/** Self-declared `users.birth_year`-based minor gate, mirroring the identical
 * pattern already used at `routes/ava_guardian.ts` isMinorAccount(),
 * `routes/call_billing_routes.ts` isChildAccount() and
 * `routes/agent_profiles.ts`: no declared year -> fail OPEN to adult (never
 * traps an adult), a KNOWN birth year under 18 blocks. There is no dedicated
 * `is_adult`/"adult-verified" flag anywhere in the codebase to require
 * instead (grepped `adults_only`/`is_adult` across routes/*.ts) — this is the
 * closest existing signal and is called out as a deviation in the workstream
 * report.
 */
async function isMinorBuyer(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await metaDb(env).prepare("SELECT birth_year FROM users WHERE uid=?1").bind(uid).first<{ birth_year: number | null }>();
    const by = r?.birth_year ?? null;
    if (!by) return false;
    return new Date().getFullYear() - by < 18;
  } catch { return false; }
}

function toPublicBooking(b: AgentLiveBookingRow): Record<string, unknown> {
  return {
    bookingId: b.id, agentId: b.agent_id, status: b.status, moneyState: b.money_state,
    startsAt: b.starts_at, endsAt: b.ends_at, minutes: b.minutes, amount: b.amount,
    instant: !!b.instant, talkPath: `/talk/${b.id}`, createdAt: b.created_at,
  };
}

// ---------------------------------------------------------------------------
// GET/POST .../quote
// ---------------------------------------------------------------------------

export const agentQuote: AgentLiveHandler = async (req, env, _ctx, params) => {
  const agentId = params.id;
  const cfg = await readConfig(env);
  const gate = laneGate(env, cfg);
  if (!gate.ok) return json({ error: "agent_live_unavailable", reason: gate.reason }, 503);

  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const buyerUid = authCtx.uid;

  const body = (await req.json().catch(() => ({}))) as any;
  const minutes = Math.trunc(Number(body.minutes));
  const instant = !!body.instant;
  const tz = typeof body.tz === "string" && body.tz ? body.tz : "UTC";

  const agent = await loadAgent(env, agentId);
  if (!agent) return json({ error: "agent_not_found" }, 404);

  const allowed = allowedMinutesFor(agent, cfg);
  if (!allowed.includes(minutes)) {
    track(env, buyerUid, "agent_quote", "agent_live", { outcome: "rejected", reason: "bad_minutes" });
    return json({ error: "invalid_minutes", allowed }, 400);
  }

  if (agent.adults_only && (await isMinorBuyer(env, buyerUid))) {
    track(env, buyerUid, "agent_quote", "agent_live", { outcome: "rejected", reason: "adults_only" });
    return json({ error: "adults_only" }, 403);
  }

  const now = Date.now();
  let startsAt: number;
  if (instant) {
    startsAt = now;
  } else {
    const raw = Math.trunc(Number(body.startsAt));
    if (!Number.isFinite(raw) || raw <= 0) {
      return json({ error: "startsAt required for a scheduled booking" }, 400);
    }
    if (raw % SLOT_GRID_MS !== 0) return json({ error: "startsAt must land on the 5-minute grid" }, 400);
    if (raw < now + MIN_LEAD_MS) return json({ error: "startsAt too soon" }, 400);
    startsAt = raw;
  }
  const endsAt = startsAt + minutes * 60_000;
  const amount = minutes * agent.price_per_min;
  const beneficiaryUid = adminUid(env);
  if (!beneficiaryUid) return json({ error: "agent_live_unavailable", reason: "agent_admin_unconfigured" }, 503);

  const quote: AgentQuote = {
    quoteId: crypto.randomUUID(),
    buyerUid, agentId, minutes, instant,
    scheduledStartMs: instant ? null : startsAt,
    pricePerMin: agent.price_per_min, amount, beneficiaryUid,
    feeBps: PLATFORM_FEE_BPS as 2000,
    personaVersion: agent.persona_version,
    policyVersion: AGENT_LIVE_POLICY_VERSION,
    expiresAt: now + QUOTE_VALIDITY_MS,
  };
  const sig = await signQuote(env, quote);

  const buyerEmail = await clerkEmail(env, buyerUid).catch(() => null);
  trackUser(env, buyerUid, buyerEmail, "agent_quote", "agent_live", { outcome: "ok", minutes, instant });

  return json({
    ...quote, sig, tz,
    provisionalStartsAt: startsAt, provisionalEndsAt: endsAt,
    agentTitle: agent.title,
  });
};

// ---------------------------------------------------------------------------
// POST .../book
// ---------------------------------------------------------------------------

export const agentBook: AgentLiveHandler = async (req, env, _ctx, params) => {
  const agentId = params.id;
  const cfg = await readConfig(env);
  const gate = laneGate(env, cfg);
  if (!gate.ok) return json({ error: "agent_live_unavailable", reason: gate.reason }, 503);

  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const buyerUid = authCtx.uid;

  const body = (await req.json().catch(() => ({}))) as any;
  const quote = body.quote as (AgentQuote & { sig?: string }) | undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!quote || !quote.sig) return json({ error: "quote required" }, 400);
  if (!idempotencyKey) return json({ error: "idempotencyKey required" }, 400);
  if (quote.agentId !== agentId || quote.buyerUid !== buyerUid) return json({ error: "quote mismatch" }, 400);

  const requestHash = await sha256Hex(canonicalQuote(quote));
  const db = metaDb(env);

  // F19: resolve (buyer_uid, idempotency_key) BEFORE any expiry/signature
  // check. A client that retries a call whose response it never saw (e.g.
  // after 2 min, well past QUOTE_VALIDITY_MS) must replay the ALREADY-BOOKED
  // result rather than bounce off `quote_expired` — the booking succeeded;
  // only the response was lost. Idempotency (BUILD SPEC §3): same
  // buyer+key+hash -> replay; same key, different hash -> 409 conflict.
  const existing = await db.prepare(
    `SELECT * FROM agent_live_bookings WHERE buyer_uid=?1 AND idempotency_key=?2`,
  ).bind(buyerUid, idempotencyKey).first<AgentLiveBookingRow>();
  if (existing) {
    if (existing.request_hash !== requestHash) return json({ error: "idempotency_conflict" }, 409);
    if (existing.status === "booked" || existing.status === "in_progress" || existing.status === "completed") {
      return json({ bookingId: existing.id, startsAt: existing.starts_at, endsAt: existing.ends_at, talkPath: `/talk/${existing.id}` });
    }
    if (existing.status === "failed" || existing.status === "cancelled") {
      return json({ error: "insufficient_tokens", error_legacy: "insufficient_avacoins" }, 402);
    }
    // Still mid-flight (pending) — the sweep or a concurrent request owns it.
    return json({ bookingId: existing.id, status: existing.status, pending: true }, 202);
  }

  // No existing row for this (buyer, key) — this is a genuinely NEW checkout
  // attempt, so the quote must still be fresh and correctly signed.
  if (Date.now() > quote.expiresAt) return json({ error: "quote_expired" }, 410);
  const expectedSig = await signQuote(env, quote);
  if (expectedSig !== quote.sig) return json({ error: "invalid_quote_signature" }, 400);

  const agent = await loadAgent(env, agentId);
  if (!agent) return json({ error: "agent_not_found" }, 404);

  const bookingId = crypto.randomUUID();
  const orderId = agentOrderId(bookingId);
  const now = Date.now();
  const buyerEmail = await clerkEmail(env, buyerUid).catch(() => null);

  // Seat reservation FIRST (M2/M5) — never persist a checkout row for a seat
  // we could not even provisionally hold.
  const provisionalStart = quote.instant ? now : (quote.scheduledStartMs ?? now);
  const reservation = await seatAuthority(env).reserveProvisional({
    bookingId, agentId, buyerUid, requestHash,
    startMs: provisionalStart, endMs: provisionalStart + quote.minutes * 60_000,
    agentCap: agent.max_concurrent, platformCap: cfg.agentPlatformMaxConcurrent,
    revision: agent.persona_version,
  });
  if (!reservation.ok) {
    track(env, buyerUid, "agent_seat_unavailable", "agent_live", {
      next_free_in_s: reservation.nextFreeAt ? Math.max(0, Math.round((reservation.nextFreeAt - now) / 1000)) : null,
    });
    return json({ error: "seat_taken", next_free_at: reservation.nextFreeAt ?? null }, 409);
  }
  const seatToken = reservation.token;
  const startMs = reservation.startMs;
  const endMs = reservation.endMs;

  // Stashed alongside the quote — `confirm()` needs this exact token, and a
  // crashed checkout recovered by `runAgentLiveSweeps` (M2) has no browser
  // to ask for it again.
  const quoteJson = JSON.stringify({ quote, seatToken });

  const booking: AgentLiveBookingRow = {
    id: bookingId, agent_id: agentId, buyer_uid: buyerUid, buyer_email: buyerEmail, buyer_tz: (typeof (quote as any).tz === 'string' && (quote as any).tz) ? String((quote as any).tz).slice(0, 64) : null,
    starts_at: startMs, ends_at: endMs, minutes: quote.minutes, price_per_min: quote.pricePerMin,
    amount: quote.amount, beneficiary_uid: quote.beneficiaryUid, persona_version: quote.personaVersion,
    policy_version: quote.policyVersion, order_id: orderId, idempotency_key: idempotencyKey,
    request_hash: requestHash, status: "pending", money_state: "none", instant: quote.instant ? 1 : 0,
    is_test: 0, join_token_hash: null, created_at: now, updated_at: now,
    checkout_phase: "reserved", quote_json: quoteJson, persona_snapshot_json: JSON.stringify(agent),
  };

  try {
    await db.prepare(
      `INSERT INTO agent_live_bookings
        (id, agent_id, buyer_uid, buyer_email, buyer_tz, starts_at, ends_at, minutes, price_per_min, amount,
         beneficiary_uid, persona_version, policy_version, order_id, idempotency_key, request_hash, status,
         money_state, instant, is_test, join_token_hash, created_at, updated_at, checkout_phase, quote_json, persona_snapshot_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?22,?23,?24,?25)`,
    ).bind(
      booking.id, booking.agent_id, booking.buyer_uid, booking.buyer_email, booking.buyer_tz,
      booking.starts_at, booking.ends_at, booking.minutes, booking.price_per_min, booking.amount,
      booking.beneficiary_uid, booking.persona_version, booking.policy_version, booking.order_id,
      booking.idempotency_key, booking.request_hash, booking.status, booking.money_state, booking.instant,
      booking.is_test, booking.join_token_hash, now, booking.checkout_phase, booking.quote_json, booking.persona_snapshot_json,
    ).run();
  } catch {
    // Unique (buyer_uid, idempotency_key) race — another request just won it.
    const raced = await db.prepare(
      `SELECT * FROM agent_live_bookings WHERE buyer_uid=?1 AND idempotency_key=?2`,
    ).bind(buyerUid, idempotencyKey).first<AgentLiveBookingRow>();
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    // F19: the row that won the race might belong to a DIFFERENT request that
    // merely reused this idempotency key with a different quote — never hand
    // that back as if it were a replay of THIS request.
    if (raced && raced.request_hash !== requestHash) return json({ error: "idempotency_conflict" }, 409);
    if (raced) return json({ bookingId: raced.id, status: raced.status, pending: raced.status !== "booked" }, raced.status === "booked" ? 200 : 202);
    return json({ error: "booking_conflict" }, 409);
  }

  // F1: every phase transition below is a CAS UPDATE — `WHERE
  // checkout_phase=<expected> AND NOT EXISTS (decision for this booking)` —
  // so a concurrent sweep/room decision that has already terminalized this
  // booking (e.g. the room decided completed_full on a late cancel while the
  // hold was still in flight) can never be silently overtaken by this request
  // continuing to march the phase forward.
  const reserved_to_hold_pending = await db.prepare(
    `UPDATE agent_live_bookings SET checkout_phase='hold_pending', updated_at=?2
       WHERE id=?1 AND checkout_phase='reserved' AND NOT EXISTS (SELECT 1 FROM agent_live_decisions WHERE booking_id=?1)`,
  ).bind(bookingId, Date.now()).run();
  if (!(reserved_to_hold_pending.meta?.changes ?? 0)) {
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    const terminal = await loadBooking(env, bookingId);
    return json({ error: "checkout_aborted", status: terminal?.status ?? "failed" }, 409);
  }

  // hold_pending -> hold()
  const holdResult = await hold(env, buyerUid, orderId, quote.amount, {
    opId: holdOpId(bookingId), app: "agent_live", title: agent.title,
  });
  if (!holdResult.ok) {
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    await db.prepare(
      `UPDATE agent_live_bookings SET status='failed', checkout_phase='aborted', updated_at=?2 WHERE id=?1`,
    ).bind(bookingId, Date.now()).run();
    return json({ error: "insufficient_tokens", error_legacy: "insufficient_avacoins" }, 402);
  }
  const hold_pending_to_held = await db.prepare(
    `UPDATE agent_live_bookings SET checkout_phase='held', money_state='held', updated_at=?2
       WHERE id=?1 AND checkout_phase='hold_pending' AND NOT EXISTS (SELECT 1 FROM agent_live_decisions WHERE booking_id=?1)`,
  ).bind(bookingId, Date.now()).run();
  if (!(hold_pending_to_held.meta?.changes ?? 0)) {
    // The hold already landed in the wallet — the sweep's walletOpResult
    // lookup (M1) reconciles it against whatever decision won this race, so
    // it is never orphaned. This request must stop here, not book a seat for
    // a booking someone else has already terminalized.
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    const terminal = await loadBooking(env, bookingId);
    return json({ error: "checkout_aborted", status: terminal?.status ?? "failed" }, 409);
  }

  // confirm_pending -> seatAuthority.confirm()
  const held_to_confirm_pending = await db.prepare(
    `UPDATE agent_live_bookings SET checkout_phase='confirm_pending', updated_at=?2
       WHERE id=?1 AND checkout_phase='held' AND NOT EXISTS (SELECT 1 FROM agent_live_decisions WHERE booking_id=?1)`,
  ).bind(bookingId, Date.now()).run();
  if (!(held_to_confirm_pending.meta?.changes ?? 0)) {
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    const terminal = await loadBooking(env, bookingId);
    return json({ error: "checkout_aborted", status: terminal?.status ?? "failed" }, 409);
  }
  let confirmed: SeatConfirmResult;
  try {
    confirmed = await seatAuthority(env).confirm({ bookingId, token: seatToken, instant: !!quote.instant });
  } catch { confirmed = { ok: false, reason: "confirm_request_failed" }; }

  if (!confirmed.ok) {
    try { await seatAuthority(env).abort({ bookingId }); } catch { /* best-effort */ }
    const freshBooking = await loadBooking(env, bookingId);
    if (freshBooking) {
      await decideAndEnqueue(env, freshBooking, "refunded_platform_failure", "seat_confirm_failed");
    }
    return json({ error: "seat_confirm_failed" }, 409);
  }

  const finalStart = confirmed.startMs ?? startMs;
  const finalEnd = confirmed.endMs ?? endMs;
  const bookedRow = await loadBooking(env, bookingId);
  if (!bookedRow) return json({ error: "booking_missing_after_confirm" }, 500);
  await finalizeBookedBooking(env, bookedRow, finalStart, finalEnd);

  return json({ bookingId, startsAt: finalStart, endsAt: finalEnd, talkPath: `/talk/${bookingId}` });
};

// ---------------------------------------------------------------------------
// POST .../bookings/:bookingId/cancel
// ---------------------------------------------------------------------------

export const agentBookingCancel: AgentLiveHandler = async (req, env, _ctx, params) => {
  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const booking = await loadBooking(env, params.bookingId);
  if (!booking) return json({ error: "not_found" }, 404);
  if (booking.buyer_uid !== authCtx.uid) return json({ error: "forbidden" }, 403);
  // F1: cancellation must only ever act on a VERIFIED hold — a booking whose
  // checkout is still in flight (pending/reserved/hold_pending/etc., no
  // money_state='held' yet) is neither safely refundable (nothing landed to
  // refund from) nor safely payable (an instant booking might still be
  // rejected downstream). Anything other than the fully-held steady state is
  // 409, full stop; a mid-flight checkout is left to the sweep/checkout path
  // to resolve to a terminal state on its own.
  if (!(booking.status === "booked" && booking.money_state === "held")) {
    return json({ error: "not_cancellable", status: booking.status }, 409);
  }

  const acceptedAt = Date.now();
  // The room decides (WS-E1 owns the outcome rule) — this proxies + returns.
  const roomResult = await callRoom<{ ok?: boolean; outcome?: DecisionOutcome; reason?: string }>(
    env, booking.id, "cancel", { bookingId: booking.id, buyerUid: authCtx.uid, acceptedAt },
  );
  if (roomResult && roomResult.ok !== false && roomResult.outcome) {
    return json(roomResult);
  }

  // Room unreachable — decide here with the SAME rule (D7).
  const early = booking.starts_at - acceptedAt >= CANCEL_EARLY_CUTOFF_MS;
  const outcome: DecisionOutcome = early ? "cancelled_by_customer_early" : "completed_full";
  const reason = early ? "customer_cancel_early" : "customer_cancel_late";
  await decideAndEnqueue(env, booking, outcome, reason);
  return json({ ok: true, outcome, reason });
};

// ---------------------------------------------------------------------------
// GET .../bookings/mine, GET .../bookings/:bookingId
// ---------------------------------------------------------------------------

export const agentBookingsMine: AgentLiveHandler = async (req, env) => {
  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const rows = await metaDb(env).prepare(
    `SELECT * FROM agent_live_bookings WHERE buyer_uid=?1 ORDER BY starts_at DESC LIMIT 50`,
  ).bind(authCtx.uid).all<AgentLiveBookingRow>();
  return json({ bookings: (rows.results ?? []).map(toPublicBooking) });
};

export const agentBookingGet: AgentLiveHandler = async (req, env, _ctx, params) => {
  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const booking = await loadBooking(env, params.bookingId);
  if (!booking || booking.buyer_uid !== authCtx.uid) return json({ error: "not_found" }, 404);
  return json(toPublicBooking(booking));
};
