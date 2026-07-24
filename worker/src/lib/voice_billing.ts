// [AVABRAIN-VOICE-BILL-1] Server-side billing lifecycle for the personal
// AvaBrain Gemini Live voice path (worker/src/routes/ava_live.ts).
//
// WHY THIS FILE EXISTS — Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md §8/§12:
// ava_live.ts mints a Gemini Live ephemeral token and the client connects
// DIRECTLY to Google's websocket. Unlike do/reception_room.ts (which bridges
// the audio itself and can settle exactly at hangup), the Worker has NO
// server-side witness of the call after the token is handed out. §12 option 2
// is implemented here: an explicit session LEASE the client must renew
// (heartbeat), with server-clock-derived billing so a disconnect, app kill,
// token expiry, or a client that simply stops calling us all converge on the
// SAME outcome — the delivered minutes get billed and the rest is released.
// THE CLIENT IS NEVER THE BILLING AUTHORITY: every amount below is computed
// from `Date.now()` and the lease's own `started_at`/`last_heartbeat_at`
// server timestamps, never from a client-reported duration or minute count.
//
// TARIFF — reuses the EXISTING canonical voice tariff, does not invent one:
// FEATURE_COSTS.ava_receptionist_minute = 3 wallet tokens/min
// (worker/src/feature_pricing.ts). Expressed here as 5 token-HUNDREDTHS per
// second (3*100/60) so a running per-second total can be billed exactly, the
// same trick do/reception_room.ts already uses for its exact per-second
// receptionist settle — this file computes the same math for the lease world.
//
// MONEY PLUMBING — two SEPARATE WalletDO mechanisms, used for two separate
// jobs, exactly as prescribed by the task:
//   1) reserve / release_reservation (the raw escrow ops behind
//      [AVA-CAMP-B1-WALLET], reused as-is — zero changes to do/wallet.ts) is
//      used ONLY as a RUNWAY HOLD: proof the wallet can currently cover the
//      call so far plus a buffer, and a claim that stops some OTHER
//      reservation from racing this session's headroom. It never itself moves
//      real money (reserve() never touches bal.balance).
//   2) feature_pricing.chargeAmount (a real, permanent, idempotent-by-op_id
//      debit — the SAME primitive do/reception_room.ts calls for its exact
//      settle) is used for the ACTUAL billing.
//
// [AVABRAIN-VOICE-BILL-1] SETTLE-ONCE REWRITE (2026-07-24, Opus review fix for
// BLOCKER 1) — the previous version of this file settled INCREMENTALLY on
// every heartbeat: each heartbeat computed `dueTokens` for elapsed-so-far and
// charged `dueTokens - tokens_charged`, with `tokens_charged` updated
// BEST-EFFORT *after* the charge succeeded. Two heartbeats that both read the
// same stale `tokens_charged` (a retried/duplicated heartbeat, or a lost
// D1 write between the charge and the update) each computed their OWN delta
// against that same stale baseline and both charged it — an overlapping-window
// double charge with no idempotency guard, because the op_id
// (`avalive:<sid>:settle:<dueTokens>`) was keyed to the cumulative total, not
// to a single terminal event.
//
// THE FIX mirrors do/reception_room.ts's own proven pattern exactly:
//   - Heartbeats (heartbeatVoiceLease) NEVER charge. They ONLY extend the
//     lease, top up the runway reservation, and record last_heartbeat_at.
//   - The ONE AND ONLY real charge happens in settleOnce(), called from
//     EXACTLY two call sites: closeVoiceLease (graceful end) and
//     reapExpiredVoiceLeases (abandoned lease). Both charge under the SAME
//     static op_id `avalive:<sid>:settle` (no per-level suffix) — so if close
//     and the reaper ever race on the same session, WalletDO's own op_id
//     idempotency dedupes them into a single real debit instead of two.
//   - The runway reservation is released under the SAME static op_id
//     `avalive:<sid>:release` from both call sites for the identical reason.
//
// FLAGS:
//   - `avaBrainVoiceBillingEnabled` (routes/config.ts; NOT declared by this
//     file, see the report to the coordinator) — master kill switch.
//     Undefined/false = today's behavior unchanged: ava_live.ts mints a token
//     with NO lease, NO reservation, NO charge — byte-for-byte the
//     pre-existing dark path.
//   - `avaBrainVoiceBillingLive` (routes/config.ts; NEW, NOT declared by this
//     file — same "report to coordinator, do not edit config.ts" contract.
//     Boolean, undefined→false, no numericKeys entry needed) — mirrors
//     [RECEPT-BILLING-LIVE-1]'s `receptBillingLive`: passed as `forceMeter`
//     into the ONE settle charge so this single feature can be billed for
//     real during `betaFreePremium` without un-freeing the whole platform.
//     See SHOULD-FIX 7 below for the full beta interplay.
//
// SHOULD-FIX 6 (team billing) — the wallet that ADMITS the call (reserve/402
// at session start) must be the SAME wallet that ultimately PAYS for it
// (chargeAmount at settle), or a team member's admission check reads their
// OWN wallet while the real charge silently lands on the team wallet (or vice
// versa on a race). `payer = billingUidFor(env, uid)` is resolved ONCE at
// lease start and persisted on the lease row (`payer_uid`); every reserve/
// top-up/402/charge/release for that session uses `lease.payer_uid`, never
// re-resolved mid-call (a mid-call team join/leave must not change which
// wallet a session bills to).
//
// SHOULD-FIX 7 (betaFreePremium interplay) — chargeAmount already short-
// circuits to `{ok:true, charged:0}` under betaFreePremium unless
// `forceMeter` is passed, so a bare settle-once call would already charge $0
// during beta. But the ADMISSION side (reserve/402) does NOT know about
// betaFreePremium at all — it would still block a genuinely low-balance beta
// user from a call that, once placed, wouldn't have cost them anything. FIX:
// `reservationsActive = enabled && (live || !beta)` — while betaFreePremium
// is on and avaBrainVoiceBillingLive is NOT forcing real billing, the
// reserve()/402 admission gate (and the heartbeat runway top-up) are skipped
// entirely: the call is free, so it must never be blocked on wallet balance.
// The lease row (and heartbeat/close bookkeeping) still exist so the feature
// keeps working end-to-end and telemetry stays intact; only the wallet-hold
// side is skipped.
//
// NIT 13 (fail-open 404s) — `startVoiceLease` can return `metered:false` with
// NO lease row (billing off, or a lease-plumbing error faled open) — see
// ava_live.ts, which already forwards `metered` in the /token response so the
// client knows not to heartbeat. But if a client heartbeats/closes anyway
// (e.g. an older client, or a race), `heartbeatVoiceLease`/`closeVoiceLease`
// must not surface that as an error — a missing lease row when billing is
// off/unmetered is the EXPECTED shape, not a 404. Both now return
// `{ok:true, metered:false, found:false}` in that case; only a genuine
// ownership mismatch (`not_owner`) is still an error.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { walletOp } from "../routes/wallet";
import { chargeAmount } from "../feature_pricing";
import { billingUidFor } from "../team_billing";
import { trackUserContact, trackException } from "../hooks";

