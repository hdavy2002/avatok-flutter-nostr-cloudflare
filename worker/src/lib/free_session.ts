// [LIST-FREE-1] The free lane — the CREATOR pays, not the buyer.
// Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §E.
//
// A `free_entry=1` listing is priced at ₹0 for the buyer, but it is not free to run: at
// go-live the server holds the creator's declared spend cap (`attrs.content_free_cap_tokens`)
// out of THEIR wallet into `escrow:free:<sessionId>`, meters attendance off the same
// `commercial_participant_intervals` rows the paid lane already writes, and at session end
// settles actual usage against the platform and returns whatever of the cap went unused.
//
// The buyer side (price=0 entitlement) already flows through the existing
// commercialCheckout / provisionCommercialPurchase path unchanged — a free-priced order
// takes the `tax.buyerTotal === 0` branch there and skips the hold entirely. This file only
// adds the CREATOR-funded spend cap around go-live / join / settle, plus the attendee-count
// gates the checkout and join routes need to enforce the cap as a ceiling on headcount.
//
// Fail closed everywhere: insufficient creator balance refuses to start (never a negative
// balance, never an unmetered session); a join past the attendee cap is refused, never
// silently admitted. Every money movement here goes through worker/src/ledger.ts's
// existing, already-idempotent primitives — nothing here talks to WalletDO or D1 wallet
// tables directly.

import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { hold, refund, feeFromEscrow, escrowBalance, type LedgerResult } from "../ledger";
import { track } from "../hooks";
import { readConfig } from "../routes/config";

export type FreeSessionKind = "live_event" | "consult_1to1";

export interface FreeSessionListingRow {
  free_entry: number | boolean | null;
  attrs: string | null;
  capacity: number | null;
  duration_min: number | null;
}

export interface FreeSessionPolicy {
  enabled: boolean;
  capTokens: number;
  ratePerAttendeeMinute: number;
  maxAttendees: number;
}

function parseAttrs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Policy for one listing. `enabled` requires BOTH the platform kill switch
 * (`freeSessionsEnabled`, default false) AND the listing's own `free_entry=1` — either
 * alone is not enough, matching how every other commercial gate in this codebase reads a
 * platform flag AND a listing/row flag rather than either in isolation.
 *
 * `maxAttendees`: when the metering rate is 0 (free-for-real, no per-minute charge to the
 * creator), the ceiling is just the listing's own capacity. When a rate is set, the cap
 * becomes a budget — floor(capTokens / (rate * duration_min)) — clamped so it can never
 * exceed the listing's capacity either.
 */
export async function freeSessionPolicy(env: Env, listing: FreeSessionListingRow): Promise<FreeSessionPolicy> {
  const config = await readConfig(env);
  const enabled = config.freeSessionsEnabled === true && Number(listing.free_entry) === 1;
  const attrs = parseAttrs(listing.attrs);
  const rate = Math.max(0, Number(config.freeSessionTokensPerAttendeeMinute) || 0);
  const capacity = Math.max(1, Math.trunc(Number(listing.capacity ?? 1)));
  const durationMin = Math.max(1, Math.trunc(Number(listing.duration_min ?? 60)));
  // [PRICE-HOURLY-2 2026-09-05] The cap is DERIVED when the listing does not
  // carry one, because the wizard stopped asking for it (owner decision: a free
  // show does not interrogate the admin about their wallet). The default is
  // "one full house for the whole session" — capacity × duration × rate — so
  // maxAttendees below works out to exactly the listing's own capacity, which
  // is what an unqualified "free show" means.
  //
  // ⚠️ Do NOT simplify this back to `?? 0`. Zero is not a neutral default here:
  // with a rate set (it is 1 in production), a cap of 0 makes byBudget 0, so
  // maxAttendees is 0 and NOBODY can join — a free show that silently admits no
  // one, with no error for the creator or the viewer to see. An explicit cap on
  // the row still wins; this only fills the absence.
  const declaredCap = Number(attrs.content_free_cap_tokens);
  const capTokens = Number.isFinite(declaredCap) && declaredCap > 0
    ? Math.trunc(declaredCap)
    : capacity * durationMin * Math.max(rate, 1);
  let maxAttendees = capacity;
  if (rate > 0) {
    const byBudget = Math.floor(capTokens / (rate * durationMin));
    maxAttendees = Math.max(0, Math.min(capacity, byBudget));
  }
  return { enabled, capTokens, ratePerAttendeeMinute: rate, maxAttendees };
}

