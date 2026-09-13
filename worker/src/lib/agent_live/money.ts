// [AGENT-LIVE-1] Money state machine for AI voice agent bookings — the
// immutable-decision → durable-job → retrying-executor pipeline (BUILD SPEC
// §3 "Cron", §11 M1/M2/M3; R2 §2). Every terminal outcome for a booking goes
// through `decideAndEnqueue` exactly once (the D1 batch is INSERT-OR-IGNORE
// on both the decision and the job — a second call with the same outcome is a
// no-op, a call that would produce a DIFFERENT outcome is refused and
// tracked, never silently overwritten). `runMoneyJob` is the retrying
// executor; `runAgentLiveSweeps` is the cron backstop that claims due jobs,
// resumes crashed checkouts (M2) and finalizes overdue bookings.
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { sha256Hex } from "../../util";
import { hold, refund, releaseExact, walletOpResult } from "../../ledger";
import { signJoinTokenV2 } from "../../cal/ics";
import { track, trackUser } from "../../hooks";
import { readConfig } from "../../routes/config";
import { laneGate } from "./gate";
import { seatAuthority } from "./seats";
import { queueAgentConfirmation, queueAgentRefundEmail } from "./emails";
import {
  type AgentLiveBookingRow,
  type AgentLiveDecisionRow,
  type DecisionOutcome,
  PLATFORM_FEE_BPS,
  holdOpId,
  refundOpId,
} from "./types";
// [AGENT-LIVE-1 / M8] WS-E2 owns memory.ts and the erase/summarise job kinds
// it enqueues into this SAME agent_live_money_jobs table (BUILD SPEC §11 M8).
// `AgentLiveGenericJobRow` is memory.ts's own loose row shape (kind/state as
// plain strings — deliberately NOT types.ts's narrower AgentLiveMoneyJobRow,
// which only names 'refund'/'release') — reused here as-is so both files
// agree on exactly one job row shape for this shared table.
import { runEraseJob, runSummariseJob, type AgentLiveGenericJobRow } from "./memory";

export type AgentLiveMoneyJobRecord = AgentLiveGenericJobRow;

const JOB_LOCK_MS = 60_000;
const RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_ATTEMPTS = 8;
const CHECKOUT_STUCK_MS = 3 * 60_000;
const SWEEP_LIMIT = 20;

function feeAndNet(gross: number): { fee: number; net: number } {
  const fee = gross > 0 ? Math.round((gross * PLATFORM_FEE_BPS) / 10000) : 0;
  return { fee, net: gross - fee };
}

/** Exported so checkout.ts (cancel) can proxy to the same room without a
 * second copy of the idFromName/fetch boilerplate. */
