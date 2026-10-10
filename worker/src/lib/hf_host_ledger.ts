// [HF-TOK-CALLS-1] Host earnings ledger in PAISE (table hf_host_ledger, DB_META). Hosts only ever see rupees (HF-TOK-D5); tokens are a caller thing.
// Used only when hfTokensEnabled is on; the old WalletDO + host_paid_rupees path (lib/hf_payouts.ts) is untouched while it is off.
//
// Row kinds (amount_paise is signed):
//   call_earning       +  host share from PURCHASE-lot value; withdrawable after available_at (call end + 7 days)
//   call_earning_test  +  host share from TEST-lot value; recorded for the host to see, NEVER withdrawable (available_at NULL)
//   payout_reserve     -  money set aside when a withdrawal is requested (whole rupees * 100)
//   payout_cancel      +  gives that reserve back (cancelled / rejected)
//   payout_paid        0  marker only: the reserve already left the balance, "paid" just freezes it (UTR lives on the payout request)
//   admin_adjust       +/- manual correction, counts at once
// withdrawable = matured call_earning + payout_reserve + payout_cancel + admin_adjust. Every write is a single statement guarded by the
// UNIQUE op_id, so a retry never doubles anything, and a payout reserve checks the balance inside the same INSERT (two requests cannot both fit).
import type { Env } from "../types";

export const HOST_HOLD_DAYS = 7;
export const HOST_HOLD_MS = HOST_HOLD_DAYS * 86_400_000;
export const earnOpId = (callId: string, kind: "call_earning" | "call_earning_test") => `hfhc:${callId}:${kind === "call_earning" ? "p" : "t"}`;
export const reserveOpId = (payoutId: string) => `hfhpr:${payoutId}`;
export const cancelOpId = (payoutId: string) => `hfhpc:${payoutId}`;
export const paidOpId = (payoutId: string) => `hfhpp:${payoutId}`;
/** wallet_ref stored on a payout request made against this ledger; it tells later steps (cancel / paid / reject) which path owns the money. */
export const hostLedgerRef = (payoutId: string) => `hfhl:${payoutId}`;
export const isHostLedgerRef = (ref: string | null | undefined) => typeof ref === "string" && ref.startsWith("hfhl:");

/** Whole rupees a paise amount can be withdrawn as (payouts are whole rupees; the leftover paise stay in the balance). */
export const wholeRupees = (paise: number): number => Math.max(0, Math.floor(Math.max(0, paise) / 100));

export async function creditCallEarning(
  env: Env, hostUid: string, callId: string, paise: number, kind: "call_earning" | "call_earning_test", endedAt: number,
): Promise<{ applied: boolean }> {
  const amt = Math.trunc(paise);
  if (!(amt > 0)) return { applied: false };
  const r = await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,NULL,?8)`,
  ).bind(crypto.randomUUID(), hostUid, kind, amt, callId, kind === "call_earning" ? endedAt + HOST_HOLD_MS : null, earnOpId(callId, kind), Date.now()).run();
  return { applied: Number(r.meta?.changes ?? 0) === 1 };
}

export interface HostSummary {
  /** All paid-funded earnings so far (matured or not), paise. */
  earnedPaise: number;
  /** Earned and past the 7-day hold, before payouts. */
  maturedPaise: number;
  /** Earned but still in the 7-day hold. */
  pendingPaise: number;
  /** Earnings from test credits: shown, never withdrawable. */
  testPaise: number;
  /** Withdrawable right now, paise (matured earnings minus reserves/payouts, plus adjustments). */
  availablePaise: number;
  /** Money set aside for withdrawal requests that are still open (requested/approved). */
  openPayoutPaise: number;
  /** Money already paid out. */
  paidOutPaise: number;
}

/** SQL for the withdrawable balance of ?host at ?now. Reused inside the payout-reserve INSERT so the check and the write are one statement. */
const WITHDRAWABLE_SQL = (host: string, now: string) =>
  `(SELECT COALESCE(SUM(CASE WHEN kind='call_earning' THEN (CASE WHEN available_at<=${now} THEN amount_paise ELSE 0 END)
                            WHEN kind IN ('payout_reserve','payout_cancel','admin_adjust') THEN amount_paise ELSE 0 END),0)
      FROM hf_host_ledger WHERE host_uid=${host})`;

export async function hostSummary(env: Env, hostUid: string, now = Date.now()): Promise<HostSummary> {
  const r = await env.DB_META.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind='call_earning' THEN amount_paise END),0) AS earned,
            COALESCE(SUM(CASE WHEN kind='call_earning' AND available_at<=?2 THEN amount_paise END),0) AS matured,
            COALESCE(SUM(CASE WHEN kind='call_earning_test' THEN amount_paise END),0) AS test,
            COALESCE(SUM(CASE WHEN kind IN ('payout_reserve','payout_cancel','admin_adjust') THEN amount_paise END),0) AS adj
       FROM hf_host_ledger WHERE host_uid=?1`,
  ).bind(hostUid, now).first<{ earned: number; matured: number; test: number; adj: number }>();
  const earned = Number(r?.earned ?? 0), matured = Number(r?.matured ?? 0), adj = Number(r?.adj ?? 0);
  let open = 0, paid = 0;
  try {
    const rows = (await env.DB_META.prepare(
      "SELECT status, COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved','paid') GROUP BY status",
    ).bind(hostUid).all<{ status: string; s: number }>()).results ?? [];
    for (const x of rows) { if (x.status === "paid") paid += Number(x.s) * 100; else open += Number(x.s) * 100; }
  } catch { /* payout table not there: nothing requested */ }
  return {
    earnedPaise: earned, maturedPaise: matured, pendingPaise: Math.max(0, earned - matured), testPaise: Number(r?.test ?? 0),
    availablePaise: Math.max(0, matured + adj), openPayoutPaise: open, paidOutPaise: paid,
  };
}

