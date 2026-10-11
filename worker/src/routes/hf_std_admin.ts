// [HF-STD-PLAN-1] Admin reporting for the Standard calling plan + the explicit rupee balance migration. Admin-only (isAdminUid, same gate as
// routes/hf_vobiz_admin.ts) and every request is written to admin_audit (DB_WALLET). Money in every response is PAISE (integers), times epoch ms.
//
//   GET  /api/admin/hf/std/calls?from=&to=&limit=&offset=[&format=csv]
//   GET  /api/admin/hf/std/summary?from=&to=[&format=csv]
//   POST /api/admin/hf/std/migrate-lots {dryRun?: boolean (default true)}
//
// from/to are epoch ms or YYYY-MM-DD (India day); `to` is inclusive; absent = today (India). Window rule for calls: the call's ended_at.
//
// ALL "platform" numbers here are ESTIMATES BEFORE OTHER EXPENSES (gateway/Google fees, servers, support, tax ...). They are NOT net profit.
//   platformBeforeOtherExpensesEstPaise      = charge - host earning - ESTIMATED phone cost (Rs 1/min by default)
//   platformBeforeOtherExpensesActualPaise   = charge - host earning - ACTUAL Vobiz cost (only when both legs' costs are on record)
import type { Env } from "../types";
import { json, CORS } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { istDayStart, parseIstDate } from "../lib/hf_ist";
import { lookupPeople } from "../lib/hf_vobiz_report";
import { tierBreakdown, validTariff, formatRupees, type Tariff, type TierLine } from "../lib/hf_token_math";
import { testPartOfCall } from "../lib/hf_reconcile_tokens";
import { MIN_LEGS_FOR_ACTUAL } from "../lib/hf_std_cost";
import { migrateLotsToRupees } from "../lib/hf_std_migrate";

const BASE = "/api/admin/hf/std/";
const DAY_MS = 86_400_000;
const NO_STORE = { "cache-control": "private, no-store" };
const MAX_ROWS = 20_000;
const err = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);
const n = (v: unknown): number => Math.trunc(Number(v ?? 0)) || 0;

/** Wording the admin pages must show next to every platform figure. */
export const PLATFORM_NOTE = "Platform figures are estimates before other expenses (payment-gateway/Google fees, servers, support, tax). They are not net profit.";

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_std_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: BASE, handled: true, extra: { area: "hf_std_admin", step: "admin_audit", action } }).catch(() => undefined);
  }
}

function dateOrMs(v: string | null): number | null {
  if (v == null || v === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return parseIstDate(v);
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
}
/** from/to default to today (India) when absent; `to` is inclusive and a bare date means the end of that India day. */
export function stdRange(url: URL, now = Date.now()): { from: number; to: number } {
  const fRaw = url.searchParams.get("from"), tRaw = url.searchParams.get("to");
  const f = dateOrMs(fRaw), t = dateOrMs(tRaw);
  const from = f ?? istDayStart(now);
  const to = t != null ? (/^\d{4}-\d{2}-\d{2}$/.test(tRaw ?? "") ? t + DAY_MS - 1 : t) : (f != null ? from + DAY_MS - 1 : istDayStart(now) + DAY_MS - 1);
  return { from, to: Math.max(to, from) };
}
const intParam = (v: string | null, def: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v ?? def)) || def));

// ── data ─────────────────────────────────────────────────────────────────────
interface CallRow {
  id: string; caller_uid: string; host_uid: string; created_at: number; connected_at: number | null; ended_at: number | null;
  billable_seconds: number | null; consumed_value_paise: number | null; charged_paise: number | null; host_earning_paise: number | null;
  call_cost_paise: number | null; platform_paise: number | null; phone_cost_actual_paise: number | null; pricing_snapshot: string | null; lots_used: string | null;
}
const CALL_COLS = "id, caller_uid, host_uid, created_at, connected_at, ended_at, billable_seconds, consumed_value_paise, charged_paise, host_earning_paise, call_cost_paise, platform_paise, phone_cost_actual_paise, pricing_snapshot, lots_used";