export async function callRoom<T = any>(
  env: Env,
  bookingId: string,
  path: string,
  body: unknown,
  method: "POST" | "GET" = "POST",
): Promise<T | null> {
  try {
    const stub = env.AGENT_LIVE_ROOMS.get(env.AGENT_LIVE_ROOMS.idFromName(bookingId));
    const r = await stub.fetch(`https://room/${path}`, method === "GET"
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if (!r.ok) return null;
    return (await r.json().catch(() => null)) as T | null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// decideAndEnqueue — the ONE immutable-decision writer (M3).
// ---------------------------------------------------------------------------

/**
 * Records the terminal money decision for a booking and enqueues its job, in
 * one D1 batch (M3): INSERT OR IGNORE decision → INSERT OR IGNORE job → UPDATE
 * booking. Never UPDATEs an existing decision row. If a decision already
 * exists with a DIFFERENT hash (two callers disagreeing on the outcome — e.g.
 * a cron finalize racing a room decision), this stops and tracks a conflict
 * rather than overwriting the authoritative row. Then makes ONE best-effort
 * inline attempt to run the resulting job — the cron sweep is the durable
 * backstop if that attempt fails or this isolate dies.
 */
export async function decideAndEnqueue(
  env: Env,
  booking: AgentLiveBookingRow,
  outcome: DecisionOutcome,
  reason: string,
): Promise<AgentLiveDecisionRow | null> {
  const db = metaDb(env);
  const amount = booking.amount;
  const isRefund = outcome === "cancelled_by_customer_early" || outcome === "refunded_platform_failure";
  const refundAmount = isRefund ? amount : 0;
  const releaseGross = isRefund ? 0 : amount;
  const { fee, net } = feeAndNet(releaseGross);
  const decidedAt = Date.now();
  const decisionHash = await sha256Hex(JSON.stringify({
    booking_id: booking.id, outcome, reason, amount,
    refund_amount: refundAmount, release_gross: releaseGross, fee, net,
    beneficiary_uid: booking.beneficiary_uid,
  }));
  const jobKind: "refund" | "release" = isRefund ? "refund" : "release";
  const jobId = `${booking.id}:${jobKind}`;
  const newStatus = outcome === "cancelled_by_customer_early" ? "cancelled"
    : outcome === "refunded_platform_failure" ? "failed"
    : "completed";
  const newMoneyState = isRefund ? "refund_pending" : "release_pending";

  // Admin test calls (M11) and any zero-amount booking carry no escrow: record
  // the terminal status only — no decision row, no money job (a 0-token refund
  // or release would fail `amount>0` forever and park in needs_attention).
  if (booking.is_test || !(amount > 0)) {
    await db.prepare(
      `UPDATE agent_live_bookings SET status=?2, checkout_phase='aborted', updated_at=?3 WHERE id=?1 AND status NOT IN ('completed','cancelled','failed')`,
    ).bind(booking.id, newStatus, decidedAt).run();
    return null;
  }

  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO agent_live_decisions
        (booking_id, outcome, reason, amount, refund_amount, release_gross, fee, net, beneficiary_uid, decision_hash, decided_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(booking.id, outcome, reason, amount, refundAmount, releaseGross, fee, net, booking.beneficiary_uid, decisionHash, decidedAt),
    // F2: the job may only be enqueued for the decision that actually WON —
    // a losing/conflicting caller (hash mismatch against the row that landed)
    // must never create a job for an outcome nobody recorded.
    db.prepare(
      `INSERT OR IGNORE INTO agent_live_money_jobs
        (id, booking_id, kind, state, attempts, next_attempt_at, created_at, updated_at)
       SELECT ?1,?2,?3,'pending',0,?4,?4,?4
        WHERE EXISTS (SELECT 1 FROM agent_live_decisions d WHERE d.booking_id=?2 AND d.decision_hash=?5)`,
    ).bind(jobId, booking.id, jobKind, decidedAt, decisionHash),
    // Only the caller whose decision is the authoritative row may move the
    // booking projection — a losing (conflicting) caller must not relabel it.
    // F2: an identical replay (hash already recorded) must never regress
    // money_state back to a *_pending state once it has reached a terminal
    // released/refunded state. F3: fold checkout_phase='aborted' into this
    // same write so every checkout/recovery caller of decideAndEnqueue gets
    // it for free — a booking that reached a decision is never "in flight"
    // again, regardless of what checkout phase it was in when this landed.
    db.prepare(
      `UPDATE agent_live_bookings SET status=?2, money_state=?3, checkout_phase='aborted', updated_at=?4
        WHERE id=?1
          AND EXISTS (SELECT 1 FROM agent_live_decisions d WHERE d.booking_id=?1 AND d.decision_hash=?5)
          AND money_state NOT IN ('released','refunded')`,
    ).bind(booking.id, newStatus, newMoneyState, decidedAt, decisionHash),
  ]);

  const existing = await db.prepare(
    `SELECT booking_id, outcome, reason, amount, refund_amount, release_gross, fee, net, beneficiary_uid, decision_hash, decided_at
       FROM agent_live_decisions WHERE booking_id=?1`,
  ).bind(booking.id).first<AgentLiveDecisionRow>();

  if (!existing || existing.decision_hash !== decisionHash) {
    track(env, booking.buyer_uid, "agent_decision_conflict", "agent_live", {
      booking_id: booking.id, attempted_outcome: outcome, existing_outcome: existing?.outcome ?? null,
    });
    return existing ?? null;
  }

  trackUser(env, booking.buyer_uid, booking.buyer_email, "agent_decision", "agent_live", {
    outcome, reason, booking_id: booking.id, amount,
  });

  const job = await db.prepare(
    `SELECT * FROM agent_live_money_jobs WHERE id=?1`,
  ).bind(jobId).first<AgentLiveMoneyJobRecord>();
  if (job) {
    try { await runMoneyJob(env, job); } catch { /* cron sweep retries */ }
  }
  // F2: return the winning decision row so callers (the room, checkout,
  // recovery) can report the REAL outcome instead of assuming their own
  // attempted outcome won the race.
  return existing;
}

// ---------------------------------------------------------------------------
// Job claim + retry bookkeeping (R2 §2.7).
// ---------------------------------------------------------------------------

async function finishJob(
  db: D1Database, id: string, lockToken: string, state: "done" | "needs_attention", error: string | null,
): Promise<void> {
  await db.prepare(
    `UPDATE agent_live_money_jobs SET state=?2, last_error=?3, lock_token=NULL, lock_until=NULL, updated_at=?4
       WHERE id=?1 AND lock_token=?5`,
  ).bind(id, state, error, Date.now(), lockToken).run();
}

async function retryOrGiveUp(
  db: D1Database, id: string, lockToken: string, attempts: number, error: string,
): Promise<"retry" | "needs_attention"> {
  const now = Date.now();
  if (attempts >= MAX_ATTEMPTS) {
    await db.prepare(
      `UPDATE agent_live_money_jobs SET state='needs_attention', last_error=?2, lock_token=NULL, lock_until=NULL, updated_at=?3
         WHERE id=?1 AND lock_token=?4`,
    ).bind(id, error.slice(0, 500), now, lockToken).run();
    return "needs_attention";
  }
  const delay = RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1)];
  await db.prepare(
    `UPDATE agent_live_money_jobs SET state='pending', next_attempt_at=?2, last_error=?3, lock_token=NULL, lock_until=NULL, updated_at=?4
       WHERE id=?1 AND lock_token=?5`,
  ).bind(id, now + delay, error.slice(0, 500), now, lockToken).run();
  return "retry";
}

