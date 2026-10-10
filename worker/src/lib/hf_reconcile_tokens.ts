
// [HF-TOK-EXIT-1] Token-era reconciliation (HF-PAY-17 under tokens). Shown with the old reconciliation only while hfTokensEnabled is on.
// Per IST day: purchases (count, rupees paid, tokens granted), tokens spent and the rupee value they consumed, the call-cost / host / platform split,
// host earnings credited, refunds and revocations, debts, and TEST lots on their own line (never mixed with real money). Plus invariants, each
// failure listed as a mismatch:
//   lot_balance          left = granted + every ledger delta that changes a lot (grant, spend, revoke, debt clear, adjustment); reserved within 0..left
//   call_split           per call: consumed value = call cost + host + platform
//   host_earning_ledger  per call: the host ledger holds exactly the host share the call recorded
//   host_payout_ledger   per withdrawal: the ledger holds -amount while it is open or paid, and nothing once cancelled or rejected
//   host_balance_negative a host whose ledger balance (earnings - payouts) is below zero
//   purchase_without_lot / lot_without_purchase   a credited Play purchase must have its lot and every Play lot its purchase
// buildTokenReconciliation() is pure (rows in, report out); loadTokenReconciliation() is the D1 reader. Read-only: nothing here writes.
import type { Env } from "../types";
import { istDateStr } from "./hf_ist";

const DAY = 86_400_000;
const n = (v: unknown): number => Math.trunc(Number(v ?? 0)) || 0;

export interface LotRec { id: string; kind: string; created_at: number; tokens_granted_micro: number; paid_paise: number }
export interface CallRec {
  id: string; uid: string; ts: number; tokens_spent_micro: number | null; consumed_value_paise: number | null; call_cost_paise: number | null;
  host_earning_paise: number | null; platform_paise: number | null; lots_used: string | null;
}
export interface LedgerRec { kind: string; delta_micro: number; rupee_value_paise: number; created_at: number }
export interface HostLedgerRec { kind: string; amount_paise: number; created_at: number }
export interface PlayRefundRec { recorded_paise: number | null; refunded_at: number }

export type TokenMismatchKind =
  | "lot_balance" | "call_split" | "host_earning_ledger" | "host_payout_ledger" | "host_balance_negative" | "purchase_without_lot" | "lot_without_purchase";
export interface TokenMismatch { kind: TokenMismatchKind; ref: string; uid: string | null; expected: number | null; actual: number | null; detail: string }

export interface TokenDay {
  date: string;
  purchases: { count: number; paidPaise: number; tokensMicro: number };
  spent: { calls: number; tokensMicro: number; consumedPaise: number; callCostPaise: number; hostPaise: number; platformPaise: number };
  hostLedger: { earningsPaise: number; testEarningsPaise: number };
  refunds: { revocations: number; revokedMicro: number; revokedValuePaise: number; playRefunds: number; playRefundPaise: number; debtsCreated: number; debtsCreatedPaise: number; debtsWrittenOffPaise: number };
  testLots: { grantedLots: number; grantedMicro: number; spentMicro: number; spentValuePaise: number };
}
export interface TokenReconciliation {
  from: string; to: string; days: TokenDay[]; totals: Omit<TokenDay, "date">;
  openDebts: { count: number; valuePaise: number; tokensMicro: number };
  outstanding: { purchaseTokensMicro: number; testTokensMicro: number; hostBalancePaise: number };
  mismatches: TokenMismatch[];
}

const emptyDay = (date: string): TokenDay => ({
  date,
  purchases: { count: 0, paidPaise: 0, tokensMicro: 0 },
  spent: { calls: 0, tokensMicro: 0, consumedPaise: 0, callCostPaise: 0, hostPaise: 0, platformPaise: 0 },
  hostLedger: { earningsPaise: 0, testEarningsPaise: 0 },
  refunds: { revocations: 0, revokedMicro: 0, revokedValuePaise: 0, playRefunds: 0, playRefundPaise: 0, debtsCreated: 0, debtsCreatedPaise: 0, debtsWrittenOffPaise: 0 },
  testLots: { grantedLots: 0, grantedMicro: 0, spentMicro: 0, spentValuePaise: 0 },
});