// ---------------------------------------------------------------------------
// Tariff constants — DERIVED from feature_pricing.FEATURE_COSTS.ava_receptionist_minute
// (3 tokens/min), never a second hardcoded price. If that price ever changes,
// this file's math changes with it automatically; there is exactly one number
// to tune, and it lives in feature_pricing.ts, not here.
// ---------------------------------------------------------------------------
import { FEATURE_COSTS } from "../feature_pricing";

const VOICE_TARIFF_TOKENS_PER_MIN = FEATURE_COSTS.ava_receptionist_minute; // 3 — the canonical voice tariff, reused not duplicated
const HUNDREDTHS_PER_SEC = (VOICE_TARIFF_TOKENS_PER_MIN * 100) / 60; // 5 token-hundredths/sec, matches do/reception_room.ts's own derivation

// ---------------------------------------------------------------------------
// Lease timing. All values are the SERVER's own clock; the client is only
// ever told the hint so it knows how often to call us, never asked to report
// elapsed time itself.
// ---------------------------------------------------------------------------

/** How often the client SHOULD call /api/ava/live/heartbeat while a call is live. Advisory only — the reaper below is what actually enforces the budget. */
export const HEARTBEAT_INTERVAL_HINT_MS = 20_000;
/** If no heartbeat/close lands within this long after the last proof-of-life, the lease is reapable. ~3.75x the hint so ordinary jitter, a brief backgrounding, or one dropped heartbeat never falsely reaps a live call. */
export const LEASE_TIMEOUT_MS = 75_000;
/** Runway buffer kept reserved AHEAD of tokens due for elapsed time so far, so the wallet is never surprised by concurrent spend elsewhere draining it mid-call, before the one real settle charge lands at close/reap. */
const RESERVE_BUFFER_MINUTES = 1;
const RESERVE_BUFFER_TOKENS = VOICE_TARIFF_TOKENS_PER_MIN * RESERVE_BUFFER_MINUTES;
/** Bound on how many of a user's OWN stale leases get opportunistically reaped on each mint/heartbeat call (see reapExpiredVoiceLeases). Keeps that query cheap and bounded even if a user has many abandoned sessions. */
const LAZY_REAP_LIMIT = 5;