/**
 * Claim-then-execute one money job (R2 §2.7 UPDATE...RETURNING lock pattern).
 * Safe to call repeatedly/concurrently — only the caller that wins the claim
 * (matching lock_token) executes; everyone else no-ops.
 */
export async function runMoneyJob(env: Env, job: AgentLiveMoneyJobRecord): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();
  if (job.state === "done" || job.state === "needs_attention") return;

  const lockToken = crypto.randomUUID();
  const claimed = await db.prepare(
    `UPDATE agent_live_money_jobs
        SET state='running', lock_token=?1, lock_until=?2, attempts=attempts+1, updated_at=?3
      WHERE id=?4 AND state IN ('pending','running') AND next_attempt_at<=?3
        AND (lock_until IS NULL OR lock_until<=?3)
      RETURNING attempts`,
  ).bind(lockToken, now + JOB_LOCK_MS, now, job.id).first<{ attempts: number }>();
  if (!claimed) return; // not due yet, or another runner already holds the lock
  const attempts = claimed.attempts;

  // §11 M8 (WS-E2 job kinds) — delegate outright; this table is shared. Note:
  // memory.ts's own job runners manage their OWN state/attempts bookkeeping
  // (they never leave a job 'running' — see updateJobRow in memory.ts), so
  // claiming here and then unconditionally finishJob('done') would stomp a
  // 'needs_attention' outcome memory.ts already wrote. Re-read the row.
  if (job.kind === "erase" || job.kind === "summarise") {
    try {
      if (job.kind === "erase") await runEraseJob(env, job);
      else await runSummariseJob(env, job);
    } catch (e) {
      const outcome = await retryOrGiveUp(db, job.id, lockToken, attempts, String(e));
      track(env, "", "agent_money_job", "agent_live", { kind: job.kind, state: outcome, attempts, booking_id: job.booking_id });
    }
    return;
  }

  const booking = await db.prepare(`SELECT * FROM agent_live_bookings WHERE id=?1`).bind(job.booking_id).first<AgentLiveBookingRow>();
  if (!booking) { await finishJob(db, job.id, lockToken, "needs_attention", "booking_missing"); return; }
  const decision = await db.prepare(`SELECT * FROM agent_live_decisions WHERE booking_id=?1`).bind(job.booking_id).first<AgentLiveDecisionRow>();
  if (!decision) { await finishJob(db, job.id, lockToken, "needs_attention", "decision_missing"); return; }

  try {
    if (job.kind === "refund") {
      // M1: look up the existing refund op before retrying — a lost response
      // for an already-applied refund is not the same as failure.
      const existingOp = await walletOpResult(env, booking.buyer_uid, refundOpId(booking.id));
      let ok = existingOp.found && existingOp.result?.ok !== false;
      if (!ok) {
        const r = await refund(env, booking.order_id, booking.buyer_uid, decision.refund_amount, {
          opId: refundOpId(booking.id), reason: decision.reason ?? decision.outcome,
        });
        if (r.status === 409) {
          const outcome = await retryOrGiveUp(db, job.id, lockToken, attempts, "refund pending (409 escrow not yet settled)");
          track(env, booking.buyer_uid, "agent_money_job", "agent_live", { kind: "refund", state: outcome, attempts });
          return;
        }
        if (!r.ok) throw new Error(`refund failed: status ${r.status}`);
        ok = true;
      }
      if (ok) {
        await db.prepare(`UPDATE agent_live_bookings SET money_state='refunded', updated_at=?2 WHERE id=?1`).bind(booking.id, Date.now()).run();
        if (decision.outcome === "refunded_platform_failure") {
          try {
            await queueAgentRefundEmail(env, {
              bookingId: booking.id, buyerUid: booking.buyer_uid, agentTitle: booking.agent_id,
              amount: decision.refund_amount, reason: decision.reason ?? "platform failure",
            });
          } catch { /* best-effort */ }
        }
        await finishJob(db, job.id, lockToken, "done", null);
        track(env, booking.buyer_uid, "agent_money_job", "agent_live", { kind: "refund", state: "done", attempts });
      }
    } else if (job.kind === "release") {
      const r = await releaseExact(env, {
        orderId: booking.order_id, beneficiaryUid: decision.beneficiary_uid,
        gross: decision.release_gross, fee: decision.fee, net: decision.net,
        title: `AI voice session ${booking.agent_id}`,
      });
      if (!r.ok) throw new Error(`release failed: status ${r.status}`);
      await db.prepare(`UPDATE agent_live_bookings SET money_state='released', updated_at=?2 WHERE id=?1`).bind(booking.id, Date.now()).run();
      await finishJob(db, job.id, lockToken, "done", null);
      track(env, booking.buyer_uid, "agent_money_job", "agent_live", { kind: "release", state: "done", attempts });
    } else {
      await finishJob(db, job.id, lockToken, "needs_attention", `unknown job kind ${job.kind}`);
    }
  } catch (e) {
    const outcome = await retryOrGiveUp(db, job.id, lockToken, attempts, String(e));
    track(env, booking.buyer_uid, "agent_money_job", "agent_live", { kind: job.kind, state: outcome, attempts });
  }
}