function tariffOf(snapshot: string | null): Tariff | null {
  if (!snapshot) return null;
  try { const j = JSON.parse(snapshot); return j && j.plan === "std" && validTariff(j.tariff) ? (j.tariff as Tariff) : null; } catch { return null; }
}

export interface StdCallRow {
  id: string; startedAt: number; endedAt: number | null;
  callerUid: string; callerName: string | null; hostUid: string; hostName: string | null;
  billableSeconds: number; plan: "standard" | "host_rate";
  chargePaise: number; hostPaise: number;
  phoneCostEstPaise: number; phoneCostActualPaise: number | null;
  /** charge - host - ESTIMATED phone cost. Before other expenses, not net profit. */
  platformBeforeOtherExpensesEstPaise: number;
  /** charge - host - ACTUAL phone cost; null until the actual cost is known. Before other expenses, not net profit. */
  platformBeforeOtherExpensesActualPaise: number | null;
  paidValuePaise: number; testValuePaise: number;
  tiers: TierLine[];
}
export interface StdTotals {
  calls: number; billableSeconds: number; chargePaise: number; hostPaise: number;
  phoneCostEstPaise: number; phoneCostActualPaise: number; callsWithActualCost: number;
  platformBeforeOtherExpensesEstPaise: number;
  /** Over the calls whose actual cost is known only: charge - host - actual. */
  platformBeforeOtherExpensesActualPaise: number;
  /** Charge - host - estimate for exactly those same calls, so the two figures above are comparable. */
  platformBeforeOtherExpensesEstForActualCallsPaise: number;
  paidValuePaise: number; testValuePaise: number;
}

async function loadWindow(env: Env, from: number, to: number): Promise<{ rows: CallRow[]; actual: Map<string, number | null> }> {
  const rows = ((await env.DB_META.prepare(
    `SELECT ${CALL_COLS} FROM hf_calls WHERE status='completed' AND ended_at IS NOT NULL AND ended_at>=?1 AND ended_at<=?2 ORDER BY ended_at DESC LIMIT ${MAX_ROWS}`,
  ).bind(from, to).all<CallRow>().catch(() => ({ results: [] as CallRow[] }))).results ?? []);
  const actual = new Map<string, number | null>();
  try {
    const legs = (await env.DB_META.prepare(
      `SELECT l.call_id AS call_id, COUNT(*) AS legs, COALESCE(SUM(l.total_cost_paise),0) AS cost, SUM(CASE WHEN l.total_cost_paise IS NULL THEN 1 ELSE 0 END) AS missing
         FROM hf_vobiz_legs l JOIN hf_calls c ON c.id=l.call_id
        WHERE c.status='completed' AND c.ended_at>=?1 AND c.ended_at<=?2 GROUP BY l.call_id`,
    ).bind(from, to).all<{ call_id: string; legs: number; cost: number; missing: number }>()).results ?? [];
    // same rule as sumActualLegCost: at least 2 legs on record and every one of them carries a cost
    for (const g of legs) actual.set(g.call_id, n(g.legs) >= MIN_LEGS_FOR_ACTUAL && n(g.missing) === 0 ? n(g.cost) : null);
  } catch { /* ledger table absent: stored column only */ }
  return { rows, actual };
}

function shape(r: CallRow, actual: Map<string, number | null>): Omit<StdCallRow, "callerName" | "hostName"> {
  const secs = Math.max(0, n(r.billable_seconds));
  const charge = Math.max(0, n(r.consumed_value_paise ?? r.charged_paise));
  const host = Math.max(0, n(r.host_earning_paise));
  const est = Math.max(0, n(r.call_cost_paise));
  const act = r.phone_cost_actual_paise != null ? n(r.phone_cost_actual_paise) : (actual.get(r.id) ?? null);
  const t = tariffOf(r.pricing_snapshot);
  const test = Math.min(charge, testPartOfCall(r.lots_used).valuePaise);
  return {
    id: r.id, startedAt: n(r.connected_at ?? r.created_at), endedAt: r.ended_at == null ? null : n(r.ended_at),
    callerUid: r.caller_uid, hostUid: r.host_uid, billableSeconds: secs, plan: t ? "standard" : "host_rate",
    chargePaise: charge, hostPaise: host, phoneCostEstPaise: est, phoneCostActualPaise: act,
    platformBeforeOtherExpensesEstPaise: charge - host - est,
    platformBeforeOtherExpensesActualPaise: act == null ? null : charge - host - act,
    paidValuePaise: charge - test, testValuePaise: test,
    tiers: t ? tierBreakdown(t, secs) : [],
  };
}

