// [HF-WALLET-LIMITS-1] Admin money reconciliation (HF-PAY-17): does every rupee that came in through a gateway show up as a wallet credit, and where did it go?
// Per IST day: top-ups paid by gateway, wallet credits (type hf_topup), call charges paid vs test, host earnings paid vs test, platform share,
// payouts paid (UTR), refunds; plus a mismatch list and approximate outstanding liabilities. buildReconciliation() is pure (fixtures in tests);
// loadReconciliation() is the D1 reader. Read-only: nothing here writes.
import type { Env } from "../types";
import { istDateStr, istDayStart, parseIstDate } from "./hf_limits";

export const MAX_RANGE_DAYS = 93;
/** A wallet credit is audited through a queue; a paid top-up younger than this is "pending", not a mismatch. */
export const CREDIT_GRACE_MS = 30 * 60_000;
export const TOPUP_REF_PREFIX = "hftop:";

export interface TopupRec { id: string; uid: string; amount_rupees: number; gateway: string; status: string; credited: number; paid_at: number | null; created_at: number }
export interface CreditRec { ref: string | null; uid: string; amount: number; created_at: number }
export interface CallRec { ts: number; paid_rupees: number | null; test_rupees: number | null; host_paid_rupees: number | null; host_test_rupees: number | null }
export interface PayoutRec { id: string; host_uid: string; amount_rupees: number; utr: string | null; paid_at: number }
export interface RefundRec { id: string; uid: string; amount_rupees: number; paid_at: number }

export type MismatchKind = "paid_without_credit" | "credit_without_paid_topup" | "amount_difference";
export interface Mismatch { kind: MismatchKind; topupId: string; uid: string; topupRupees: number | null; creditRupees: number | null; detail: string; at: number }

const isPaidTopup = (t: TopupRec) => t.status === "paid" || t.credited === 1;
const creditTopupId = (c: CreditRec): string | null => (c.ref && c.ref.startsWith(TOPUP_REF_PREFIX) ? c.ref.slice(TOPUP_REF_PREFIX.length) : null);

/**
 * Compare paid top-ups with wallet credits by top-up id (credit ref `hftop:<id>`). Only items dated inside [fromMs, toMs) are reported;
 * pass rows from a slightly wider window so a credit just across midnight still matches.
 */