// ---------------------------------------------------------------------------
// Checkout finalization (shared by `agentBook` and crash recovery below) —
// M4: agentBook must call room `/schedule` after the D1 `booked` write.
// ---------------------------------------------------------------------------

/**
 * Commits a confirmed seat reservation as a booked row: freezes the
 * authoritative `[startMs,endMs)` interval (M5 — instant bookings are rebased
 * at confirmation time), mints the buyer's `/j/` join token (M9), asks the
 * room to `/schedule` (M4), and queues the confirmation email. Used both by
 * `agentBook` (checkout.ts, WS-D) on the happy path and by this module's own
 * crash recovery when a checkout died between seat confirmation and the
 * booked write.
 */
export async function finalizeBookedBooking(
  env: Env, booking: AgentLiveBookingRow, startMs: number, endMs: number,
): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();

  // F3: a decision already exists for this booking (e.g. a late cancel or a
  // refund landed while this confirm was still in flight) — never rewrite a
  // refunded/cancelled booking back into a booked/held state.
  const existingDecision = await db.prepare(
    `SELECT 1 FROM agent_live_decisions WHERE booking_id=?1`,
  ).bind(booking.id).first();
  if (existingDecision) return;

  let joinTokenHash: string | null = null;
  try {
    const token = await signJoinTokenV2(env, {
      bookingId: booking.id, listingId: booking.agent_id, accountId: booking.buyer_uid,
      kind: "agent", expMs: endMs + 24 * 60 * 60 * 1000,
    });
    joinTokenHash = await sha256Hex(token);
  } catch { /* JOIN_LINK_SECRET missing — laneGate should have refused earlier; leave hash null */ }

  await db.prepare(
    `UPDATE agent_live_bookings
        SET starts_at=?2, ends_at=?3, status='booked', money_state='held', checkout_phase='booked',
            join_token_hash=?4, updated_at=?5
      WHERE id=?1`,
  ).bind(booking.id, startMs, endMs, joinTokenHash, now).run();

  await callRoom(env, booking.id, "schedule", { bookingId: booking.id });

  let agentTitle = booking.agent_id;
  try {
    const listing = await db.prepare(`SELECT title FROM listings WHERE id=?1`).bind(booking.agent_id).first<{ title: string }>();
    if (listing?.title) agentTitle = listing.title;
  } catch { /* best-effort title lookup */ }

  try {
    await queueAgentConfirmation(env, {
      bookingId: booking.id, agentId: booking.agent_id, buyerUid: booking.buyer_uid, agentTitle,
      startsAt: startMs, endsAt: endMs, minutes: booking.minutes, amount: booking.amount,
      buyerTz: booking.buyer_tz, instant: !!booking.instant,
    });
  } catch { /* best-effort */ }

  trackUser(env, booking.buyer_uid, booking.buyer_email, "agent_booking_created", "agent_live", {
    minutes: booking.minutes, instant: !!booking.instant, booking_id: booking.id,
  });
}