/**
 * Reads the three config bits this file cares about EXACTLY ONCE per call
 * site, fails CLOSED into "not metered, no reservation" on a config-read
 * outage (mirrors ai_billing.ts's meteringOn()) — a billing outage must never
 * turn into an unexpected wallet hold/charge, nor into a wrongly-blocked call.
 */
async function billingState(env: Env): Promise<{ enabled: boolean; live: boolean; reservationsActive: boolean }> {
  try {
    const cfg: any = await readConfig(env);
    const enabled = cfg?.avaBrainVoiceBillingEnabled === true;
    const live = cfg?.avaBrainVoiceBillingLive === true;
    const beta = cfg?.betaFreePremium === true;
    // SHOULD-FIX 7: free during beta unless forced live → never hold/gate on
    // wallet balance for a call that will ultimately be charged $0 anyway.
    const reservationsActive = enabled && (live || !beta);
    return { enabled, live, reservationsActive };
  } catch {
    return { enabled: false, live: false, reservationsActive: false };
  }
}

function refFor(sessionId: string): string {
  return `avalive:${sessionId}`;
}

function tokensDueForElapsedMs(elapsedMs: number): number {
  const elapsedSec = Math.max(0, elapsedMs / 1000);
  const hundredths = Math.ceil(elapsedSec * HUNDREDTHS_PER_SEC);
  return Math.ceil(hundredths / 100);
}

// ---------------------------------------------------------------------------
// D1 lease row I/O (DB_WALLET binding — shared with ai_billing_ledger.sql /
// wallet_ledger.sql; no new D1 database). See migrations/
// 2026-07-24-avabrain-voice-leases.sql for the schema and full rationale.
// ---------------------------------------------------------------------------

export interface VoiceLeaseRow {
  session_id: string;
  uid: string;
  /** [AVABRAIN-VOICE-BILL-1 SHOULD-FIX 6] The wallet that ADMITTED and PAYS for
   * this session, resolved ONCE at lease start via billingUidFor(uid) and
   * persisted here — every reserve/top-up/charge/release for this session
   * uses this, not a re-resolved value, so admission and settlement can never
   * land on two different wallets. */
  payer_uid: string;
  email: string | null;
  status: "active" | "closed" | "reaped" | "blocked";
  started_at: number;
  last_heartbeat_at: number;
  lease_expires_at: number;
  tokens_reserved_cum: number;
  /** Cumulative wallet tokens PERMANENTLY charged for this session. Stays 0
   * for the entire life of an active lease — the ONLY write to this column
   * happens once, at settleOnce() (close or reap), per BLOCKER 1's fix. */
  tokens_charged: number;
  close_reason: string | null;
  closed_at: number | null;
}

