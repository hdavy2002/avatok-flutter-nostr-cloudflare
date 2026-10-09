// [HF-PAYOUT-1 2026-10-09] HF host withdrawals: pure money math + D1/WalletDO helpers. Routes: routes/hf_payouts.ts.
// Rulebook: Specs/RULEBOOK-HELLO-FRAANDS.md HF-PAY-12 / HF-PAY-13.
//
// WHAT IS WITHDRAWABLE. Only money a host earned from calls the CALLER paid for with real (paid) money. Never test-credit earnings
// (hf_host_test_earnings, outside the wallet) and never anything that merely sits in the host's own WalletDO from their own top-ups.
// The WalletDO paid balance mixes both, so the withdrawable figure is the SMALLER of two independent ceilings:
//   (a) wallet ceiling  = WalletDO paid balance (after maturing 7-day holds) minus what open payout requests already reserve;
//   (b) calls ceiling   = sum of hf_calls.host_paid_rupees for calls that ended at least 7 days ago, minus every payout that is
//                         requested, approved or already paid (those drew on this pool).
// LEGACY: calls from before HF-WALLET-1 have host_paid_rupees NULL; they count as 0 here. An admin can settle those by hand.
import type { Env } from "../types";
import { walletOp } from "../routes/wallet";

export const HOLD_DAYS = 7;
export const HOLD_MS = HOLD_DAYS * 86_400_000;
export const WEEK_MS = 7 * 86_400_000;
export const WALLET_APP = "hfpayout";

export type PayoutStatus = "requested" | "approved" | "paid" | "rejected" | "cancelled";
export const STATUSES: PayoutStatus[] = ["requested", "approved", "paid", "rejected", "cancelled"];

export const refFor = (id: string) => `hfpayout:${id}`;
export const reserveOpId = (id: string) => `hfpayout_res:${id}`;
export const payOpId = (id: string) => `hfpayout_pay:${id}`;
export const releaseOpId = (id: string) => `hfpayout_rel:${id}`;

/** 6-30 letters/digits. UTRs are alphanumeric (UPI: 12 digits; IMPS/NEFT/RTGS: letters + digits). */
export const UTR_RE = /^[A-Za-z0-9]{6,30}$/;
export const cleanUtr = (v: unknown): string | null => {
  const s = String(v ?? "").trim().toUpperCase();
  return UTR_RE.test(s) ? s : null;
};

export interface WithdrawableInput {
  /** WalletDO paid balance, holds already matured. */
  walletBalance: number;
  /** Sum of requested+approved payout amounts (reserved in the wallet, still inside walletBalance). */
  openReserved: number;
  /** Sum of host_paid_rupees for calls that ended before now - 7 days (NULL = 0). */
  maturedCallRupees: number;
  /** Sum of requested+approved+paid payout amounts (all drew on the calls pool). */
  activePayoutRupees: number;
}
const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** Pure. Whole rupees the host can withdraw right now (never negative). */
export function computeWithdrawable(i: WithdrawableInput): number {
  const walletCeiling = whole(i.walletBalance) - whole(i.openReserved);
  const callsCeiling = whole(i.maturedCallRupees) - whole(i.activePayoutRupees);
  return Math.max(0, Math.min(walletCeiling, callsCeiling));
}

export interface RequestCheck {
  enabled: boolean;
  hostStatus: string | null;
  kycOk: boolean;
  bankOk: boolean;
  amount: unknown;
  minRupees: number;
  withdrawable: number;
  recentCount: number; // requests created in the last 7 days that are not rejected/cancelled
  maxPerWeek: number;
}
export type RequestVerdict = { ok: true; amount: number } | { ok: false; status: number; error: string; message: string };

/** Pure. First failing rule wins; codes are stable for the web. */
export function validatePayoutRequest(c: RequestCheck): RequestVerdict {
  const no = (status: number, error: string, message: string): RequestVerdict => ({ ok: false, status, error, message });
  if (!c.enabled) return no(404, "not_enabled", "Withdrawals open soon.");
  if (c.hostStatus !== "live") return no(403, "not_live", "Only live hosts can withdraw.");
  if (!c.kycOk) return no(409, "kyc_required", "Finish your identity check first.");
  if (!c.bankOk) return no(409, "bank_required", "Add and verify your bank account first. The name must match your Aadhaar.");
  const n = Number(c.amount);
  if (!Number.isInteger(n) || n <= 0) return no(400, "invalid_amount", "Enter a whole number of rupees.");
  if (n < c.minRupees) return no(400, "below_minimum", `The smallest withdrawal is ₹${c.minRupees}.`);
  if (c.recentCount >= c.maxPerWeek) return no(429, "weekly_limit", `You can make ${c.maxPerWeek} withdrawal requests a week. Please try again later.`);
  if (n > c.withdrawable) return no(402, "insufficient_withdrawable", `You can withdraw up to ₹${c.withdrawable} right now.`);
  return { ok: true, amount: n };
}

/** Pure state machine. */
export const canApprove = (s: string) => s === "requested";
export const canCancel = (s: string) => s === "requested";
export const canPay = (s: string) => s === "approved";
export const canReject = (s: string) => s === "requested" || s === "approved";

