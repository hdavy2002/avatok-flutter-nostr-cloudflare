// [HF-WALLET-EXIT-1 2026-10-10] Pay-out-first account closure. Rulebook: HF-PAY-14.
// A user with REAL money (paid wallet balance, held earnings, or an open payout/refund) cannot delete their account until the money
// is settled: deletion is PAUSED and the user is sent to /account/close. Starting the exit creates, automatically:
//   * a host payout for the withdrawable earnings (exit payout: skips the Rs500 minimum and the weekly cap; still needs admin approval + UTR),
//   * a refund request for the unused top-up money (exit refund: no 180-day limit; money no gateway can carry is paid by hand),
//   * and, if earnings are still inside the 7-day hold, a wait; the cron makes the exit payout once the hold ends.
// When every exit payout/refund is paid (or rejected by an admin with a reason) the cron triggers the normal deletion.
// Test credits and test earnings are simply dropped. Users with no real money (or no HF footprint at all) delete as before.
import type { Env } from "../types";
import { walletOp } from "../routes/wallet";
import { readConfig } from "../routes/config";
import { tryDecryptPii } from "./pii_crypto";
import { trackException, track } from "../hooks";
import {
  WALLET_APP as PAYOUT_APP, HOLD_MS, refFor, reserveOpId, releaseOpId, hostPayoutReadiness, withdrawableFor, sumMaturedCallRupees, payoutSums,
} from "./hf_payouts";
import { createRefundRequest, cancelRefund, refundableFor, DEFAULT_REFUND_WINDOW_DAYS, OPEN_REFUND_STATUSES, type RefundRow } from "./hf_refunds";
import { getTestBalance } from "./hf_credits";
import { hfTokensOn, tokenExitSummary, createExitPayoutTokens, cancelExitPayoutTokens, finishTokenExit, refundIdsOf, type TokenExitExtra } from "./hf_exit_tokens"; // [HF-TOK-EXIT-1]
import { requestPlayRefunds, cancelPlayRefund, hasActiveCall } from "./hf_play_refunds"; // [HF-TOK-EXIT-1]
import { hostSummary, wholeRupees, isHostLedgerRef } from "./hf_host_ledger"; // [HF-TOK-EXIT-1]

export type ExitStatus = "waiting_hold" | "waiting_payouts" | "ready" | "done" | "cancelled";
export const ACTIVE_EXIT: ExitStatus[] = ["waiting_hold", "waiting_payouts", "ready"];
export const isActiveExit = (s: string | null | undefined) => (ACTIVE_EXIT as string[]).includes(String(s));

export interface ExitFlags { refundsEnabled: boolean; windowDays: number; gateEnabled: boolean }
export function exitFlagsFrom(c: Record<string, unknown>): ExitFlags {
  const days = Number(c.hfRefundWindowDays);
  return {
    refundsEnabled: c.hfRefundsEnabled === true,
    windowDays: Number.isFinite(days) && days >= 1 && days <= 3650 ? Math.floor(days) : DEFAULT_REFUND_WINDOW_DAYS,
    gateEnabled: c.hfExitGateEnabled !== false, // default ON; only an explicit false switches it off
  };
}
export async function exitFlags(env: Env): Promise<ExitFlags> {
  try { return exitFlagsFrom((await readConfig(env)) as unknown as Record<string, unknown>); }
  catch { return exitFlagsFrom({}); }
}

// ── pure decisions ───────────────────────────────────────────────────────────
export interface GateInput { gateEnabled: boolean; isHfUser: boolean; hasMoney: boolean; exitStatus: string | null }
/** "exit" = pause deletion and send the user to /account/close; "delete" = go ahead as before. */
export function decideDeletion(i: GateInput): "delete" | "exit" {
  if (!i.gateEnabled) return "delete";
  if (isActiveExit(i.exitStatus)) return "exit";
  if (!i.isHfUser) return "delete";
  return i.hasMoney ? "exit" : "delete";
}