async function getLease(env: Env, sessionId: string): Promise<VoiceLeaseRow | null> {
  const row = await env.DB_WALLET.prepare(
    `SELECT session_id, uid, payer_uid, email, status, started_at, last_heartbeat_at, lease_expires_at,
            tokens_reserved_cum, tokens_charged, close_reason, closed_at
       FROM avabrain_voice_leases WHERE session_id = ?1`,
  ).bind(sessionId).first<VoiceLeaseRow>();
  return row ?? null;
}

async function insertLease(env: Env, row: {
  sessionId: string; uid: string; payerUid: string; email: string | null; now: number; tokensReserved: number;
}): Promise<void> {
  await env.DB_WALLET.prepare(
    `INSERT INTO avabrain_voice_leases
       (session_id, uid, payer_uid, email, status, started_at, last_heartbeat_at, lease_expires_at,
        tokens_reserved_cum, tokens_charged, close_reason, closed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5, ?6, ?7, 0, NULL, NULL, ?5, ?5)`,
  ).bind(
    row.sessionId, row.uid, row.payerUid, row.email, row.now, row.now + LEASE_TIMEOUT_MS, row.tokensReserved,
  ).run();
}

async function updateLeaseProgress(env: Env, sessionId: string, patch: {
  now: number; tokensReservedCum: number;
}): Promise<void> {
  await env.DB_WALLET.prepare(
    `UPDATE avabrain_voice_leases
        SET last_heartbeat_at = ?2, lease_expires_at = ?2 + ${LEASE_TIMEOUT_MS},
            tokens_reserved_cum = ?3, updated_at = ?2
      WHERE session_id = ?1 AND status = 'active'`,
  ).bind(sessionId, patch.now, patch.tokensReservedCum).run();
}

async function closeLease(env: Env, sessionId: string, patch: {
  now: number; tokensCharged: number; status: "closed" | "reaped" | "blocked"; reason: string;
}): Promise<void> {
  await env.DB_WALLET.prepare(
    `UPDATE avabrain_voice_leases
        SET status = ?2, close_reason = ?3, closed_at = ?4, tokens_charged = ?5, updated_at = ?4
      WHERE session_id = ?1 AND status = 'active'`,
  ).bind(sessionId, patch.status, patch.reason, patch.now, patch.tokensCharged).run();
}

// ---------------------------------------------------------------------------
// THE ONE settle step — computes the exact tokens due for the FULL proven
// call duration (from lease.started_at to `endMs`) and charges that ENTIRE
// amount, ONCE, under a static per-session op_id. Called from EXACTLY two
// places: closeVoiceLease (endMs = now) and reapExpiredVoiceLeases
// (endMs = lease.last_heartbeat_at, the last proven instant). Never called
// from heartbeatVoiceLease — see BLOCKER 1 in this file's header.
// ---------------------------------------------------------------------------
async function settleOnce(
  env: Env, lease: VoiceLeaseRow, endMs: number, forceMeter: boolean,
): Promise<{ chargedNow: number; tokensCharged: number; ok: boolean }> {
  const elapsedMs = Math.max(0, endMs - lease.started_at);
  const dueTokens = tokensDueForElapsedMs(elapsedMs);
  if (dueTokens <= 0) return { chargedNow: 0, tokensCharged: 0, ok: true };

  const durationSec = Math.round(elapsedMs / 1000);
  const r = await chargeAmount(env, lease.payer_uid, "ava_receptionist_minute", dueTokens,
    // Static op_id per session — the WHOLE call is charged in exactly one
    // chargeAmount call, ever. A retried close, or the reaper racing close on
    // the same session, reproduce this SAME op_id and dedupe in WalletDO
    // instead of each computing+charging their own (possibly different, since
    // endMs differs) delta — see BLOCKER 1.
    `avalive:${lease.session_id}:settle`,
    {
      // [RECEPT-BILLING-LIVE-1]-style escape hatch (SHOULD-FIX 7): lets THIS
      // feature charge for real during betaFreePremium without un-freeing the
      // whole platform. Undefined/false → chargeAmount's own betaFreePremium
      // short-circuit applies and this charges $0, exactly like every other
      // feature during the free launch.
      forceMeter,
      meta: {
        category: "call",
        context: "AvaBrain personal voice call",
        durationSec,
        ratePerMin: VOICE_TARIFF_TOKENS_PER_MIN,
      },
    });
  if (!r.ok) {
    // Insufficient wallet at settle time. Do NOT throw — the caller (close/
    // reaper) still needs to record the terminal "blocked" state and release
    // the reservation.
    return { chargedNow: 0, tokensCharged: 0, ok: false };
  }
  return { chargedNow: r.charged ?? dueTokens, tokensCharged: dueTokens, ok: true };
}