/** Ticket/booking count for the checkout-time gate — mirrors listings.ts `cardStatsFor`'s
 *  `seats_taken`: every entitlement that represents a held seat, regardless of whether the
 *  holder is currently connected. */
export async function countFreeEntitlements(env: Env, kind: FreeSessionKind, listingId: string): Promise<number> {
  const row = await metaDb(env).prepare(
    `SELECT COUNT(*) c FROM commercial_entitlements
      WHERE kind=?1 AND listing_id=?2 AND role IN ('viewer','buyer')
        AND state IN ('reserved','held','active','consumed')`,
  ).bind(kind, listingId).first<{ c: number }>();
  return Math.trunc(Number(row?.c ?? 0));
}

/** Live-right-now count for the join-time gate — mirrors listings.ts `cardStatsFor`'s
 *  `watching`: participant intervals still OPEN for this listing's session. */
export async function countFreeWatching(env: Env, listingId: string): Promise<number> {
  const row = await metaDb(env).prepare(
    `SELECT COUNT(*) c FROM commercial_participant_intervals i
       JOIN commercial_sessions s ON s.commercial_session_id = i.commercial_session_id
      WHERE s.listing_id = ?1 AND i.reconciliation_state = 'open'`,
  ).bind(listingId).first<{ c: number }>();
  return Math.trunc(Number(row?.c ?? 0));
}

export type FreeSessionHoldResult =
  | { ok: true; orderId: string; opId: string; duplicate: boolean }
  | {
    ok: false;
    status: number;
    error: string;
    error_legacy: string;
    needed: number;
    balance: number | null;
  };

/**
 * Hold the creator's declared spend cap into `escrow:free:<sessionId>` before the provider
 * session is created. Idempotent on `free-hold:<sessionId>` — a retried go-live (e.g. a
 * client that resubmits after a timeout) replays the ORIGINAL result at the WalletDO
 * (ops-table dedupe, worker/src/do/wallet.ts:349-359) rather than holding the cap twice.
 */
export async function holdFreeSessionCap(
  env: Env,
  args: { creatorId: string; sessionId: string; capTokens: number; title?: string },
): Promise<FreeSessionHoldResult> {
  const orderId = `free:${args.sessionId}`;
  const opId = `free-hold:${args.sessionId}`;
  const r: LedgerResult = await hold(env, args.creatorId, orderId, args.capTokens, {
    opId,
    title: args.title ?? "Free session reserve",
    app: "avaexplore",
  });
  if (r.ok) {
    void track(env, args.creatorId, "free_session_hold", "avaexplore", {
      session_id: args.sessionId, cap_tokens: args.capTokens, outcome: "held", duplicate: r.body?.duplicate === true,
    }).catch(() => undefined);
    return { ok: true, orderId, opId, duplicate: r.body?.duplicate === true };
  }
  const balance = typeof r.body?.spendable === "number"
    ? r.body.spendable
    : (typeof r.body?.balance === "number" ? r.body.balance : null);
  void track(env, args.creatorId, "free_session_hold", "avaexplore", {
    session_id: args.sessionId, cap_tokens: args.capTokens, outcome: "insufficient", balance: balance ?? -1,
  }).catch(() => undefined);
  return {
    ok: false,
    status: r.status === 402 ? 402 : r.status,
    error: "insufficient_tokens",
    error_legacy: "insufficient_avacoins",
    needed: args.capTokens,
    balance,
  };
}

/** Emitted by the join-time gate so callers can log a consistent refusal event without each
 *  duplicating the track() call shape. Money-neutral — no ledger call in this path. */