function totalsOf(rows: Array<ReturnType<typeof shape>>): StdTotals {
  const t: StdTotals = {
    calls: rows.length, billableSeconds: 0, chargePaise: 0, hostPaise: 0, phoneCostEstPaise: 0, phoneCostActualPaise: 0, callsWithActualCost: 0,
    platformBeforeOtherExpensesEstPaise: 0, platformBeforeOtherExpensesActualPaise: 0, platformBeforeOtherExpensesEstForActualCallsPaise: 0, paidValuePaise: 0, testValuePaise: 0,
  };
  for (const r of rows) {
    t.billableSeconds += r.billableSeconds; t.chargePaise += r.chargePaise; t.hostPaise += r.hostPaise; t.phoneCostEstPaise += r.phoneCostEstPaise;
    t.platformBeforeOtherExpensesEstPaise += r.platformBeforeOtherExpensesEstPaise; t.paidValuePaise += r.paidValuePaise; t.testValuePaise += r.testValuePaise;
    if (r.phoneCostActualPaise != null) {
      t.callsWithActualCost++; t.phoneCostActualPaise += r.phoneCostActualPaise;
      t.platformBeforeOtherExpensesActualPaise += r.platformBeforeOtherExpensesActualPaise ?? 0;
      t.platformBeforeOtherExpensesEstForActualCallsPaise += r.platformBeforeOtherExpensesEstPaise;
    }
  }
  return t;
}

export async function stdCallsReport(env: Env, from: number, to: number, limit = 50, offset = 0) {
  const { rows, actual } = await loadWindow(env, from, to);
  const shaped = rows.map((r) => shape(r, actual));
  const page = shaped.slice(offset, offset + limit);
  const people = await lookupPeople(env, page.flatMap((r) => [r.callerUid, r.hostUid]));
  const calls: StdCallRow[] = page.map((r) => ({ ...r, callerName: people.get(r.callerUid)?.name ?? null, hostName: people.get(r.hostUid)?.name ?? null }));
  return { from, to, limit, offset, count: shaped.length, truncated: rows.length >= MAX_ROWS, note: PLATFORM_NOTE, totals: totalsOf(shaped), calls };
}