// "cancelled" is deliberately NOT settled: the user cancelling a linked request must never let the account be deleted behind their back
// (cancelExit marks the exit row cancelled itself, afterwards).
const TERMINAL_PAYOUT = ["paid", "rejected"];
const TERMINAL_REFUND = ["refunded", "rejected"];
export type ExitStep = "wait_hold" | "make_payout" | "wait_payouts" | "trigger_deletion";
/**
 * Pure. What the cron should do for one exit row.
 *  - still held earnings -> keep waiting
 *  - hold over and no payout made yet -> make it
 *  - payout/refund still open -> keep waiting
 *  - everything settled -> trigger deletion
 */
export function nextExitStep(i: { status: ExitStatus; held: number; hasPayout: boolean; payoutStatus: string | null; refundStatus: string | null }): ExitStep {
  if (i.status === "ready") return "trigger_deletion";
  if (i.status === "waiting_hold") {
    if (i.held > 0) return "wait_hold";
    if (!i.hasPayout) return "make_payout";
  }
  const payoutDone = !i.hasPayout || (i.payoutStatus != null && TERMINAL_PAYOUT.includes(i.payoutStatus));
  const refundDone = i.refundStatus == null || TERMINAL_REFUND.includes(i.refundStatus);
  return payoutDone && refundDone ? "trigger_deletion" : "wait_payouts";
}

// ── summary ──────────────────────────────────────────────────────────────────
const tsMs = (col: string) => `(CASE WHEN ${col} < 100000000000 THEN ${col} * 1000 ELSE ${col} END)`;
export interface ExitRow { uid: string; status: ExitStatus; requested_at: number; updated_at: number; payout_id: string | null; refund_id: string | null; note: string | null; /** [HF-TOK-EXIT-1] JSON array of play_refund ids; NULL = a closure made without tokens. */ refund_ids?: string | null }

export interface ExitSummary {
  isHfUser: boolean;
  hasMoney: boolean;
  paidBalance: number;
  withdrawable: number;
  held: number;
  heldReleaseAt: number | null;
  refundable: number;
  /** Unused top-up money no gateway can return (too old, or no top-up behind it): an admin pays it by hand. */
  manualRefund: number;
  /** Money that will be lost unless the user fixes it first: no verified bank for earnings, or money nothing can account for. */
  forfeitRupees: number;
  bankOk: boolean;
  testCredits: number;
  testEarnings: number;
  openPayouts: number;
  openRefunds: number;
  /** [HF-TOK-EXIT-1] Present only when tokens are on: the token view of the same money. */
  tokensInfo?: TokenExitExtra;
  exit: { status: ExitStatus; payoutId: string | null; refundId: string | null; note: string | null; requestedAt: number } | null;
}

async function anyRow(env: Env, sql: string, uid: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare(sql).bind(uid).first()); } catch { return false; }
}
/** Does this account have any HF money footprint at all? (A legacy-platform user with an old wallet balance must not be pulled in.) */
export async function hasHfFootprint(env: Env, uid: string): Promise<boolean> {
  const checks = [
    "SELECT 1 FROM hf_topups WHERE uid=?1 AND status='paid' LIMIT 1",
    "SELECT 1 FROM hf_hosts WHERE uid=?1 LIMIT 1",
    "SELECT 1 FROM hf_calls WHERE caller_uid=?1 OR host_uid=?1 LIMIT 1",
    "SELECT 1 FROM hf_payout_requests WHERE host_uid=?1 LIMIT 1",
    "SELECT 1 FROM hf_refund_requests WHERE uid=?1 LIMIT 1",
    "SELECT 1 FROM hf_exit_requests WHERE uid=?1 LIMIT 1",
  ];
  for (const q of checks) if (await anyRow(env, q, uid)) return true;
  return false;
}

export async function getExitRow(env: Env, uid: string): Promise<ExitRow | null> {
  return (await env.DB_META.prepare("SELECT * FROM hf_exit_requests WHERE uid=?1").bind(uid).first<ExitRow>().catch(() => null)) ?? null;
}