// ---------------------------------------------------------------------------
// runAgentLiveSweeps — cron */5 (BUILD SPEC §3 "Cron", §11 M2/M4/M12).
// ---------------------------------------------------------------------------

/** `quote_json` stores `{quote, seatToken}` (see checkout.ts `agentBook`) —
 * `confirm()` needs the EXACT token from the original `reserveProvisional`
 * call, and recovery has no browser to ask for it again. */
function storedSeatToken(booking: AgentLiveBookingRow): string | null {
  try {
    const parsed = booking.quote_json ? JSON.parse(booking.quote_json) : null;
    return typeof parsed?.seatToken === "string" ? parsed.seatToken : null;
  } catch { return null; }
}

/** M2 — resume a checkout stuck mid-flight, without a browser.
 *
 * F3: this is only the CLAIM step. A decision already recorded for this
 * booking means there is nothing left to recover — the booking projection
 * was (or will be) settled by that decision's own batch, and re-deriving a
 * fresh outcome here (e.g. rewriting a refunded booking back to booked) is
 * exactly the bug this fixes. The CAS on `updated_at` ensures only ONE
 * concurrent sweep (or a sweep racing a still-live checkout request) ever
 * acts on a given stuck row.
 */
async function recoverCheckout(env: Env, booking: AgentLiveBookingRow): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();

  const existingDecision = await db.prepare(
    `SELECT 1 FROM agent_live_decisions WHERE booking_id=?1`,
  ).bind(booking.id).first();
  if (existingDecision) return;

  const claim = await db.prepare(
    `UPDATE agent_live_bookings SET updated_at=?3
       WHERE id=?1 AND updated_at=?2 AND NOT EXISTS (SELECT 1 FROM agent_live_decisions WHERE booking_id=?1)`,
  ).bind(booking.id, booking.updated_at, now).run();
  if (!(claim.meta?.changes ?? 0)) return; // raced — another runner claimed it, or a decision landed since we read it

  await recoverClaimedCheckout(env, { ...booking, updated_at: now });
}

/** The actual phase state machine, run only once this row is claimed
 * (owned exclusively by this sweep invocation — see recoverCheckout above). */