/** Pure: micro-tokens and rupee value a call took from test / adjustment lots (from its lots_used JSON). */
export function testPartOfCall(lotsUsed: string | null): { micro: number; valuePaise: number } {
  let micro = 0, valuePaise = 0;
  try {
    const j = JSON.parse(lotsUsed ?? "[]");
    if (Array.isArray(j)) for (const u of j) if (u && u.kind !== "purchase") { micro += n(u.micro); valuePaise += n(u.valuePaise); }
  } catch { /* unreadable: counted as nothing */ }
  return { micro, valuePaise };
}

/** Pure: calls whose consumed value is not exactly call cost + host + platform. */
export function callSplitMismatches(calls: CallRec[]): TokenMismatch[] {
  const out: TokenMismatch[] = [];
  for (const c of calls) {
    const v = n(c.consumed_value_paise), sum = n(c.call_cost_paise) + n(c.host_earning_paise) + n(c.platform_paise);
    if (v !== sum) out.push({ kind: "call_split", ref: c.id, uid: c.uid, expected: v, actual: sum, detail: `Consumed ${v} paise but cost + host + platform = ${sum}` });
  }
  return out;
}

export function buildTokenReconciliation(a: {
  fromMs: number; toMs: number; lots: LotRec[]; calls: CallRec[]; ledger: LedgerRec[]; hostLedger: HostLedgerRec[]; playRefunds: PlayRefundRec[];
  openDebts: { count: number; valuePaise: number; tokensMicro: number }; outstanding: TokenReconciliation["outstanding"]; mismatches: TokenMismatch[];
}): TokenReconciliation {
  const days = new Map<string, TokenDay>();
  for (let t = a.fromMs; t < a.toMs; t += DAY) days.set(istDateStr(t), emptyDay(istDateStr(t)));
  const inRange = (ms: number) => ms >= a.fromMs && ms < a.toMs;
  const day = (ms: number) => days.get(istDateStr(ms));

  for (const l of a.lots) {
    if (!inRange(l.created_at)) continue;
    const d = day(l.created_at)!;
    if (l.kind === "purchase") { d.purchases.count++; d.purchases.paidPaise += n(l.paid_paise); d.purchases.tokensMicro += n(l.tokens_granted_micro); }
    else if (l.kind === "test") { d.testLots.grantedLots++; d.testLots.grantedMicro += n(l.tokens_granted_micro); }
  }
  for (const c of a.calls) {
    if (!inRange(c.ts)) continue;
    const d = day(c.ts)!;
    d.spent.calls++; d.spent.tokensMicro += n(c.tokens_spent_micro); d.spent.consumedPaise += n(c.consumed_value_paise);
    d.spent.callCostPaise += n(c.call_cost_paise); d.spent.hostPaise += n(c.host_earning_paise); d.spent.platformPaise += n(c.platform_paise);
    const t = testPartOfCall(c.lots_used);
    d.testLots.spentMicro += t.micro; d.testLots.spentValuePaise += t.valuePaise;
  }
  for (const l of a.ledger) {
    if (!inRange(l.created_at)) continue;
    const d = day(l.created_at)!;
    if (l.kind === "refund_revoke") { d.refunds.revocations++; d.refunds.revokedMicro += Math.abs(n(l.delta_micro)); d.refunds.revokedValuePaise += n(l.rupee_value_paise); }
    else if (l.kind === "debt_create") { d.refunds.debtsCreated++; d.refunds.debtsCreatedPaise += n(l.rupee_value_paise); }
    else if (l.kind === "debt_writeoff") d.refunds.debtsWrittenOffPaise += n(l.rupee_value_paise);
  }
  for (const h of a.hostLedger) {
    if (!inRange(h.created_at)) continue;
    const d = day(h.created_at)!;
    if (h.kind === "call_earning") d.hostLedger.earningsPaise += n(h.amount_paise);
    else if (h.kind === "call_earning_test") d.hostLedger.testEarningsPaise += n(h.amount_paise);
  }
  for (const r of a.playRefunds) {
    if (!inRange(r.refunded_at)) continue;
    const d = day(r.refunded_at)!;
    d.refunds.playRefunds++; d.refunds.playRefundPaise += n(r.recorded_paise);
  }
  const rows = [...days.values()];
  const totals = emptyDay("total");
  for (const d of rows) {
    for (const k of Object.keys(totals.purchases) as (keyof TokenDay["purchases"])[]) totals.purchases[k] += d.purchases[k];
    for (const k of Object.keys(totals.spent) as (keyof TokenDay["spent"])[]) totals.spent[k] += d.spent[k];
    for (const k of Object.keys(totals.hostLedger) as (keyof TokenDay["hostLedger"])[]) totals.hostLedger[k] += d.hostLedger[k];
    for (const k of Object.keys(totals.refunds) as (keyof TokenDay["refunds"])[]) totals.refunds[k] += d.refunds[k];
    for (const k of Object.keys(totals.testLots) as (keyof TokenDay["testLots"])[]) totals.testLots[k] += d.testLots[k];
  }
  const { date: _d, ...totalsOut } = totals;
  return { from: istDateStr(a.fromMs), to: istDateStr(a.toMs - 1), days: rows, totals: totalsOut, openDebts: a.openDebts, outstanding: a.outstanding, mismatches: a.mismatches };
}