export interface PayoutRow {
  id: string; host_uid: string; amount_rupees: number; status: PayoutStatus; bank_snapshot: string | null; wallet_ref: string | null;
  utr: string | null; reject_reason: string | null; admin_uid: string | null; withdrawable_at_request: number | null;
  created_at: number; updated_at: number; approved_at: number | null; paid_at: number | null;
}

export interface Withdrawable {
  withdrawable: number;
  held: number;
  walletBalance: number;
  maturedCallRupees: number;
  activePayoutRupees: number;
  openReserved: number;
  testEarnings: number;
}

const tsMs = (col: string) => `(CASE WHEN ${col} < 100000000000 THEN ${col} * 1000 ELSE ${col} END)`;

export async function sumMaturedCallRupees(env: Env, hostUid: string, now = Date.now()): Promise<number> {
  const r = await env.DB_META.prepare(
    `SELECT COALESCE(SUM(host_paid_rupees),0) AS s FROM hf_calls
     WHERE host_uid=?1 AND host_paid_rupees IS NOT NULL AND ended_at IS NOT NULL AND ${tsMs("ended_at")} <= ?2`,
  ).bind(hostUid, now - HOLD_MS).first<{ s: number }>();
  return Number(r?.s ?? 0);
}

export async function payoutSums(env: Env, hostUid: string): Promise<{ open: number; active: number }> {
  const rows = (await env.DB_META.prepare(
    "SELECT status, COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved','paid') GROUP BY status",
  ).bind(hostUid).all<{ status: string; s: number }>()).results ?? [];
  let open = 0, active = 0;
  for (const r of rows) { active += Number(r.s); if (r.status !== "paid") open += Number(r.s); }
  return { open, active };
}

/** Wallet paid balance + held, after maturing holds. Throws when the wallet cannot be read (money screens must not guess). */
export async function walletPaid(env: Env, hostUid: string): Promise<{ balance: number; held: number }> {
  await walletOp(env, hostUid, { op: "release", uid: hostUid, app_name: WALLET_APP });
  const snap = await walletOp(env, hostUid, { op: "balance", uid: hostUid });
  if (snap.status !== 200) throw new Error(`wallet_${snap.status}`);
  return { balance: Number(snap.body?.balance ?? 0), held: Number(snap.body?.held ?? 0) };
}

export async function withdrawableFor(env: Env, hostUid: string, now = Date.now()): Promise<Withdrawable> {
  const [w, matured, sums, te] = await Promise.all([
    walletPaid(env, hostUid),
    sumMaturedCallRupees(env, hostUid, now),
    payoutSums(env, hostUid),
    env.DB_META.prepare("SELECT COALESCE(SUM(rupees),0) AS t FROM hf_host_test_earnings WHERE host_uid=?1").bind(hostUid).first<{ t: number }>().catch(() => null),
  ]);
  return {
    withdrawable: computeWithdrawable({ walletBalance: w.balance, openReserved: sums.open, maturedCallRupees: matured, activePayoutRupees: sums.active }),
    held: w.held, walletBalance: w.balance, maturedCallRupees: matured, activePayoutRupees: sums.active, openReserved: sums.open,
    testEarnings: Number(te?.t ?? 0),
  };
}

export async function recentRequestCount(env: Env, hostUid: string, now = Date.now()): Promise<number> {
  const r = await env.DB_META.prepare(
    "SELECT COUNT(*) AS n FROM hf_payout_requests WHERE host_uid=?1 AND created_at>?2 AND status IN ('requested','approved','paid')",
  ).bind(hostUid, now - WEEK_MS).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** hf_kyc verified + hf_payout bank verified with a name match. */
export async function hostPayoutReadiness(env: Env, hostUid: string): Promise<{ kycOk: boolean; bankOk: boolean; accountLast4: string | null; ifsc: string | null }> {
  const [kyc, bank] = await Promise.all([
    env.DB_META.prepare("SELECT verified_at FROM hf_kyc WHERE uid=?1").bind(hostUid).first<{ verified_at: number | null }>().catch(() => null),
    env.DB_META.prepare("SELECT name_match, account_last4, ifsc, account_enc FROM hf_payout WHERE uid=?1").bind(hostUid)
      .first<{ name_match: number; account_last4: string | null; ifsc: string | null; account_enc: string | null }>().catch(() => null),
  ]);
  return {
    kycOk: !!kyc?.verified_at,
    bankOk: !!bank && bank.name_match === 1 && !!bank.account_last4 && !!bank.ifsc && !!bank.account_enc,
    accountLast4: bank?.account_last4 ?? null,
    ifsc: bank?.ifsc ?? null,
  };
}

export function parseSnapshot(s: string | null): { accountLast4: string | null; ifsc: string | null; name: string | null } {
  try {
    const j = JSON.parse(s || "{}") as Record<string, unknown>;
    return { accountLast4: typeof j.accountLast4 === "string" ? j.accountLast4 : null, ifsc: typeof j.ifsc === "string" ? j.ifsc : null, name: typeof j.name === "string" ? j.name : null };
  } catch { return { accountLast4: null, ifsc: null, name: null }; }
}