/** Throws when the wallet cannot be read for an HF user (money screens must not guess). */
export async function exitSummary(env: Env, uid: string, now = Date.now()): Promise<ExitSummary> {
  const exitRow = await getExitRow(env, uid);
  const isHf = (await hasHfFootprint(env, uid));
  const empty: ExitSummary = {
    isHfUser: isHf, hasMoney: false, paidBalance: 0, withdrawable: 0, held: 0, heldReleaseAt: null, refundable: 0, manualRefund: 0, forfeitRupees: 0,
    bankOk: false, testCredits: 0, testEarnings: 0, openPayouts: 0, openRefunds: 0,
    exit: exitRow ? { status: exitRow.status, payoutId: exitRow.payout_id, refundId: exitRow.refund_id, note: exitRow.note, requestedAt: exitRow.requested_at } : null,
  };
  if (await hfTokensOn(env)) return tokenExitSummary(env, uid, now, empty, isHf); // [HF-TOK-EXIT-1] lots + host ledger instead of the WalletDO
  if (!isHf) return empty;
  const [w, r, ready, tc, op, orf, lastEnd] = await Promise.all([
    withdrawableFor(env, uid, now),
    refundableFor(env, uid, null, now),
    hostPayoutReadiness(env, uid),
    getTestBalance(env, uid).catch(() => ({ balance: 0, reserved: 0 })),
    env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved')").bind(uid).first<{ n: number }>().catch(() => null),
    env.DB_META.prepare(`SELECT COUNT(*) AS n FROM hf_refund_requests WHERE uid=?1 AND status IN (${OPEN_REFUND_STATUSES.map((s) => `'${s}'`).join(",")})`).bind(uid).first<{ n: number }>().catch(() => null),
    env.DB_META.prepare(`SELECT MAX(${tsMs("ended_at")}) AS t FROM hf_calls WHERE host_uid=?1 AND host_paid_rupees IS NOT NULL AND ended_at IS NOT NULL`).bind(uid).first<{ t: number | null }>().catch(() => null),
  ]);
  const paidBalance = w.walletBalance + w.held;
  const openPayouts = Number(op?.n ?? 0), openRefunds = Number(orf?.n ?? 0);
  const manualRefund = Math.max(0, r.callerMoney - r.refundable);
  const hostMoney = w.withdrawable + w.held;
  // What the wallet holds, piece by piece: free earnings + held earnings + money set aside for open payouts + the caller's own money
  // (callerMoney already nets out open refund reservations, so add those back). Whatever is left over is unexplained.
  const openRefundMoney = await env.DB_META.prepare(`SELECT COALESCE(SUM(amount_rupees),0) AS s FROM hf_refund_requests WHERE uid=?1 AND status IN (${OPEN_REFUND_STATUSES.map((s) => `'${s}'`).join(",")})`)
    .bind(uid).first<{ s: number }>().catch(() => null);
  const accounted = w.withdrawable + w.held + w.openReserved + r.callerMoney + Number(openRefundMoney?.s ?? 0);
  const unaccounted = Math.max(0, paidBalance - accounted);
  const forfeitRupees = (ready.bankOk ? 0 : hostMoney) + unaccounted;
  const heldReleaseAt = w.held > 0 && lastEnd?.t ? Number(lastEnd.t) + HOLD_MS : null;
  return {
    ...empty, isHfUser: true, paidBalance, withdrawable: w.withdrawable, held: w.held, heldReleaseAt, refundable: r.refundable, manualRefund, forfeitRupees,
    bankOk: ready.bankOk, testCredits: Number(tc.balance ?? 0), testEarnings: w.testEarnings, openPayouts, openRefunds,
    hasMoney: paidBalance > 0 || openPayouts > 0 || openRefunds > 0,
  };
}