// ── D1 reader ────────────────────────────────────────────────────────────────
async function rows<T>(env: Env, sql: string, ...b: unknown[]): Promise<T[] | null> {
  try { return (await env.DB_META.prepare(sql).bind(...b).all<T>()).results ?? []; } catch { return null; }
}

export async function loadTokenReconciliation(env: Env, fromMs: number, toMs: number): Promise<TokenReconciliation> {
  const mismatches: TokenMismatch[] = [];
  const [lots, calls, ledger, hostLedger, playRefunds] = await Promise.all([
    rows<LotRec>(env, "SELECT id, kind, created_at, tokens_granted_micro, paid_paise FROM hf_token_lots WHERE created_at>=?1 AND created_at<?2 LIMIT 20000", fromMs, toMs),
    rows<CallRec>(env,
      `SELECT id, caller_uid AS uid, COALESCE(ended_at, created_at) AS ts, tokens_spent_micro, consumed_value_paise, call_cost_paise, host_earning_paise, platform_paise, lots_used FROM hf_calls
        WHERE lots_used IS NOT NULL AND COALESCE(ended_at, created_at)>=?1 AND COALESCE(ended_at, created_at)<?2 LIMIT 20000`, fromMs, toMs),
    rows<LedgerRec>(env, "SELECT kind, delta_micro, rupee_value_paise, created_at FROM hf_token_ledger WHERE kind IN ('refund_revoke','debt_create','debt_writeoff') AND created_at>=?1 AND created_at<?2 LIMIT 20000", fromMs, toMs),
    rows<HostLedgerRec>(env, "SELECT kind, amount_paise, created_at FROM hf_host_ledger WHERE kind IN ('call_earning','call_earning_test') AND created_at>=?1 AND created_at<?2 LIMIT 20000", fromMs, toMs),
    rows<PlayRefundRec>(env, "SELECT recorded_paise, refunded_at FROM hf_refund_requests WHERE kind='play_refund' AND status='refunded' AND refunded_at>=?1 AND refunded_at<?2 LIMIT 5000", fromMs, toMs),
  ]);

  // invariants (whole ledger for lots / hosts / purchases; the chosen range for calls)
  const bal = await rows<{ id: string; uid: string; kind: string; status: string; left_m: number; reserved: number; net: number }>(env,
    `SELECT t.id, t.uid, t.kind, t.status, t.tokens_left_micro AS left_m, t.tokens_reserved_micro AS reserved, COALESCE(s.net,0) AS net
       FROM hf_token_lots t
       LEFT JOIN (SELECT lot_id, SUM(delta_micro) AS net FROM hf_token_ledger
                   WHERE kind IN ('purchase','admin_adjust','spend','refund_revoke','debt_clear') AND lot_id IS NOT NULL GROUP BY lot_id) s ON s.lot_id=t.id
      WHERE t.tokens_left_micro != COALESCE(s.net,0) OR t.tokens_left_micro < 0 OR t.tokens_reserved_micro < 0 OR t.tokens_reserved_micro > t.tokens_left_micro LIMIT 200`);
  for (const b of bal ?? []) {
    const detail = n(b.reserved) > n(b.left_m) || n(b.reserved) < 0 || n(b.left_m) < 0
      ? `Reserved ${n(b.reserved)} / left ${n(b.left_m)} micro-tokens is not possible`
      : `Lot (${b.kind}, ${b.status}) holds ${n(b.left_m)} micro-tokens but granted minus spent minus removed is ${n(b.net)}`;
    mismatches.push({ kind: "lot_balance", ref: b.id, uid: b.uid, expected: n(b.net), actual: n(b.left_m), detail });
  }
  mismatches.push(...callSplitMismatches(calls ?? []));
  const he = await rows<{ id: string; uid: string; e: number; led: number }>(env,
    `SELECT id, uid, e, led FROM (
       SELECT c.id AS id, c.host_uid AS uid, c.host_earning_paise AS e,
              COALESCE((SELECT SUM(l.amount_paise) FROM hf_host_ledger l WHERE l.call_id=c.id AND l.kind IN ('call_earning','call_earning_test')),0) AS led
         FROM hf_calls c WHERE c.lots_used IS NOT NULL AND COALESCE(c.host_earning_paise,0)>0 AND COALESCE(c.ended_at, c.created_at)>=?1 AND COALESCE(c.ended_at, c.created_at)<?2)
      WHERE led != e LIMIT 200`, fromMs, toMs);
  for (const r of he ?? []) mismatches.push({ kind: "host_earning_ledger", ref: r.id, uid: r.uid, expected: n(r.e), actual: n(r.led), detail: `Call recorded a host share of ${n(r.e)} paise but the host ledger holds ${n(r.led)}` });
  const po = await rows<{ id: string; uid: string; status: string; amt: number; net: number }>(env,
    `SELECT p.id AS id, p.host_uid AS uid, p.status AS status, p.amount_rupees AS amt,
            COALESCE((SELECT SUM(l.amount_paise) FROM hf_host_ledger l WHERE l.payout_id=p.id AND l.kind IN ('payout_reserve','payout_cancel')),0) AS net
       FROM hf_payout_requests p WHERE p.wallet_ref LIKE 'hfhl:%' LIMIT 3000`);
  for (const p of po ?? []) {
    const expected = ["requested", "approved", "paid"].includes(p.status) ? -n(p.amt) * 100 : 0;
    if (n(p.net) !== expected) mismatches.push({ kind: "host_payout_ledger", ref: p.id, uid: p.uid, expected, actual: n(p.net), detail: `Withdrawal is '${p.status}' for ₹${n(p.amt)} but the host ledger holds ${n(p.net)} paise for it` });
  }
  const neg = await rows<{ uid: string; bal: number }>(env,
    `SELECT host_uid AS uid, SUM(CASE WHEN kind IN ('call_earning','payout_reserve','payout_cancel','admin_adjust') THEN amount_paise ELSE 0 END) AS bal
       FROM hf_host_ledger GROUP BY host_uid HAVING bal < 0 LIMIT 200`);
  for (const h of neg ?? []) mismatches.push({ kind: "host_balance_negative", ref: h.uid, uid: h.uid, expected: 0, actual: n(h.bal), detail: `Host earnings minus withdrawals is ${n(h.bal)} paise` });
  const pw = await rows<{ order_id: string; uid: string; state: string }>(env,
    "SELECT p.order_id, p.uid, p.state FROM hf_play_purchases p LEFT JOIN hf_token_lots t ON t.id=p.lot_id WHERE p.state IN ('credited','consumed','refunded','revoked') AND t.id IS NULL LIMIT 200");
  for (const p of pw ?? []) mismatches.push({ kind: "purchase_without_lot", ref: p.order_id, uid: p.uid, expected: null, actual: null, detail: `Play purchase is '${p.state}' but no token lot exists for it` });
  const lw = await rows<{ id: string; uid: string; provider_ref: string | null }>(env,
    "SELECT t.id, t.uid, t.provider_ref FROM hf_token_lots t WHERE t.kind='purchase' AND t.provider='google_play' AND NOT EXISTS (SELECT 1 FROM hf_play_purchases p WHERE p.lot_id=t.id) LIMIT 200");
  for (const l of lw ?? []) mismatches.push({ kind: "lot_without_purchase", ref: l.id, uid: l.uid, expected: null, actual: null, detail: `Purchase lot (order ${l.provider_ref ?? "?"}) has no Play purchase record` });

  const od = (await rows<{ c: number; v: number; m: number }>(env, "SELECT COUNT(*) AS c, COALESCE(SUM(value_paise),0) AS v, COALESCE(SUM(amount_micro),0) AS m FROM hf_token_debts WHERE status='open'"))?.[0];
  const out = (await rows<{ pm: number; tm: number }>(env,
    "SELECT COALESCE(SUM(CASE WHEN kind='purchase' THEN tokens_left_micro END),0) AS pm, COALESCE(SUM(CASE WHEN kind='test' THEN tokens_left_micro END),0) AS tm FROM hf_token_lots WHERE status='active'"))?.[0];
  const hb = (await rows<{ b: number }>(env,
    "SELECT COALESCE(SUM(CASE WHEN kind IN ('call_earning','payout_reserve','payout_cancel','admin_adjust') THEN amount_paise ELSE 0 END),0) AS b FROM hf_host_ledger"))?.[0];

  return buildTokenReconciliation({
    fromMs, toMs, lots: lots ?? [], calls: calls ?? [], ledger: ledger ?? [], hostLedger: hostLedger ?? [], playRefunds: playRefunds ?? [],
    openDebts: { count: n(od?.c), valuePaise: n(od?.v), tokensMicro: n(od?.m) },
    outstanding: { purchaseTokensMicro: n(out?.pm), testTokensMicro: n(out?.tm), hostBalancePaise: n(hb?.b) },
    mismatches,
  });
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const q = (v: string | number | null) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function tokenReconciliationCsv(r: TokenReconciliation): string {
  const head = [
    "date", "purchases_count", "purchases_paid_paise", "purchases_tokens_micro", "calls", "tokens_spent_micro", "consumed_value_paise", "call_cost_paise", "host_paise", "platform_paise",
    "host_ledger_earnings_paise", "host_ledger_test_earnings_paise", "revocations", "revoked_tokens_micro", "revoked_value_paise", "play_refunds", "play_refunds_paise",
    "debts_created", "debts_created_paise", "debts_written_off_paise", "test_lots_granted", "test_tokens_granted_micro", "test_tokens_spent_micro", "test_value_spent_paise",
  ];
  const line = (label: string, d: Omit<TokenDay, "date">) => [
    label, d.purchases.count, d.purchases.paidPaise, d.purchases.tokensMicro, d.spent.calls, d.spent.tokensMicro, d.spent.consumedPaise, d.spent.callCostPaise, d.spent.hostPaise, d.spent.platformPaise,
    d.hostLedger.earningsPaise, d.hostLedger.testEarningsPaise, d.refunds.revocations, d.refunds.revokedMicro, d.refunds.revokedValuePaise, d.refunds.playRefunds, d.refunds.playRefundPaise,
    d.refunds.debtsCreated, d.refunds.debtsCreatedPaise, d.refunds.debtsWrittenOffPaise, d.testLots.grantedLots, d.testLots.grantedMicro, d.testLots.spentMicro, d.testLots.spentValuePaise,
  ].map(q).join(",");
  const out = ["", "TOKENS (money in paise, tokens in micro-tokens: 1 token = 1000000)", head.join(","), ...r.days.map((d) => line(d.date, d)), line("TOTAL", r.totals)];
  out.push("", "open_debts_count,open_debts_value_paise,open_debts_tokens_micro,purchase_tokens_outstanding_micro,test_tokens_outstanding_micro,host_balance_paise");
  out.push([r.openDebts.count, r.openDebts.valuePaise, r.openDebts.tokensMicro, r.outstanding.purchaseTokensMicro, r.outstanding.testTokensMicro, r.outstanding.hostBalancePaise].map(q).join(","));
  out.push("", "token_mismatch_kind,ref,uid,expected,actual,detail");
  for (const m of r.mismatches) out.push([m.kind, m.ref, m.uid, m.expected, m.actual, m.detail].map(q).join(","));
  return out.join("\n") + "\n";
}