export function trackFreeSessionJoinRefused(
  env: Env,
  args: { creatorId: string; sessionId: string; maxAttendees: number; currentCount: number },
): void {
  void track(env, args.creatorId, "free_session_join_refused", "avaexplore", {
    session_id: args.sessionId, max_attendees: args.maxAttendees, current_count: args.currentCount,
  }).catch(() => undefined);
}

export interface FreeSessionSettlement {
  ok: boolean;
  sessionId: string;
  capTokens: number;
  minutesBilled: number;
  spendTokens: number;
  refundedTokens: number;
  /** True on an idempotent re-entry that found escrow already empty — no ledger call was
   *  made at all. */
  already?: boolean;
  /** Whether the `free-fee:<sessionId>` escrow->platform:fees row landed (or there was
   *  nothing to move, spendTokens===0). */
  feeRowOk: boolean;
  /** Whether the `free-refund:<sessionId>` escrow->creator row landed (or there was
   *  nothing to refund, refundedTokens===0). */
  refundRowOk: boolean;
}

/**
 * Settle one ended free session: meter attendee-minutes off `commercial_participant_intervals`
 * (excluding the host/creator's own interval), spend = min(ceil(minutes * rate), cap), and
 * refund the creator whatever of the cap was not spent.
 *
 * SETTLEMENT MOVES UP TO TWO LEDGER ROWS out of `escrow:free:<sessionId>`, in this order:
 *
 *   1. `free-fee:<sessionId>`    escrow -> platform:fees   (ledger.ts `feeFromEscrow`, the
 *      metered spend — the creator earns nothing from their own cap being consumed, so this
 *      is a ledger-only fee row with no paired creator credit, unlike `release()`'s 80/20 split)
 *   2. `free-refund:<sessionId>` escrow -> creator          (ledger.ts `refund`, whatever of
 *      the cap went unspent)
 *
 * FEE FIRST, REFUND SECOND — deliberately, not incidentally. If the process crashes between
 * the two calls, escrow is left holding the refund amount: a safe, non-negative, auditable
 * state that a later retry (or manual reconciliation) can still act on. Refunding first would
 * risk the opposite: crash after the refund but before the fee, and the fee call now has to
 * take `spendTokens` out of a bucket that may no longer hold enough — `feeFromEscrow` 409s
 * rather than overdraw, which is correct, but it is a state this ordering avoids entirely.
 *
 * IDEMPOTENCY. There is no new settlement table (this task may not add migrations) — the
 * guarantee that running this twice never moves money twice comes entirely from the ledger's
 * own op_id dedupe: `feeFromEscrow()` and `refund()` use the stable op_ids
 * `free-fee:<sessionId>` / `free-refund:<sessionId>`, which become the `wallet_ledger` row PK
 * (fee leg, ledger-only) or the WalletDO ops-table key (refund leg, do/wallet.ts:349-359) —
 * either way a replay returns/no-ops rather than moving money again. On top of that, this
 * function checks `escrowBalance(orderId) === 0` on entry and returns `{ok:true, already:true}`
 * without calling either primitive — a fully-settled session's escrow is empty, so a second
 * settle attempt (e.g. a retried webhook) is a true no-op, not just a dedupe on op_id.
 * A 409 from either leg (amount exceeds the current escrow balance — i.e. this session was
 * already partially or fully settled by a concurrent/earlier call) is not thrown: it is
 * logged via `console.warn`, tracked as `free_session_settle_conflict`, and the function
 * returns normally rather than surfacing an error to the caller.
 */