/** Called by the deletion request path. Throws when an HF user's wallet cannot be read: the caller must then refuse (503), not delete. */
export async function exitGate(env: Env, uid: string): Promise<{ deferred: false } | { deferred: true; exitStatus: string | null }> {
  const f = await exitFlags(env);
  if (!f.gateEnabled) return { deferred: false };
  const s = await exitSummary(env, uid);
  const d = decideDeletion({ gateEnabled: f.gateEnabled, isHfUser: s.isHfUser, hasMoney: s.hasMoney, exitStatus: s.exit?.status ?? null });
  return d === "exit" ? { deferred: true, exitStatus: s.exit?.status ?? null } : { deferred: false };
}

// ── closing guards ───────────────────────────────────────────────────────────
export const CLOSING_MESSAGE = "Your account is being closed, so this is paused until the closure is finished. You can cancel the closure on the Close my account page.";
/** True while this user has an open closure (hf_exit_requests waiting_hold / waiting_payouts / ready). Fails open: no table = not closing. */
export async function isClosing(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT status FROM hf_exit_requests WHERE uid=?1").bind(uid).first<{ status: string }>();
    return !!r && isActiveExit(r.status);
  } catch { return false; }
}
/** A host in closure takes no calls: online or busy -> offline. An ongoing call is not cut; it just does not return the host to "online". */
export async function forceHostOffline(env: Env, uid: string): Promise<void> {
  try { await env.DB_META.prepare("UPDATE hf_hosts SET presence='offline', presence_at=?2 WHERE uid=?1 AND presence IN ('online','busy')").bind(uid, Date.now()).run(); } catch { /* no host row / table */ }
}