async function recoverClaimedCheckout(env: Env, booking: AgentLiveBookingRow): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();

  if (booking.checkout_phase === "reserved") {
    // No hold was ever attempted — never start one after the fact; abort clean.
    try { await seatAuthority(env).abort({ bookingId: booking.id }); } catch { /* best-effort */ }
    await db.prepare(
      `UPDATE agent_live_bookings SET status='failed', checkout_phase='aborted', updated_at=?2 WHERE id=?1`,
    ).bind(booking.id, now).run();
    return;
  }

  if (booking.checkout_phase === "hold_pending") {
    // The hold may already have landed — recover via its op result first
    // (R2 §2.3: never label "nothing charged" from a bare timeout). F18: a
    // LOOKUP FAILURE (exception) is UNKNOWN, not "not found" — we cannot
    // tell whether the hold already landed, so never guess; leave the row
    // for the next sweep rather than risk either a duplicate debit or a
    // wrongly-aborted charged booking.
    let existing: { found: boolean; result: any };
    try {
      existing = await walletOpResult(env, booking.buyer_uid, holdOpId(booking.id));
    } catch {
      return;
    }
    const landed = existing.found && existing.result?.ok !== false;
    if (!landed) {
      // F18: crash-after-persist-before-WalletDO recovery must not start a
      // NEW debit once the original quote has since expired or the lane has
      // since been disabled — abort the checkout instead of holding.
      let storedQuote: any = null;
      try { storedQuote = booking.quote_json ? JSON.parse(booking.quote_json)?.quote : null; } catch { /* ignore */ }
      const quoteExpired = !storedQuote || typeof storedQuote.expiresAt !== "number" || Date.now() > storedQuote.expiresAt;
      const cfg = await readConfig(env);
      const gateOk = laneGate(env, cfg).ok;
      if (quoteExpired || !gateOk) {
        try { await seatAuthority(env).abort({ bookingId: booking.id }); } catch { /* best-effort */ }
        await db.prepare(
          `UPDATE agent_live_bookings SET status='failed', checkout_phase='aborted', updated_at=?2 WHERE id=?1`,
        ).bind(booking.id, now).run();
        return;
      }
      const r = await hold(env, booking.buyer_uid, booking.order_id, booking.amount, {
        opId: holdOpId(booking.id), app: "agent_live",
      });
      if (!r.ok) {
        try { await seatAuthority(env).abort({ bookingId: booking.id }); } catch { /* best-effort */ }
        await db.prepare(
          `UPDATE agent_live_bookings SET status='failed', checkout_phase='aborted', updated_at=?2 WHERE id=?1`,
        ).bind(booking.id, now).run();
        return;
      }
    }
    await db.prepare(`UPDATE agent_live_bookings SET checkout_phase='held', updated_at=?2 WHERE id=?1`).bind(booking.id, now).run();
    return recoverClaimedCheckout(env, { ...booking, checkout_phase: "held", updated_at: now });
  }

  if (booking.checkout_phase === "held" || booking.checkout_phase === "confirm_pending") {
    const snap = await seatAuthority(env).getReservation({ bookingId: booking.id }).catch((): null => null);
    if (snap && snap.ok) {
      const { state, startMs, endMs } = snap.reservation;
      if (state === "aborted" || state === "expired") {
        await decideAndEnqueue(env, booking, "refunded_platform_failure", "seat_confirm_failed");
        return;
      }
      if (state === "confirmed" || state === "active") {
        await finalizeBookedBooking(env, booking, startMs, endMs);
        return;
      }
    }
    const seatToken = storedSeatToken(booking);
    if (!seatToken) {
      // No stored token — cannot safely confirm; fail closed.
      try { await seatAuthority(env).abort({ bookingId: booking.id }); } catch { /* best-effort */ }
      await decideAndEnqueue(env, booking, "refunded_platform_failure", "seat_confirm_failed");
      return;
    }
    await db.prepare(`UPDATE agent_live_bookings SET checkout_phase='confirm_pending', updated_at=?2 WHERE id=?1`).bind(booking.id, now).run();
    try {
      const c = await seatAuthority(env).confirm({ bookingId: booking.id, token: seatToken, instant: !!booking.instant });
      if (c.ok) {
        await finalizeBookedBooking(env, booking, c.startMs, c.endMs);
        return;
      }
    } catch { /* fall through to abort+refund */ }
    try { await seatAuthority(env).abort({ bookingId: booking.id }); } catch { /* best-effort */ }
    await decideAndEnqueue(env, booking, "refunded_platform_failure", "seat_confirm_failed");
  }
}