export async function stdSummaryReport(env: Env, from: number, to: number) {
  const { rows, actual } = await loadWindow(env, from, to);
  const calls = totalsOf(rows.map((r) => shape(r, actual)));
  const one = async <T>(sql: string, ...b: unknown[]): Promise<T | null> => { try { return await env.DB_META.prepare(sql).bind(...b).first<T>(); } catch { return null; } };
  // top-ups: purchase lots made in the window; migration lots are the same money as the lot they replaced and are excluded when the column exists
  const topSql = (excl: string) =>
    `SELECT COUNT(*) AS c, COALESCE(SUM(paid_paise),0) AS paid, COALESCE(SUM(gst_paise),0) AS gst,
            COALESCE(SUM((tokens_granted_micro * redemption_paise_per_token + 500000) / 1000000),0) AS wallet
       FROM hf_token_lots WHERE kind='purchase' AND created_at>=?1 AND created_at<=?2 ${excl}`;
  const top = (await one<{ c: number; paid: number; gst: number; wallet: number }>(topSql("AND source_lot_id IS NULL"), from, to))
    ?? (await one<{ c: number; paid: number; gst: number; wallet: number }>(topSql("").replace("COALESCE(SUM(gst_paise),0)", "0"), from, to));
  const corr = await one<{ c: number; v: number }>("SELECT COUNT(*) AS c, COALESCE(SUM(rupee_value_paise),0) AS v FROM hf_token_ledger WHERE kind='call_refund' AND created_at>=?1 AND created_at<=?2", from, to);
  const rev = await one<{ c: number; v: number }>("SELECT COUNT(*) AS c, COALESCE(SUM(rupee_value_paise),0) AS v FROM hf_token_ledger WHERE kind='refund_revoke' AND created_at>=?1 AND created_at<=?2", from, to);
  const play = await one<{ c: number; v: number }>("SELECT COUNT(*) AS c, COALESCE(SUM(COALESCE(recorded_paise, amount_paise, 0)),0) AS v FROM hf_refund_requests WHERE kind='play_refund' AND status='refunded' AND refunded_at>=?1 AND refunded_at<=?2", from, to);
  return {
    from, to, note: PLATFORM_NOTE,
    topups: { count: n(top?.c), paidPaise: n(top?.paid), gstIncludedPaise: n(top?.gst), walletCreditedPaise: n(top?.wallet) },
    calls: {
      count: calls.calls, billableSeconds: calls.billableSeconds, chargePaise: calls.chargePaise, paidValuePaise: calls.paidValuePaise, testValuePaise: calls.testValuePaise,
      hostEarningsPaise: calls.hostPaise,
    },
    phoneCost: { estimatePaise: calls.phoneCostEstPaise, actualPaise: calls.phoneCostActualPaise, callsWithActualCost: calls.callsWithActualCost, callsTotal: calls.calls },
    platformBeforeOtherExpenses: {
      estimatePaise: calls.platformBeforeOtherExpensesEstPaise,
      afterActualPhoneCostPaise: calls.platformBeforeOtherExpensesActualPaise,
      estimateForCallsWithActualPaise: calls.platformBeforeOtherExpensesEstForActualCallsPaise,
      callsWithActualCost: calls.callsWithActualCost,
    },
    corrections: { count: n(corr?.c), paise: n(corr?.v) },
    topupRefunds: { revokedFromWalletCount: n(rev?.c), revokedFromWalletPaise: n(rev?.v), refundedByGoogleCount: n(play?.c), refundedByGooglePaise: n(play?.v) },
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const q = (v: string | number | null) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function stdCallsCsv(r: Awaited<ReturnType<typeof stdCallsReport>>): string {
  const head = ["call_id", "started_at", "ended_at", "caller", "host", "billable_seconds", "plan", "charge_paise", "host_paise", "phone_cost_est_paise", "phone_cost_actual_paise",
    "platform_before_other_expenses_est_paise", "platform_before_other_expenses_after_actual_paise", "paid_value_paise", "test_value_paise", "tiers"];
  const out = [`# ${PLATFORM_NOTE}`, head.join(",")];
  for (const c of r.calls) {
    out.push([c.id, new Date(c.startedAt).toISOString(), c.endedAt ? new Date(c.endedAt).toISOString() : "", c.callerName ?? c.callerUid, c.hostName ?? c.hostUid, c.billableSeconds, c.plan,
      c.chargePaise, c.hostPaise, c.phoneCostEstPaise, c.phoneCostActualPaise, c.platformBeforeOtherExpensesEstPaise, c.platformBeforeOtherExpensesActualPaise, c.paidValuePaise, c.testValuePaise,
      c.tiers.map((t) => `${t.fromMin}-${t.toMin ?? "end"}min@${t.paisePerMin}:${t.seconds}s=${t.amountPaise}`).join(" | ")].map(q).join(","));
  }
  return out.join("\n") + "\n";
}
export function stdSummaryCsv(s: Awaited<ReturnType<typeof stdSummaryReport>>): string {
  const rows: Array<[string, number]> = [
    ["topups_count", s.topups.count], ["topups_paid_paise", s.topups.paidPaise], ["topups_gst_included_paise", s.topups.gstIncludedPaise], ["topups_wallet_credited_paise", s.topups.walletCreditedPaise],
    ["calls_count", s.calls.count], ["calls_billable_seconds", s.calls.billableSeconds], ["call_charges_paise", s.calls.chargePaise], ["call_charges_paid_value_paise", s.calls.paidValuePaise],
    ["call_charges_test_value_paise", s.calls.testValuePaise], ["host_earnings_paise", s.calls.hostEarningsPaise],
    ["phone_cost_estimate_paise", s.phoneCost.estimatePaise], ["phone_cost_actual_paise", s.phoneCost.actualPaise], ["phone_cost_actual_known_calls", s.phoneCost.callsWithActualCost],
    ["platform_before_other_expenses_estimate_paise", s.platformBeforeOtherExpenses.estimatePaise],
    ["platform_before_other_expenses_after_actual_paise", s.platformBeforeOtherExpenses.afterActualPhoneCostPaise],
    ["platform_before_other_expenses_estimate_for_actual_calls_paise", s.platformBeforeOtherExpenses.estimateForCallsWithActualPaise],
    ["corrections_count", s.corrections.count], ["corrections_paise", s.corrections.paise],
    ["topup_refunds_revoked_count", s.topupRefunds.revokedFromWalletCount], ["topup_refunds_revoked_paise", s.topupRefunds.revokedFromWalletPaise],
    ["topup_refunds_google_count", s.topupRefunds.refundedByGoogleCount], ["topup_refunds_google_paise", s.topupRefunds.refundedByGooglePaise],
  ];
  return [`# ${PLATFORM_NOTE}`, "metric,value", ...rows.map(([k, v]) => `${k},${v}`), `period_from,${new Date(s.from).toISOString()}`, `period_to,${new Date(s.to).toISOString()}`].join("\n") + "\n";
}
const csvResponse = (body: string, name: string) => new Response(body, { status: 200, headers: { ...CORS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, ...NO_STORE } });

// ── route ────────────────────────────────────────────────────────────────────
export async function hfStdAdminRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith(BASE)) return null;
  const m = req.method;
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const sub = p.slice(BASE.length);
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error, u.error);
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden", "Forbidden.");
    const log = (action: string, meta: Record<string, unknown> = {}) => {
      const job = audit(env, u.uid, action, sub, { method: m, ...meta });
      try { ctx.waitUntil(job); } catch { void job; }
    };
    const csv = url.searchParams.get("format") === "csv";

    if (sub === "calls" && m === "GET") {
      const { from, to } = stdRange(url);
      log("calls", { q: url.search.slice(0, 200) });
      const r = await stdCallsReport(env, from, to, intParam(url.searchParams.get("limit"), 50, 1, csv ? MAX_ROWS : 500), intParam(url.searchParams.get("offset"), 0, 0, MAX_ROWS));
      return csv ? csvResponse(stdCallsCsv(r), "hf-standard-plan-calls.csv") : json(r, 200, NO_STORE);
    }
    if (sub === "summary" && m === "GET") {
      const { from, to } = stdRange(url);
      log("summary", { q: url.search.slice(0, 200) });
      const r = await stdSummaryReport(env, from, to);
      return csv ? csvResponse(stdSummaryCsv(r), "hf-standard-plan-summary.csv") : json(r, 200, NO_STORE);
    }
    if (sub === "migrate-lots" && m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { dryRun?: unknown };
      const dryRun = body.dryRun !== false; // only an explicit false writes
      const report = await migrateLotsToRupees(env, { dryRun });
      log("migrate_lots", { dryRun, lots: report.totals.lots, skipped: report.totals.skippedLots, beforePaise: report.totals.beforePaise, afterPaise: report.totals.afterPaise });
      const byReason = (reason: string) => report.skipped.filter((x) => x.reason === reason).length;
      const telemetry = track(env, u.uid, "hf_std_migration_batch", BRAND.slug, {
        phase: dryRun ? "dry_run" : "apply", outcome: report.done ? "done" : "remaining",
        migrated_count: report.totals.lots, repaired_count: report.repaired, remaining_count: report.remaining,
        skipped_count: report.totals.skippedLots, skipped_reserved: byReason("reserved"), skipped_conflict: byReason("conflict"),
        skipped_credit_failed: byReason("credit_failed"), skipped_dust_purchase: byReason("dust_purchase"),
        before_paise: report.totals.beforePaise, after_paise: report.totals.afterPaise, batches: report.batches,
      });
      try { ctx.waitUntil(telemetry); } catch { void telemetry; }
      return json({ ...report, formatted: { beforeTotal: formatRupees(report.totals.beforePaise), afterTotal: formatRupees(report.totals.afterPaise) } }, 200, NO_STORE);
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, extra: { area: "hf_std_admin" } }).catch(() => undefined);
    return err(500, "internal_error", "Something went wrong.");
  }
}