export function detectTopupMismatches(topups: TopupRec[], credits: CreditRec[], fromMs: number, toMs: number, now: number): Mismatch[] {
  const out: Mismatch[] = [];
  const byTopup = new Map(topups.map((t) => [t.id, t]));
  const creditById = new Map<string, CreditRec[]>();
  for (const c of credits) {
    const id = creditTopupId(c);
    if (!id) continue;
    creditById.set(id, [...(creditById.get(id) ?? []), c]);
  }
  for (const t of topups) {
    if (!isPaidTopup(t)) continue;
    const at = t.paid_at ?? t.created_at;
    if (at < fromMs || at >= toMs) continue;
    const cs = creditById.get(t.id) ?? [];
    if (cs.length === 0) {
      if (now - at < CREDIT_GRACE_MS) continue;
      out.push({ kind: "paid_without_credit", topupId: t.id, uid: t.uid, topupRupees: t.amount_rupees, creditRupees: null, detail: `Paid via ${t.gateway} but no wallet credit found`, at });
      continue;
    }
    const credited = cs.reduce((a, c) => a + Math.trunc(Number(c.amount)), 0);
    if (credited !== t.amount_rupees) {
      out.push({ kind: "amount_difference", topupId: t.id, uid: t.uid, topupRupees: t.amount_rupees, creditRupees: credited, detail: cs.length > 1 ? `${cs.length} credits for one top-up` : "Credit differs from the top-up amount", at });
    }
  }
  for (const c of credits) {
    const id = creditTopupId(c);
    if (!id || c.created_at < fromMs || c.created_at >= toMs) continue;
    const t = byTopup.get(id);
    if (!t) out.push({ kind: "credit_without_paid_topup", topupId: id, uid: c.uid, topupRupees: null, creditRupees: Math.trunc(Number(c.amount)), detail: "Wallet credit with no top-up record", at: c.created_at });
    else if (!isPaidTopup(t)) out.push({ kind: "credit_without_paid_topup", topupId: id, uid: c.uid, topupRupees: t.amount_rupees, creditRupees: Math.trunc(Number(c.amount)), detail: `Wallet credit but the top-up is '${t.status}'`, at: c.created_at });
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface DayRow {
  date: string;
  topups: { count: number; rupees: number; byGateway: Record<string, { count: number; rupees: number }> };
  walletCredits: { count: number; rupees: number };
  calls: { paid: number; test: number };
  hostEarnings: { paid: number; test: number };
  platformShare: { paid: number; test: number };
  payouts: { count: number; rupees: number };
  refunds: { count: number; rupees: number } | null;
}
export interface Reconciliation {
  from: string; to: string; days: DayRow[]; totals: Omit<DayRow, "date">;
  mismatches: Mismatch[]; payouts: PayoutRec[];
  refundsAvailable: boolean;
  liabilities: { callerWalletsApprox: number; hostEarningsApprox: number; note: string } | null;
}

const emptyDay = (date: string, refunds: boolean): DayRow => ({
  date, topups: { count: 0, rupees: 0, byGateway: {} }, walletCredits: { count: 0, rupees: 0 }, calls: { paid: 0, test: 0 },
  hostEarnings: { paid: 0, test: 0 }, platformShare: { paid: 0, test: 0 }, payouts: { count: 0, rupees: 0 }, refunds: refunds ? { count: 0, rupees: 0 } : null,
});
const n = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;

export function buildReconciliation(a: {
  fromMs: number; toMs: number; // [from, to) in epoch ms, both at IST midnight
  topups: TopupRec[]; credits: CreditRec[]; calls: CallRec[]; payouts: PayoutRec[]; refunds: RefundRec[] | null;
  liabilities: { callerWalletsApprox: number; hostEarningsApprox: number; note: string } | null; now: number;
}): Reconciliation {
  const days = new Map<string, DayRow>();
  const hasRefunds = a.refunds !== null;
  for (let t = a.fromMs; t < a.toMs; t += 86_400_000) days.set(istDateStr(t), emptyDay(istDateStr(t), hasRefunds));
  const inRange = (ms: number) => ms >= a.fromMs && ms < a.toMs;
  const day = (ms: number) => days.get(istDateStr(ms));

  for (const t of a.topups) {
    if (!isPaidTopup(t)) continue;
    const at = t.paid_at ?? t.created_at;
    if (!inRange(at)) continue;
    const d = day(at)!;
    d.topups.count++; d.topups.rupees += n(t.amount_rupees);
    const g = (d.topups.byGateway[t.gateway] ??= { count: 0, rupees: 0 });
    g.count++; g.rupees += n(t.amount_rupees);
  }
  for (const c of a.credits) {
    if (!inRange(c.created_at) || !creditTopupId(c)) continue;
    const d = day(c.created_at)!;
    d.walletCredits.count++; d.walletCredits.rupees += n(c.amount);
  }
  for (const c of a.calls) {
    if (!inRange(c.ts)) continue;
    const d = day(c.ts)!;
    const paid = Math.max(0, n(c.paid_rupees)), test = Math.max(0, n(c.test_rupees));
    const hp = Math.max(0, n(c.host_paid_rupees)), ht = Math.max(0, n(c.host_test_rupees));
    d.calls.paid += paid; d.calls.test += test; d.hostEarnings.paid += hp; d.hostEarnings.test += ht;
    d.platformShare.paid += Math.max(0, paid - hp); d.platformShare.test += Math.max(0, test - ht);
  }
  for (const p of a.payouts) {
    if (!inRange(p.paid_at)) continue;
    const d = day(p.paid_at)!;
    d.payouts.count++; d.payouts.rupees += n(p.amount_rupees);
  }
  for (const r of a.refunds ?? []) {
    if (!inRange(r.paid_at)) continue;
    const d = day(r.paid_at)!;
    d.refunds!.count++; d.refunds!.rupees += n(r.amount_rupees);
  }

  const rows = [...days.values()];
  const totals = emptyDay("total", hasRefunds);
  for (const d of rows) {
    totals.topups.count += d.topups.count; totals.topups.rupees += d.topups.rupees;
    for (const [g, v] of Object.entries(d.topups.byGateway)) {
      const t = (totals.topups.byGateway[g] ??= { count: 0, rupees: 0 });
      t.count += v.count; t.rupees += v.rupees;
    }
    totals.walletCredits.count += d.walletCredits.count; totals.walletCredits.rupees += d.walletCredits.rupees;
    totals.calls.paid += d.calls.paid; totals.calls.test += d.calls.test;
    totals.hostEarnings.paid += d.hostEarnings.paid; totals.hostEarnings.test += d.hostEarnings.test;
    totals.platformShare.paid += d.platformShare.paid; totals.platformShare.test += d.platformShare.test;
    totals.payouts.count += d.payouts.count; totals.payouts.rupees += d.payouts.rupees;
    if (hasRefunds) { totals.refunds!.count += d.refunds!.count; totals.refunds!.rupees += d.refunds!.rupees; }
  }
  const { date: _d, ...totalsOut } = totals;
  return {
    from: istDateStr(a.fromMs), to: istDateStr(a.toMs - 1), days: rows, totals: totalsOut,
    mismatches: detectTopupMismatches(a.topups, a.credits, a.fromMs, a.toMs, a.now),
    payouts: a.payouts.filter((p) => inRange(p.paid_at)).sort((x, y) => x.paid_at - y.paid_at),
    refundsAvailable: hasRefunds, liabilities: a.liabilities,
  };
}

/** Parse ?from&to (IST dates, inclusive). Defaults to the last 7 days. Returns an error string for a bad / too long range. */
export function parseRange(fromQ: string | null, toQ: string | null, now = Date.now()): { fromMs: number; toMs: number } | { error: string } {
  const today = istDayStart(now);
  const to = toQ ? parseIstDate(toQ) : today;
  const from = fromQ ? parseIstDate(fromQ) : (to ?? today) - 6 * 86_400_000;
  if (from === null || to === null) return { error: "from and to must be dates like 2026-10-01 (IST)." };
  if (to < from) return { error: "to must not be before from." };
  const toMs = to + 86_400_000;
  if ((toMs - from) / 86_400_000 > MAX_RANGE_DAYS) return { error: `Pick at most ${MAX_RANGE_DAYS} days at a time.` };
  return { fromMs: from, toMs };
}

const q = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function reconciliationCsv(r: Reconciliation): string {
  const head = ["date", "topups_count", "topups_rupees", "topups_by_gateway", "wallet_credits_count", "wallet_credits_rupees", "calls_paid", "calls_test", "host_earnings_paid", "host_earnings_test", "platform_share_paid", "platform_share_test", "payouts_count", "payouts_rupees", "refunds_count", "refunds_rupees"];
  const line = (label: string, d: Omit<DayRow, "date">) => [
    label, d.topups.count, d.topups.rupees, Object.entries(d.topups.byGateway).map(([g, v]) => `${g}:${v.count}/${v.rupees}`).join(" "),
    d.walletCredits.count, d.walletCredits.rupees, d.calls.paid, d.calls.test, d.hostEarnings.paid, d.hostEarnings.test, d.platformShare.paid, d.platformShare.test,
    d.payouts.count, d.payouts.rupees, d.refunds ? d.refunds.count : "", d.refunds ? d.refunds.rupees : "",
  ].map(q).join(",");
  const lines = [head.join(","), ...r.days.map((d) => line(d.date, d)), line("TOTAL", r.totals)];
  lines.push("", "mismatch_kind,topup_id,uid,topup_rupees,credit_rupees,detail");
  for (const m of r.mismatches) lines.push([m.kind, m.topupId, m.uid, m.topupRupees ?? "", m.creditRupees ?? "", m.detail].map(q).join(","));
  lines.push("", "payout_id,host_uid,rupees,utr,paid_on");
  for (const p of r.payouts) lines.push([p.id, p.host_uid, p.amount_rupees, p.utr ?? "", istDateStr(p.paid_at)].map(q).join(","));
  return lines.join("\n") + "\n";
}

// ── D1 reader ────────────────────────────────────────────────────────────────
const WIDE = 86_400_000;
export async function loadReconciliation(env: Env, fromMs: number, toMs: number, now = Date.now()): Promise<Reconciliation> {
  const m = env.DB_META, w = env.DB_WALLET;
  const [topups, credits, calls, payouts] = await Promise.all([
    m.prepare(
      `SELECT id, uid, amount_rupees, gateway, status, credited, paid_at, created_at FROM hf_topups
        WHERE (paid_at>=?1 AND paid_at<?2) OR (paid_at IS NULL AND created_at>=?1 AND created_at<?2) ORDER BY created_at LIMIT 5000`,
    ).bind(fromMs - WIDE, toMs + WIDE).all<TopupRec>().then((r) => r.results ?? []).catch(() => [] as TopupRec[]),
    w.prepare("SELECT ref, uid, amount, created_at FROM wallet_transactions WHERE type='hf_topup' AND created_at>=?1 AND created_at<?2 LIMIT 5000")
      .bind(fromMs - WIDE, toMs + WIDE).all<CreditRec>().then((r) => r.results ?? []).catch(() => [] as CreditRec[]),
    m.prepare(
      `SELECT COALESCE(ended_at, created_at) AS ts, paid_rupees, test_rupees, host_paid_rupees, host_test_rupees FROM hf_calls
        WHERE status='completed' AND billed_minutes>=1 AND COALESCE(ended_at, created_at)>=?1 AND COALESCE(ended_at, created_at)<?2 LIMIT 20000`,
    ).bind(fromMs, toMs).all<CallRec>().then((r) => r.results ?? []).catch(() => [] as CallRec[]),
    m.prepare("SELECT id, host_uid, amount_rupees, utr, paid_at FROM hf_payout_requests WHERE status='paid' AND paid_at>=?1 AND paid_at<?2 ORDER BY paid_at LIMIT 2000")
      .bind(fromMs, toMs).all<PayoutRec>().then((r) => r.results ?? []).catch(() => [] as PayoutRec[]),
  ]);

  // Refunds are owned by another branch (hf_refund_requests). Query defensively: no table / different columns = "not available", never an error.
  let refunds: RefundRec[] | null = null;
  try {
    // [HF-TOK-EXIT-1] SELECT * and filter in JS: Google Play refunds (kind 'play_refund') are reported in the token section, not here, and the
    // flag-off path must not need the new column.
    refunds = ((await m.prepare("SELECT *, COALESCE(refunded_at, updated_at) AS paid_at FROM hf_refund_requests WHERE status='refunded' AND COALESCE(refunded_at, updated_at)>=?1 AND COALESCE(refunded_at, updated_at)<?2 LIMIT 2000")
      .bind(fromMs, toMs).all<RefundRec & { kind?: string | null }>()).results ?? []).filter((r) => r.kind !== "play_refund");
  } catch { refunds = null; }

  let liabilities: Reconciliation["liabilities"] = null;
  try {
    const one = async (sql: string, ...b: unknown[]) => n((await m.prepare(sql).bind(...b).first<{ s: number }>())?.s);
    const topupsIn = await one("SELECT COALESCE(SUM(amount_rupees),0) AS s FROM hf_topups WHERE status='paid' AND credited=1 AND COALESCE(paid_at,created_at)<?1", toMs);
    const callPaid = await one("SELECT COALESCE(SUM(paid_rupees),0) AS s FROM hf_calls WHERE status='completed' AND COALESCE(ended_at,created_at)<?1", toMs);
    const hostPaid = await one("SELECT COALESCE(SUM(host_paid_rupees),0) AS s FROM hf_calls WHERE status='completed' AND COALESCE(ended_at,created_at)<?1", toMs);
    const paidOut = await one("SELECT COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests WHERE status='paid' AND paid_at<?1", toMs);
    let refundedOut = 0;
    try {
      const rows = (await m.prepare("SELECT * FROM hf_refund_requests WHERE status='refunded' AND COALESCE(refunded_at, updated_at)<?1").bind(toMs).all<{ amount_rupees: number; kind?: string | null }>()).results ?? [];
      refundedOut = rows.filter((r) => r.kind !== "play_refund").reduce((t, r) => t + n(r.amount_rupees), 0); // [HF-TOK-EXIT-1] same reason as above
    } catch { refundedOut = 0; }
    liabilities = {
      callerWalletsApprox: topupsIn - callPaid - refundedOut,
      hostEarningsApprox: hostPaid - paidOut,
      note: "Approximate, from the ledger: caller wallets = paid top-ups - paid call charges - paid refunds; hosts = paid earnings - paid withdrawals. Compare with the gateway balance.",
    };
  } catch { liabilities = null; }

  return buildReconciliation({ fromMs, toMs, topups, credits, calls, payouts, refunds, liabilities, now });
}