export async function settleFreeSession(
  env: Env,
  args: { sessionId: string; creatorId: string; kind: FreeSessionKind; capTokens: number; ratePerAttendeeMinute: number },
): Promise<FreeSessionSettlement> {
  const orderId = `free:${args.sessionId}`;
  const capTokens = Math.max(0, Math.trunc(args.capTokens));

  // Idempotent re-entry: a session whose escrow bucket is already empty was already fully
  // settled (fee + refund both landed, or the cap was never funded) — nothing to compute,
  // nothing to move. Distinct from (and cheaper than) the op_id dedupe on the two calls
  // below, which only kicks in once we're already trying to move money.
  if ((await escrowBalance(env, orderId)) === 0) {
    return {
      ok: true, sessionId: args.sessionId, capTokens, minutesBilled: 0, spendTokens: 0,
      refundedTokens: 0, already: true, feeRowOk: true, refundRowOk: true,
    };
  }

  const hostRole = args.kind === "live_event" ? "host" : "creator";
  const row = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(i.connected_ms),0) total_ms
       FROM commercial_participant_intervals i
       JOIN commercial_session_members m
         ON m.commercial_session_id = i.commercial_session_id AND m.account_id = i.account_id
      WHERE i.commercial_session_id = ?1 AND m.role <> ?2
        AND i.reconciliation_state IN ('closed','reconciled')`,
  ).bind(args.sessionId, hostRole).first<{ total_ms: number }>();
  const totalMs = Math.max(0, Math.trunc(Number(row?.total_ms ?? 0)));
  const minutesBilled = Math.ceil(totalMs / 60_000);
  const rawSpend = args.ratePerAttendeeMinute > 0 ? Math.ceil(minutesBilled * args.ratePerAttendeeMinute) : 0;
  const spendTokens = Math.max(0, Math.min(rawSpend, capTokens));
  const refundTokens = capTokens - spendTokens;

  // 1. FEE LEG FIRST — escrow -> platform:fees for the metered spend. See the docstring for
  // why this goes before the refund.
  let feeRowOk = true;
  if (spendTokens > 0) {
    const feeR = await feeFromEscrow(env, orderId, spendTokens, `free-fee:${args.sessionId}`, {
      sessionId: args.sessionId, minutes: minutesBilled, rate: args.ratePerAttendeeMinute, cap: capTokens,
    });
    feeRowOk = feeR.ok;
    if (!feeR.ok) {
      // Only 409 (amount exceeds current escrow balance) is expected here in practice —
      // meaning this session was already settled or partially settled by another call.
      // Treat it as such rather than throwing: log, track, and stop before the refund leg
      // (attempting a refund on top of an unresolved fee outcome risks moving more out of
      // escrow than is actually left).
      console.warn(`settleFreeSession fee leg skipped [${args.sessionId}]:`, feeR.status, JSON.stringify(feeR.body));
      void track(env, args.creatorId, "free_session_settle_conflict", "avaexplore", {
        session_id: args.sessionId, leg: "fee", status: feeR.status, spend: spendTokens,
      }).catch(() => undefined);
      return {
        ok: true, sessionId: args.sessionId, capTokens, minutesBilled, spendTokens,
        refundedTokens: 0, feeRowOk: false, refundRowOk: false,
      };
    }
  }

  // 2. REFUND LEG — escrow -> creator for whatever of the cap went unspent.
  let refunded = 0;
  let refundRowOk = true;
  if (refundTokens > 0) {
    const r = await refund(env, orderId, args.creatorId, refundTokens, {
      opId: `free-refund:${args.sessionId}`,
      reason: "free_session_settlement",
      title: "Free session — unused reserve",
    });
    refundRowOk = r.ok;
    if (r.ok) {
      refunded = refundTokens;
    } else if (r.status === 409) {
      console.warn(`settleFreeSession refund leg skipped [${args.sessionId}]:`, r.status, JSON.stringify(r.body));
      void track(env, args.creatorId, "free_session_settle_conflict", "avaexplore", {
        session_id: args.sessionId, leg: "refund", status: r.status, refund: refundTokens,
      }).catch(() => undefined);
    } else {
      console.warn(`settleFreeSession refund leg failed [${args.sessionId}]:`, r.status, JSON.stringify(r.body));
    }
  }

  void track(env, args.creatorId, "free_session_settled", "avaexplore", {
    session_id: args.sessionId, cap: capTokens, minutes: minutesBilled,
    rate: args.ratePerAttendeeMinute, spend: spendTokens, refunded,
    fee_row_ok: feeRowOk, refund_row_ok: refundRowOk,
  }).catch(() => undefined);

  return {
    ok: feeRowOk && refundRowOk,
    sessionId: args.sessionId,
    capTokens,
    minutesBilled,
    spendTokens,
    refundedTokens: refunded,
    feeRowOk,
    refundRowOk,
  };
}