// ---------------------------------------------------------------------------
// 1) START — called from ava_live.ts BEFORE minting the Gemini Live token.
// ---------------------------------------------------------------------------

export interface StartVoiceLeaseResult {
  ok: boolean;
  metered: boolean;
  sessionId: string;
  error?: "insufficient_balance";
  balance?: number;
  needed?: number;
}

/**
 * Wallet runway check + session lease admission (bible §12 option 2, step 1).
 * When the flag is off, this is a pure no-op that always admits — mirrors
 * ai_billing.ts's dark-by-default contract exactly, so wiring this call into
 * ava_live.ts changes NOTHING until the owner flips
 * `avaBrainVoiceBillingEnabled` on. [NIT 13] When it returns
 * `{metered:false}`, NO lease row is created — ava_live.ts forwards `metered`
 * to the client so it knows not to heartbeat, and heartbeat/close both treat
 * a missing row as the expected unmetered shape, not an error.
 */
export async function startVoiceLease(env: Env, input: { uid: string; email: string | null }): Promise<StartVoiceLeaseResult> {
  const sessionId = crypto.randomUUID(); // server-generated — the client never chooses/collides a session id
  const state = await billingState(env);
  if (!state.enabled) return { ok: true, metered: false, sessionId };

  // Lazy reap: settle/release this user's OWN abandoned leases first, so a
  // string of prior dropped calls never blocks this new one's reservation
  // headroom from being admitted. Best-effort — a reap failure must never
  // block a legitimate new call.
  await reapExpiredVoiceLeases(env, { uid: input.uid, limit: LAZY_REAP_LIMIT }).catch(() => {});

  // SHOULD-FIX 6: resolve the paying wallet ONCE, persist it, use it for
  // EVERY wallet op this session ever makes (reserve/top-up/charge/release).
  const payer = await billingUidFor(env, input.uid).catch(() => input.uid);
  const now = Date.now();
  const ref = refFor(sessionId);

  let reserveAmount = 0;
  if (state.reservationsActive) {
    reserveAmount = RESERVE_BUFFER_TOKENS; // 1 minute of runway held upfront
    const reserved = await walletOp(env, payer, {
      op: "reserve", uid: payer, amount: reserveAmount, ref,
      op_id: `avalive:${sessionId}:reserve:to:${reserveAmount}`, app_name: "avabrain_voice",
    }).catch((e) => {
      void trackException(env, e, { uid: input.uid, route: "voice_billing.startVoiceLease", method: "walletOp.reserve", handled: true, extra: { session_id: sessionId, payer_uid: payer } });
      return null;
    });

    if (!reserved || reserved.status === 402 || reserved.body?.ok !== true) {
      const balance = Number(reserved?.body?.available ?? reserved?.body?.balance ?? 0);
      return { ok: false, metered: true, sessionId, error: "insufficient_balance", balance, needed: reserveAmount };
    }
  }
  // else: SHOULD-FIX 7 — betaFreePremium (and not forced live): the call is
  // free, so admission is NEVER gated on wallet balance. The lease row is
  // still created below (tokensReserved=0) so heartbeat/close/telemetry keep
  // working end-to-end.

  await insertLease(env, { sessionId, uid: input.uid, payerUid: payer, email: input.email, now, tokensReserved: reserveAmount }).catch(async (e) => {
    // Lease row failed to persist but the wallet hold (if any) succeeded —
    // release it immediately rather than leaking an orphaned, never-billed
    // reservation.
    if (reserveAmount > 0) {
      await walletOp(env, payer, { op: "release_reservation", uid: payer, ref, op_id: `avalive:${sessionId}:release:insert-failed`, app_name: "avabrain_voice" }).catch(() => {});
    }
    throw e;
  });

  return { ok: true, metered: true, sessionId };
}