/**
 * Cron entrypoint (`*\/5 * * * *`): claims due money jobs, recovers stuck
 * checkout phases (M2), finalizes overdue bookings, re-schedules `booked`
 * rows the room lost track of (M4), and — under `agentEmergencyStop` (M12) —
 * finalizes every live booking with `refunded_platform_failure(emergency_stop)`.
 */
export async function runAgentLiveSweeps(env: Env): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();
  const cfg = await readConfig(env);

  // 1. Claim + run due money jobs (<=20 per sweep).
  const dueJobs = await db.prepare(
    `SELECT * FROM agent_live_money_jobs
       WHERE state IN ('pending','running') AND next_attempt_at<=?1 AND (lock_until IS NULL OR lock_until<=?1)
       ORDER BY next_attempt_at ASC LIMIT ?2`,
  ).bind(now, SWEEP_LIMIT).all<AgentLiveMoneyJobRecord>();
  for (const job of dueJobs.results ?? []) {
    try { await runMoneyJob(env, job); } catch { /* next sweep retries */ }
  }

  // 2. Recover checkouts stuck mid-flight for >3 min (M2).
  const stuck = await db.prepare(
    `SELECT * FROM agent_live_bookings
       WHERE checkout_phase IN ('reserved','hold_pending','held','confirm_pending') AND updated_at<?1
       LIMIT ?2`,
  ).bind(now - CHECKOUT_STUCK_MS, SWEEP_LIMIT).all<AgentLiveBookingRow>();
  for (const booking of stuck.results ?? []) {
    try { await recoverCheckout(env, booking); } catch { /* next sweep retries */ }
  }

  // 3. Overdue bookings the room never terminalized (finalize, or decide an
  //    orphan refund if the room never even started — D12/M4).
  const overdue = await db.prepare(
    `SELECT * FROM agent_live_bookings WHERE status IN ('booked','in_progress') AND ends_at<?1 LIMIT ?2`,
  ).bind(now, SWEEP_LIMIT).all<AgentLiveBookingRow>();
  for (const booking of overdue.results ?? []) {
    const trigger = cfg.agentEmergencyStop ? "emergency" : "cron";
    const result = await callRoom<{ ok?: boolean }>(env, booking.id, "finalize", { bookingId: booking.id, trigger });
    if (!result || result.ok === false) {
      try { await decideAndEnqueue(env, booking, "refunded_platform_failure", "orphan"); } catch { /* next sweep retries */ }
    }
  }

  // 4. Re-`/schedule` any `booked` row whose room reports it never got there.
  const upcoming = await db.prepare(
    `SELECT * FROM agent_live_bookings WHERE status='booked' AND starts_at>?1 LIMIT ?2`,
  ).bind(now, SWEEP_LIMIT).all<AgentLiveBookingRow>();
  for (const booking of upcoming.results ?? []) {
    const state = await callRoom<{ scheduled?: boolean }>(env, booking.id, "state", null, "GET");
    if (!state || state.scheduled !== true) {
      await callRoom(env, booking.id, "schedule", { bookingId: booking.id });
    }
  }

  // 5. Emergency stop (M12) — finalize every live booking with the emergency reason.
  if (cfg.agentEmergencyStop) {
    const live = await db.prepare(
      `SELECT * FROM agent_live_bookings WHERE status IN ('booked','in_progress') LIMIT 50`,
    ).all<AgentLiveBookingRow>();
    for (const booking of live.results ?? []) {
      const result = await callRoom<{ ok?: boolean }>(env, booking.id, "finalize", { bookingId: booking.id, trigger: "emergency" });
      if (!result || result.ok === false) {
        try { await decideAndEnqueue(env, booking, "refunded_platform_failure", "emergency_stop"); } catch { /* next sweep retries */ }
      }
    }
  }
}