/** Set aside `paise` for a withdrawal, only if it fits the withdrawable balance (checked inside the INSERT). Idempotent per payout id. */
export async function reservePayout(env: Env, hostUid: string, payoutId: string, paise: number, now = Date.now()): Promise<{ ok: boolean; again: boolean }> {
  const amt = Math.trunc(paise);
  if (!(amt > 0)) return { ok: false, again: false };
  const op = reserveOpId(payoutId);
  const had = await env.DB_META.prepare("SELECT 1 AS x FROM hf_host_ledger WHERE op_id=?1").bind(op).first();
  if (had) return { ok: true, again: true };
  const r = await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     SELECT ?1,?2,'payout_reserve',?3,NULL,?4,NULL,?5,NULL,?6 WHERE ${WITHDRAWABLE_SQL("?2", "?6")} >= ?7`,
  ).bind(crypto.randomUUID(), hostUid, -amt, payoutId, op, now, amt).run();
  return { ok: Number(r.meta?.changes ?? 0) === 1, again: false };
}

/** Give a reserve back (cancel / reject). Does nothing once the payout is marked paid, or when there was no reserve. Idempotent. */
export async function cancelPayoutReserve(env: Env, hostUid: string, payoutId: string): Promise<{ ok: boolean }> {
  const had = await env.DB_META.prepare("SELECT amount_paise AS a FROM hf_host_ledger WHERE op_id=?1").bind(reserveOpId(payoutId)).first<{ a: number }>();
  if (!had) return { ok: false };
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     SELECT ?1,?2,'payout_cancel',?3,NULL,?4,NULL,?5,NULL,?6 WHERE NOT EXISTS (SELECT 1 FROM hf_host_ledger WHERE op_id=?7)`,
  ).bind(crypto.randomUUID(), hostUid, -Number(had.a), payoutId, cancelOpId(payoutId), Date.now(), paidOpId(payoutId)).run();
  const cancelled = await env.DB_META.prepare("SELECT 1 AS x FROM hf_host_ledger WHERE op_id=?1").bind(cancelOpId(payoutId)).first();
  return { ok: !!cancelled };
}

/** Freeze a reserve as paid (a zero-amount marker). Refuses when there is no reserve or it was already cancelled. Idempotent. */
export async function markPayoutPaid(env: Env, hostUid: string, payoutId: string): Promise<{ ok: boolean }> {
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     SELECT ?1,?2,'payout_paid',0,NULL,?3,NULL,?4,NULL,?5
      WHERE EXISTS (SELECT 1 FROM hf_host_ledger WHERE op_id=?6) AND NOT EXISTS (SELECT 1 FROM hf_host_ledger WHERE op_id=?7)`,
  ).bind(crypto.randomUUID(), hostUid, payoutId, paidOpId(payoutId), Date.now(), reserveOpId(payoutId), cancelOpId(payoutId)).run();
  const ok = await env.DB_META.prepare("SELECT 1 AS x FROM hf_host_ledger WHERE op_id=?1").bind(paidOpId(payoutId)).first();
  return { ok: !!ok };
}

export interface CallEarning { callId: string; at: number; paidPaise: number; testPaise: number; availableAt: number | null }
/** Per-call earnings, newest first. Paid part and test part of one call are folded into one row. */
export async function listCallEarnings(env: Env, hostUid: string, limit = 50): Promise<CallEarning[]> {
  const rows = (await env.DB_META.prepare(
    `SELECT call_id AS callId, MAX(created_at) AS at,
            COALESCE(SUM(CASE WHEN kind='call_earning' THEN amount_paise END),0) AS paid,
            COALESCE(SUM(CASE WHEN kind='call_earning_test' THEN amount_paise END),0) AS test,
            MAX(available_at) AS availableAt
       FROM hf_host_ledger WHERE host_uid=?1 AND kind IN ('call_earning','call_earning_test') AND call_id IS NOT NULL
      GROUP BY call_id ORDER BY at DESC LIMIT ?2`,
  ).bind(hostUid, Math.max(1, Math.min(200, Math.trunc(limit)))).all<{ callId: string; at: number; paid: number; test: number; availableAt: number | null }>()).results ?? [];
  return rows.map((r) => ({ callId: r.callId, at: Number(r.at), paidPaise: Number(r.paid), testPaise: Number(r.test), availableAt: r.availableAt == null ? null : Number(r.availableAt) }));
}