// ---------------------------------------------------------------------------
// 2) HEARTBEAT — the client calls this every HEARTBEAT_INTERVAL_HINT_MS while
//    the Gemini Live call is up. Extends the lease and tops up the runway
//    reservation. [BLOCKER 1] Heartbeats NEVER charge — the one and only real
//    charge happens once, at close or reap, via settleOnce().
// ---------------------------------------------------------------------------

export interface HeartbeatVoiceLeaseResult {
  ok: boolean;
  metered: boolean;
  found: boolean;
  tokensCharged: number;
  chargedNow: number;
  elapsedSec: number;
  error?: "insufficient_balance" | "not_owner";
  leaseTimeoutMs?: number;
}

export async function heartbeatVoiceLease(env: Env, input: { uid: string; sessionId: string }): Promise<HeartbeatVoiceLeaseResult> {
  const state = await billingState(env);
  if (!state.enabled) return { ok: true, metered: false, found: true, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 };

  const lease = await getLease(env, input.sessionId);
  // [NIT 13] No lease row (billing was off at session start, or start failed
  // open) is the EXPECTED unmetered shape here, not an error — the client is
  // simply heartbeating a session it was already told not to meter.
  if (!lease) return { ok: true, metered: false, found: false, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 };
  if (lease.uid !== input.uid) return { ok: false, metered: true, found: false, tokensCharged: 0, chargedNow: 0, elapsedSec: 0, error: "not_owner" };
  if (lease.status !== "active") {
    // Already closed/reaped (e.g. a race with the reaper, or a duplicate
    // heartbeat after close) — report the last known charge, not an error;
    // the client should stop calling us.
    return { ok: true, metered: true, found: true, tokensCharged: lease.tokens_charged, chargedNow: 0, elapsedSec: Math.round((lease.closed_at ?? lease.last_heartbeat_at) - lease.started_at) / 1000 };
  }

  const now = Date.now();
  const ref = refFor(input.sessionId);

  // Top up the runway reservation so it always sits RESERVE_BUFFER_TOKENS
  // ahead of tokens DUE for elapsed time so far (not "tokens charged" — that
  // stays 0 until the one real settle at close/reap, so it can no longer be
  // used as the runway baseline). reserve() is ADDITIVE per ref, so only the
  // incremental top-up is sent, never the running total.
  let tokensReservedCum = lease.tokens_reserved_cum;
  let reserveInsufficient = false;
  if (state.reservationsActive) {
    const elapsedMs = Math.max(0, now - lease.started_at);
    const projectedDue = tokensDueForElapsedMs(elapsedMs);
    const reserveTarget = projectedDue + RESERVE_BUFFER_TOKENS;
    const topUp = Math.max(0, reserveTarget - lease.tokens_reserved_cum);
    if (topUp > 0) {
      const reserved = await walletOp(env, lease.payer_uid, {
        op: "reserve", uid: lease.payer_uid, amount: topUp, ref,
        op_id: `avalive:${input.sessionId}:reserve:to:${reserveTarget}`, app_name: "avabrain_voice",
      }).catch((e) => {
        void trackException(env, e, { uid: input.uid, route: "voice_billing.heartbeatVoiceLease", method: "walletOp.reserve", handled: true, extra: { session_id: input.sessionId, payer_uid: lease.payer_uid } });
        return null;
      });
      if (reserved && reserved.status === 200 && reserved.body?.ok === true) {
        tokensReservedCum = reserveTarget;
      } else if (reserved && reserved.status === 402) {
        // Not fatal to the heartbeat itself (no charge happens here either
        // way) — but surfaced below so the client can proactively end a call
        // it's about to be blocked on at close/reap.
        reserveInsufficient = true;
      }
    }
  }

  await updateLeaseProgress(env, input.sessionId, { now, tokensReservedCum }).catch(() => {});

  const elapsedSec = Math.round((now - lease.started_at) / 1000);
  if (reserveInsufficient) {
    return { ok: false, metered: true, found: true, tokensCharged: lease.tokens_charged, chargedNow: 0, elapsedSec, error: "insufficient_balance", leaseTimeoutMs: LEASE_TIMEOUT_MS };
  }
  return { ok: true, metered: true, found: true, tokensCharged: lease.tokens_charged, chargedNow: 0, elapsedSec, leaseTimeoutMs: LEASE_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// 3) CLOSE — the client calls this on any graceful end (user hangs up, app
//    backgrounds/minimizes intentionally, token nearing expiry, client-side
//    error). The ONE real settle (settleOnce) + full release of the runway
//    hold.
// ---------------------------------------------------------------------------

export interface CloseVoiceLeaseResult {
  ok: boolean;
  metered: boolean;
  found: boolean;
  tokensCharged: number;
  chargedNow: number;
  elapsedSec: number;
}

export async function closeVoiceLease(env: Env, input: { uid: string; sessionId: string; reason: string }): Promise<CloseVoiceLeaseResult> {
  const state = await billingState(env);
  if (!state.enabled) return { ok: true, metered: false, found: true, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 };

  const lease = await getLease(env, input.sessionId);
  // [NIT 13] No lease row / not this owner → nothing to settle, and nothing
  // was ever metered for this caller's view of this session.
  if (!lease || lease.uid !== input.uid) return { ok: true, metered: false, found: false, tokensCharged: 0, chargedNow: 0, elapsedSec: 0 };
  if (lease.status !== "active") {
    // Idempotent: a retried close (or a close racing the reaper) is a no-op
    // replay of the already-recorded terminal state.
    return { ok: true, metered: true, found: true, tokensCharged: lease.tokens_charged, chargedNow: 0, elapsedSec: Math.round(((lease.closed_at ?? lease.last_heartbeat_at) - lease.started_at) / 1000) };
  }

  const now = Date.now();
  const settle = await settleOnce(env, lease, now, state.live);
  const ref = refFor(input.sessionId);
  // Always release whatever remains reserved — reserve() never touched real
  // balance, this only frees escrow headroom back to the wallet. Idempotent
  // by op_id (same static ref as the reaper uses — see BLOCKER 1); safe even
  // if settle above failed, and safe even if nothing was ever reserved
  // (betaFreePremium/!live path).
  await walletOp(env, lease.payer_uid, { op: "release_reservation", uid: lease.payer_uid, ref, op_id: `avalive:${input.sessionId}:release`, app_name: "avabrain_voice" }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "voice_billing.closeVoiceLease", method: "walletOp.release_reservation", handled: true, extra: { session_id: input.sessionId, payer_uid: lease.payer_uid } });
  });

  await closeLease(env, input.sessionId, {
    now, tokensCharged: settle.tokensCharged, status: settle.ok ? "closed" : "blocked",
    reason: settle.ok ? input.reason : "wallet_blocked",
  }).catch(() => {});

  const elapsedSec = Math.round((now - lease.started_at) / 1000);
  return { ok: true, metered: true, found: true, tokensCharged: settle.tokensCharged, chargedNow: settle.chargedNow, elapsedSec };
}