// ── exit payout ──────────────────────────────────────────────────────────────
export type MakePayout = { ok: true; id: string } | { ok: false; status: number; error: string; message: string };
/** Same shape as a normal withdrawal (reserve in the wallet, admin approves, UTR), flagged exit=1: no minimum, no weekly cap. */
export async function createExitPayout(env: Env, uid: string, now = Date.now()): Promise<MakePayout> {
  const no = (status: number, error: string, message: string): MakePayout => ({ ok: false, status, error, message });
  const [w, ready] = await Promise.all([withdrawableFor(env, uid, now), hostPayoutReadiness(env, uid)]);
  if (!ready.bankOk) return no(409, "bank_required", "Add and verify your bank account first, or choose to give up your earnings.");
  const amount = w.withdrawable;
  if (amount <= 0) return no(409, "nothing_withdrawable", "No earnings are available to withdraw right now.");
  const bankRow = await env.DB_META.prepare("SELECT name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_at_bank_enc: string | null }>().catch(() => null);
  const name = await tryDecryptPii(env, bankRow?.name_at_bank_enc);
  const snapshot = JSON.stringify({ accountLast4: ready.accountLast4, ifsc: ready.ifsc, name });
  const id = crypto.randomUUID();
  const ref = refFor(id);
  await env.DB_META.prepare(
    `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, exit, created_at, updated_at)
     VALUES (?1,?2,?3,'requested',?4,?5,?6,1,?7,?7)`,
  ).bind(id, uid, amount, snapshot, ref, w.withdrawable, now).run();
  const abort = async (code: string, status: number, message: string) => {
    await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', reject_reason=?2, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, "system:" + code, Date.now()).run();
    return no(status, code, message);
  };
  const [matured, sums] = await Promise.all([sumMaturedCallRupees(env, uid, now), payoutSums(env, uid)]);
  if (sums.active > matured) return abort("insufficient_withdrawable", 402, "That amount is not available yet.");
  const r = await walletOp(env, uid, { op: "reserve", uid, amount, ref, allow_free: false, op_id: reserveOpId(id), app_name: PAYOUT_APP });
  if (r.status !== 200 || r.body?.ok === false) return abort(r.status === 402 ? "insufficient_withdrawable" : "wallet_error", r.status === 402 ? 402 : 502, "We couldn't set that money aside. Please try again.");
  void track(env, uid, "hf_payout_requested", PAYOUT_APP, { amount, exit: true });
  return { ok: true, id };
}

async function cancelExitPayout(env: Env, uid: string, id: string): Promise<boolean> {
  const r = await walletOp(env, uid, { op: "release_reservation", uid, ref: refFor(id), op_id: releaseOpId(id), app_name: PAYOUT_APP });
  if (r.status !== 200) return false;
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
  return !!up.meta?.changes;
}

// ── start / cancel ───────────────────────────────────────────────────────────
export type Trigger = (env: Env, uid: string) => Promise<unknown>;
export type StartResult =
  | { ok: true; status: ExitStatus; payoutId: string | null; refundId: string | null; replay?: boolean }
  | { ok: false; status: number; error: string; message: string; forfeitRupees?: number };

async function upsertExit(env: Env, uid: string, status: ExitStatus, payoutId: string | null, refundId: string | null, note: string | null, refundIds?: string[]): Promise<void> {
  const now = Date.now();
  if (refundIds) { // [HF-TOK-EXIT-1] token closure: the exit row remembers every play_refund (one per purchase lot)
    await env.DB_META.prepare(
      `INSERT INTO hf_exit_requests (uid, status, requested_at, updated_at, payout_id, refund_id, note, refund_ids) VALUES (?1,?2,?3,?3,?4,?5,?6,?7)
       ON CONFLICT(uid) DO UPDATE SET status=?2, requested_at=?3, updated_at=?3, payout_id=?4, refund_id=?5, note=?6, refund_ids=?7`,
    ).bind(uid, status, now, payoutId, refundId, note, JSON.stringify(refundIds)).run();
    return;
  }
  await env.DB_META.prepare(
    `INSERT INTO hf_exit_requests (uid, status, requested_at, updated_at, payout_id, refund_id, note) VALUES (?1,?2,?3,?3,?4,?5,?6)
     ON CONFLICT(uid) DO UPDATE SET status=?2, requested_at=?3, updated_at=?3, payout_id=?4, refund_id=?5, note=?6`,
  ).bind(uid, status, now, payoutId, refundId, note).run();
}

export async function startExit(env: Env, uid: string, o: { forfeit: boolean; trigger: Trigger }): Promise<StartResult> {
  const no = (status: number, error: string, message: string, extra: { forfeitRupees?: number } = {}): StartResult => ({ ok: false, status, error, message, ...extra });
  const existing = await getExitRow(env, uid);
  if (existing && isActiveExit(existing.status)) return { ok: true, status: existing.status, payoutId: existing.payout_id, refundId: existing.refund_id, replay: true };
  const flags = await exitFlags(env);
  if (await hfTokensOn(env)) return startTokenExit(env, uid, o, flags); // [HF-TOK-EXIT-1]
  let s: ExitSummary;
  try { s = await exitSummary(env, uid); } catch (e) {
    await trackException(env, e, { uid, route: "hf_exit.start", handled: true, app_name: PAYOUT_APP, extra: { area: "hf_exit", step: "summary" } });
    return no(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  if (!s.hasMoney) return no(409, "nothing_to_settle", "You have no money to settle. You can close your account now.");
  if (s.forfeitRupees > 0 && !o.forfeit) {
    return no(409, "forfeit_required", s.bankOk ? "Some money cannot be paid out." : "Add and verify your bank account to receive your earnings, or choose to give them up.", { forfeitRupees: s.forfeitRupees });
  }
  let refundId: string | null = null, payoutId: string | null = null;
  const callerMoney = s.refundable + s.manualRefund;
  if (callerMoney > 0) {
    const r = await createRefundRequest(env, uid, { exit: true, windowDays: flags.windowDays });
    if (!r.ok) return no(r.status, r.error, r.message);
    refundId = r.id;
  }
  // Earnings still in the 7-day hold: ONE exit payout is made for everything once the hold ends (cron), not one now and one later.
  if (s.bankOk && s.withdrawable > 0 && s.held === 0) {
    const p = await createExitPayout(env, uid);
    if (!p.ok) {
      if (refundId) await cancelRefund(env, refundId, uid, true);
      return no(p.status, p.error, p.message);
    }
    payoutId = p.id;
  }
  const status: ExitStatus = s.held > 0 ? "waiting_hold" : payoutId || refundId ? "waiting_payouts" : "ready";
  await upsertExit(env, uid, status, payoutId, refundId, s.forfeitRupees > 0 ? `forfeit:${s.forfeitRupees}` : null);
  await forceHostOffline(env, uid);
  void track(env, uid, "hf_exit_started", PAYOUT_APP, { status, payout: !!payoutId, refund: !!refundId, forfeit: s.forfeitRupees });
  if (status === "ready") await advanceExit(env, (await getExitRow(env, uid))!, o.trigger);
  return { ok: true, status, payoutId, refundId };
}

/**
 * [HF-TOK-EXIT-1] Closing with tokens on. No WalletDO: unspent PURCHASE lots become one play_refund request each (admin confirms, Google refunds),
 * earnings come out of the host ledger as a closure payout after the 7-day hold. A person on a call (caller or host) cannot start.
 * Test lots are removed and open debts written off when everything is settled (finishTokenExit, run just before the deletion).
 */
async function startTokenExit(env: Env, uid: string, o: { forfeit: boolean; trigger: Trigger }, flags: ExitFlags): Promise<StartResult> {
  const no = (status: number, error: string, message: string, extra: { forfeitRupees?: number } = {}): StartResult => ({ ok: false, status, error, message, ...extra });
  if (await hasActiveCall(env, uid)) return no(409, "active_call", "You have a call in progress. Please finish it before closing your account.");
  let s: ExitSummary;
  try { s = await exitSummary(env, uid); } catch (e) {
    await trackException(env, e, { uid, route: "hf_exit.start", handled: true, app_name: PAYOUT_APP, extra: { area: "hf_exit", step: "summary", mode: "tokens" } });
    return no(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  if (!s.hasMoney) return no(409, "nothing_to_settle", "You have no money to settle. You can close your account now.");
  if (s.forfeitRupees > 0 && !o.forfeit) {
    return no(409, "forfeit_required", s.bankOk ? "Some money cannot be paid out." : "Add and verify your bank account to receive your earnings, or choose to give them up.", { forfeitRupees: s.forfeitRupees });
  }
  const ti = s.tokensInfo;
  let refundIds: string[] = [], payoutId: string | null = null;
  if (ti && ti.refundPaise > 0) {
    const r = await requestPlayRefunds(env, uid, { exit: true, windowDays: flags.windowDays });
    if (!r.ok) return no(r.status, r.error, r.message);
    refundIds = r.ids;
  }
  // Earnings still in the 7-day hold: ONE closure payout is made for everything once the hold ends (cron).
  if (s.bankOk && s.withdrawable > 0 && s.held === 0) {
    const p = await createExitPayoutTokens(env, uid);
    if (!p.ok) {
      for (const id of refundIds) await cancelPlayRefund(env, id, uid, true);
      return no(p.status, p.error, p.message);
    }
    payoutId = p.id;
  }
  const status: ExitStatus = s.held > 0 ? "waiting_hold" : payoutId || refundIds.length ? "waiting_payouts" : "ready";
  await upsertExit(env, uid, status, payoutId, refundIds[0] ?? null, s.forfeitRupees > 0 ? `forfeit:${s.forfeitRupees}` : null, refundIds);
  await forceHostOffline(env, uid);
  void track(env, uid, "hf_exit_started", PAYOUT_APP, { status, payout: !!payoutId, refund: refundIds.length, forfeit: s.forfeitRupees, mode: "tokens" });
  if (status === "ready") await advanceExit(env, (await getExitRow(env, uid))!, o.trigger);
  return { ok: true, status, payoutId, refundId: refundIds[0] ?? null };
}

/** [HF-TOK-EXIT-1] Cancel a token closure: allowed only while no play_refund / payout has been picked up by an admin. */
async function cancelTokenExit(env: Env, uid: string, row: ExitRow): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  const OPEN_OK = ["requested", "rejected", "cancelled"];
  const ids = refundIdsOf(row.refund_ids);
  const refunds = await Promise.all(ids.map((id) => env.DB_META.prepare("SELECT id, status FROM hf_refund_requests WHERE id=?1").bind(id).first<{ id: string; status: string }>().catch(() => null)));
  const p = row.payout_id ? await env.DB_META.prepare("SELECT status, wallet_ref FROM hf_payout_requests WHERE id=?1").bind(row.payout_id).first<{ status: string; wallet_ref: string | null }>().catch(() => null) : null;
  if ((p && !OPEN_OK.includes(p.status)) || refunds.some((r) => r && !OPEN_OK.includes(r.status))) {
    return { ok: false, status: 409, error: "cannot_cancel", message: "Your money is already being paid out, so this can no longer be cancelled." };
  }
  if (p?.status === "requested" && row.payout_id) {
    const ok = isHostLedgerRef(p.wallet_ref) ? await cancelExitPayoutTokens(env, uid, row.payout_id) : await cancelExitPayout(env, uid, row.payout_id);
    if (!ok) return { ok: false, status: 502, error: "wallet_error", message: "We couldn't release that money. Please try again." };
  }
  for (const r of refunds) {
    if (r?.status !== "requested") continue;
    const c = await cancelPlayRefund(env, r.id, uid, true);
    if (!c.ok) return { ok: false, status: c.status, error: c.error, message: c.message };
  }
  await env.DB_META.prepare("UPDATE hf_exit_requests SET status='cancelled', updated_at=?2 WHERE uid=?1").bind(uid, Date.now()).run();
  return { ok: true };
}

export async function cancelExit(env: Env, uid: string): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  const row = await getExitRow(env, uid);
  if (!row || !isActiveExit(row.status)) return { ok: false, status: 404, error: "no_exit", message: "There is nothing to cancel." };
  if (row.refund_ids != null) return cancelTokenExit(env, uid, row); // [HF-TOK-EXIT-1] decided by the row itself, so a flag flip never strands a closure
  const p = row.payout_id ? await env.DB_META.prepare("SELECT status FROM hf_payout_requests WHERE id=?1").bind(row.payout_id).first<{ status: string }>().catch(() => null) : null;
  const rf = row.refund_id ? await env.DB_META.prepare("SELECT status FROM hf_refund_requests WHERE id=?1").bind(row.refund_id).first<{ status: string }>().catch(() => null) : null;
  const blocked = (p && !["requested", "rejected", "cancelled"].includes(p.status)) || (rf && !["requested", "rejected", "cancelled"].includes(rf.status));
  if (blocked) return { ok: false, status: 409, error: "cannot_cancel", message: "Your money is already being paid out, so this can no longer be cancelled." };
  if (p?.status === "requested" && row.payout_id && !(await cancelExitPayout(env, uid, row.payout_id))) return { ok: false, status: 502, error: "wallet_error", message: "We couldn't release that money. Please try again." };
  if (rf?.status === "requested" && row.refund_id) {
    const c = await cancelRefund(env, row.refund_id, uid, true);
    if (!c.ok) return { ok: false, status: c.status, error: c.error, message: c.message };
  }
  await env.DB_META.prepare("UPDATE hf_exit_requests SET status='cancelled', updated_at=?2 WHERE uid=?1").bind(uid, Date.now()).run();
  return { ok: true };
}

// ── cron ─────────────────────────────────────────────────────────────────────
/** Advance one exit row by one step (a row may take several ticks: hold, payout, then settle). Never throws. */
export async function advanceExit(env: Env, row: ExitRow, trigger: Trigger, now = Date.now()): Promise<ExitStatus> {
  let status = row.status, payoutId = row.payout_id, note = row.note;
  await forceHostOffline(env, row.uid); // the calls cron can put a "busy" host back online; keep them off while closing
  try {
    const tokenMode = row.refund_ids != null; // [HF-TOK-EXIT-1] the closure itself says which path owns its money
    const [pay, ref] = await Promise.all([
      payoutId ? env.DB_META.prepare("SELECT status FROM hf_payout_requests WHERE id=?1").bind(payoutId).first<{ status: string }>().catch(() => null) : null,
      !tokenMode && row.refund_id ? env.DB_META.prepare("SELECT status FROM hf_refund_requests WHERE id=?1").bind(row.refund_id).first<RefundRow>().catch(() => null) : null,
    ]);
    let refundStatus: string | null = ref?.status ?? null;
    if (tokenMode) {
      const ids = refundIdsOf(row.refund_ids);
      const rows = await Promise.all(ids.map((id) => env.DB_META.prepare("SELECT status FROM hf_refund_requests WHERE id=?1").bind(id).first<{ status: string }>().catch(() => null)));
      refundStatus = ids.length === 0 ? null : rows.every((r) => !r || TERMINAL_REFUND.includes(r.status)) ? "refunded" : "requested";
    }
    let held = 0;
    if (status === "waiting_hold") held = tokenMode ? wholeRupees((await hostSummary(env, row.uid, now)).pendingPaise) : (await withdrawableFor(env, row.uid, now)).held;
    let step = nextExitStep({ status, held, hasPayout: !!payoutId, payoutStatus: pay?.status ?? null, refundStatus });
    if (step === "make_payout") {
      const ready = await hostPayoutReadiness(env, row.uid);
      const w = tokenMode ? { withdrawable: wholeRupees((await hostSummary(env, row.uid, now)).availablePaise) } : await withdrawableFor(env, row.uid, now);
      if (w.withdrawable > 0 && ready.bankOk) {
        const p = tokenMode ? await createExitPayoutTokens(env, row.uid, now) : await createExitPayout(env, row.uid, now);
        if (!p.ok) { console.warn("[hf-exit] payout not created", row.uid, p.error); return status; }
        payoutId = p.id;
      } else if (w.withdrawable > 0) note = `forfeit:${w.withdrawable}`; // bank missing: the user already agreed to give these earnings up
      const p2 = payoutId ? await env.DB_META.prepare("SELECT status FROM hf_payout_requests WHERE id=?1").bind(payoutId).first<{ status: string }>().catch(() => null) : null;
      step = nextExitStep({ status: "waiting_payouts", held: 0, hasPayout: !!payoutId, payoutStatus: p2?.status ?? null, refundStatus });
      status = "waiting_payouts";
    }
    if (step === "wait_hold") return status;
    if (step === "trigger_deletion") {
      if (tokenMode) await finishTokenExit(env, row.uid); // [HF-TOK-EXIT-1] test lots removed, open debts written off (recorded) just before deleting
      await trigger(env, row.uid);
      status = "done";
    } else status = "waiting_payouts";
  } catch (e) {
    await trackException(env, e, { uid: row.uid, route: "hf_exit.advance", handled: true, app_name: PAYOUT_APP, extra: { area: "hf_exit" } });
    return row.status;
  }
  if (status !== row.status || payoutId !== row.payout_id || note !== row.note) {
    await env.DB_META.prepare("UPDATE hf_exit_requests SET status=?2, payout_id=?3, note=?4, updated_at=?5 WHERE uid=?1").bind(row.uid, status, payoutId, note, now).run();
  }
  return status;
}

/** Cron entry (add to scheduled()). Bounded per tick. */
export async function runHfExitCron(env: Env, trigger: Trigger, now = Date.now()): Promise<{ scanned: number; done: number }> {
  let rows: ExitRow[] = [];
  try {
    rows = (await env.DB_META.prepare("SELECT * FROM hf_exit_requests WHERE status IN ('waiting_hold','waiting_payouts','ready') ORDER BY updated_at ASC LIMIT 50").all<ExitRow>()).results ?? [];
  } catch { return { scanned: 0, done: 0 }; }
  let done = 0;
  for (const r of rows) if ((await advanceExit(env, r, trigger, now)) === "done") done++;
  return { scanned: rows.length, done };
}