// ---------------------------------------------------------------------------
// 4) REAPER — settles (ONCE, via settleOnce) + releases leases nobody has
//    heartbeat/closed in time. Called (a) LAZILY, scoped to one uid, from
//    startVoiceLease above (so an abandoned session's hold clears the moment
//    that user starts another call) and (b) is exported here ready for a
//    GLOBAL sweep from a Cron Trigger, which is NOT wired yet — see this
//    file's header/the report to the coordinator: wrangler.toml needs a
//    `[triggers] crons` entry and index.ts needs a `scheduled()` export
//    calling this with no `uid` filter. Until that trigger exists, the lazy
//    per-uid reap is the only thing that runs, which bounds staleness to
//    "next time this same user touches AvaBrain voice again" rather than a
//    fixed wall-clock SLA.
// ---------------------------------------------------------------------------

export interface ReapResult {
  scanned: number;
  reaped: number;
}

export async function reapExpiredVoiceLeases(env: Env, opts: { uid?: string; limit?: number } = {}): Promise<ReapResult> {
  const now = Date.now();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const rows = opts.uid
    ? await env.DB_WALLET.prepare(
        `SELECT session_id, uid, payer_uid, email, status, started_at, last_heartbeat_at, lease_expires_at,
                tokens_reserved_cum, tokens_charged, close_reason, closed_at
           FROM avabrain_voice_leases
          WHERE uid = ?1 AND status = 'active' AND lease_expires_at < ?2
          ORDER BY lease_expires_at ASC LIMIT ?3`,
      ).bind(opts.uid, now, limit).all<VoiceLeaseRow>()
    : await env.DB_WALLET.prepare(
        `SELECT session_id, uid, payer_uid, email, status, started_at, last_heartbeat_at, lease_expires_at,
                tokens_reserved_cum, tokens_charged, close_reason, closed_at
           FROM avabrain_voice_leases
          WHERE status = 'active' AND lease_expires_at < ?1
          ORDER BY lease_expires_at ASC LIMIT ?2`,
      ).bind(now, limit).all<VoiceLeaseRow>();

  const leases = rows.results ?? [];
  // Read the live-billing flag ONCE for the whole sweep batch, not per row —
  // a flag flip mid-sweep affecting a handful of rows in one batch is an
  // acceptable edge case (mirrors reading it once per settle call elsewhere).
  const state = await billingState(env);
  let reaped = 0;
  for (const lease of leases) {
    try {
      // Conservative: bill only up to the LAST PROVEN instant (last_heartbeat_at),
      // never past it — we have no proof of life beyond that timestamp, so we
      // must not charge for time we cannot attribute to a live call.
      const settle = await settleOnce(env, lease, lease.last_heartbeat_at, state.live);
      const ref = refFor(lease.session_id);
      // Same STATIC op_id as closeVoiceLease uses (see BLOCKER 1) — a close
      // racing this reap on the same session dedupes instead of double-firing.
      await walletOp(env, lease.payer_uid, { op: "release_reservation", uid: lease.payer_uid, ref, op_id: `avalive:${lease.session_id}:release`, app_name: "avabrain_voice" }).catch((e) => {
        void trackException(env, e, { uid: lease.uid, route: "voice_billing.reapExpiredVoiceLeases", method: "walletOp.release_reservation", handled: true, extra: { session_id: lease.session_id, payer_uid: lease.payer_uid } });
      });
      await closeLease(env, lease.session_id, {
        now, tokensCharged: settle.tokensCharged, status: settle.ok ? "reaped" : "blocked",
        reason: settle.ok ? "lease_expired_no_heartbeat" : "wallet_blocked",
      }).catch(() => {});
      const elapsedSec = Math.round((lease.last_heartbeat_at - lease.started_at) / 1000);
      void trackUserContact(env, lease.uid, lease.email, null, "avabrain_voice_session_closed", "avabrain_voice", {
        session_id: lease.session_id, reason: "lease_expired_no_heartbeat",
        minutes: Math.ceil(elapsedSec / 60), elapsed_sec: elapsedSec,
        wallet_tokens_charged: settle.tokensCharged, wallet_blocked: !settle.ok,
      });
      reaped++;
    } catch (e) {
      void trackException(env, e, { uid: lease.uid, route: "voice_billing.reapExpiredVoiceLeases", handled: true, extra: { session_id: lease.session_id } });
    }
  }
  return { scanned: leases.length, reaped };
}

export { VOICE_TARIFF_TOKENS_PER_MIN };
