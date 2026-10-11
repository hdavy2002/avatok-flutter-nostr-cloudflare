// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-STD-PLAN-1] Admin Standard-plan reporting: per-call rows, totals, summary, CSV, labels, and the actual-phone-cost join.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot } from "../lib/hf_token_ledger";
import { stdTariff, paiseToMicro, topupSplit } from "../lib/hf_token_math";
import { refreshActualPhoneCost, sumActualLegCost } from "../lib/hf_std_cost";
import { stdCallsReport, stdSummaryReport, stdCallsCsv, stdSummaryCsv, stdRange, PLATFORM_NOTE, hfStdAdminRoute } from "./hf_std_admin";

let env: any;
const raw = () => env.DB_META._raw;
const NOW = Date.UTC(2026, 9, 11, 6, 0, 0);
const snap = JSON.stringify({ plan: "std", tariff: stdTariff(), hostPaisePerMin: 200, phoneCostPaisePerMin: 100 });

function addCall(id: string, o: any = {}) {
  raw().prepare(
    `INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, connected_at, ended_at, billable_seconds, consumed_value_paise, charged_paise, host_earning_paise, call_cost_paise, platform_paise, pricing_snapshot, lots_used)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, o.caller ?? "c1", o.host ?? "h1", 0, o.status ?? "completed", NOW - 3600_000, NOW - 3600_000, o.ended ?? NOW, o.secs ?? 3600, o.charge ?? 22470, o.charge ?? 22470, o.hostP ?? 12000, o.est ?? 6000,
    (o.charge ?? 22470) - (o.hostP ?? 12000) - (o.est ?? 6000), o.snap === undefined ? snap : o.snap, o.lots ?? JSON.stringify([{ lotId: "L", micro: 1, valuePaise: o.charge ?? 22470, kind: "purchase" }]));
}
function addLeg(id: string, callId: string, cost: number | null, role = "host") {
  raw().prepare("INSERT INTO hf_vobiz_legs (leg_uuid, call_id, role, total_cost_paise, source, created_at, row_hash, prev_hash) VALUES (?,?,?,?,?,?,?,?)").run(id, callId, role, cost, "webhook", NOW, "h", "");
}
beforeEach(() => { env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-10-hf-vobiz-spend.sql"], { alters: true }) }; });

const W = [Math.min(NOW, Date.now()) - 86_400_000, Math.max(NOW, Date.now()) + 86_400_000] as const;

describe("actual phone cost", () => {
  it("sums both legs; null with fewer than 2 legs or any missing cost", () => {
    expect(sumActualLegCost([{ total_cost_paise: 31 }, { total_cost_paise: 29 }])).toBe(60);
    expect(sumActualLegCost([{ total_cost_paise: 31 }])).toBeNull();
    expect(sumActualLegCost([{ total_cost_paise: 31 }, { total_cost_paise: null }])).toBeNull();
  });
  it("refreshActualPhoneCost stores it on the call row once both legs are in, and never throws", async () => {
    addCall("call_aaaa1111");
    addLeg("L1", "call_aaaa1111", 31);
    expect(await refreshActualPhoneCost(env, "call_aaaa1111")).toBeNull();
    addLeg("L2", "call_aaaa1111", 29, "caller");
    expect(await refreshActualPhoneCost(env, "call_aaaa1111")).toBe(60);
    expect(raw().prepare("SELECT phone_cost_actual_paise AS a FROM hf_calls WHERE id='call_aaaa1111'").get().a).toBe(60);
    expect(await refreshActualPhoneCost({ DB_META: { prepare() { throw new Error("db down"); } } } as any, "x")).toBeNull();
  });
});

describe("stdCallsReport", () => {
  it("60 min call: customer 224.70, host 120.00, phone est 60.00, platform est 44.70; tiers add up; actual joined from legs", async () => {
    addCall("call_aaaa1111");
    addLeg("L1", "call_aaaa1111", 3100); addLeg("L2", "call_aaaa1111", 2900, "caller"); // Rs 60.00 actual
    addCall("call_bbbb2222", { charge: 11970, secs: 1800, hostP: 6000, est: 3000 }); // no legs: actual unknown
    addCall("call_cccc3333", { status: "failed" });
    addCall("call_dddd4444", { snap: null, lots: JSON.stringify([{ lotId: "T", micro: 1, valuePaise: 500, kind: "test" }]), charge: 1000, secs: 100, hostP: 500, est: 100 });
    const r = await stdCallsReport(env, ...W);
    expect(r.count).toBe(3);
    expect(r.note).toBe(PLATFORM_NOTE);
    const a = r.calls.find((c) => c.id === "call_aaaa1111");
    expect(a).toMatchObject({ billableSeconds: 3600, plan: "standard", chargePaise: 22470, hostPaise: 12000, phoneCostEstPaise: 6000, phoneCostActualPaise: 6000,
      platformBeforeOtherExpensesEstPaise: 4470, platformBeforeOtherExpensesActualPaise: 4470, paidValuePaise: 22470, testValuePaise: 0 });
    expect(a.tiers.map((t) => t.amountPaise)).toEqual([11970, 10500]);
    expect(a.tiers.reduce((t, x) => t + x.amountPaise, 0)).toBe(22470);
    const b = r.calls.find((c) => c.id === "call_bbbb2222");
    expect(b.phoneCostActualPaise).toBeNull();
    expect(b.platformBeforeOtherExpensesActualPaise).toBeNull();
    const d = r.calls.find((c) => c.id === "call_dddd4444");
    expect(d).toMatchObject({ plan: "host_rate", testValuePaise: 500, paidValuePaise: 500, tiers: [] });
    expect(r.totals).toMatchObject({ calls: 3, chargePaise: 22470 + 11970 + 1000, hostPaise: 12000 + 6000 + 500, phoneCostEstPaise: 9100, callsWithActualCost: 1, phoneCostActualPaise: 6000,
      platformBeforeOtherExpensesActualPaise: 4470, platformBeforeOtherExpensesEstForActualCallsPaise: 4470, testValuePaise: 500 });
  });
  it("paging and the window", async () => {
    addCall("call_aaaa1111"); addCall("call_bbbb2222", { ended: NOW - 10 }); addCall("call_old00000", { ended: NOW - 5 * 86_400_000 });
    const r = await stdCallsReport(env, ...W, 1, 1);
    expect(r.count).toBe(2); expect(r.calls.length).toBe(1); expect(r.calls[0].id).toBe("call_bbbb2222");
  });
  it("CSV carries the label and the figures", async () => {
    addCall("call_aaaa1111");
    const csv = stdCallsCsv(await stdCallsReport(env, ...W));
    expect(csv.split("\n")[0]).toContain("not net profit");
    expect(csv).toContain("call_aaaa1111");
    expect(csv).toContain("22470");
  });
});

describe("stdSummaryReport", () => {
  it("top-ups with GST, calls, corrections and refunds", async () => {
    const s = topupSplit(12000, 1800);
    await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(s.walletPaise), paidPaise: 12000, gstPaise: s.gstPaise, provider: "google_play", providerRef: "O1" }, "hfplay:O1");
    addCall("call_aaaa1111"); addLeg("L1", "call_aaaa1111", 3100); addLeg("L2", "call_aaaa1111", 2900, "caller"); raw().prepare("UPDATE hf_calls SET phone_cost_actual_paise=6000 WHERE id='call_aaaa1111'").run();
    const ins = (op: string, kind: string, v: number) => raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(op, "u1", kind, null, 0, v, op, NOW);
    ins("cr1", "call_refund", 399); ins("rv1", "refund_revoke", 5000);
    const r = await stdSummaryReport(env, ...W);
    expect(r.topups).toEqual({ count: 1, paidPaise: 12000, gstIncludedPaise: 1831, walletCreditedPaise: 10169 });
    expect(r.calls).toMatchObject({ count: 1, chargePaise: 22470, hostEarningsPaise: 12000 });
    expect(r.phoneCost).toMatchObject({ estimatePaise: 6000, actualPaise: 6000, callsWithActualCost: 1 });
    expect(r.platformBeforeOtherExpenses.estimatePaise).toBe(4470);
    expect(r.corrections).toEqual({ count: 1, paise: 399 });
  });
  it("corrections and refunds inside the window", async () => {
    const ins = (op: string, kind: string, v: number) => raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(op, "u1", kind, null, 0, v, op, NOW);
    ins("cr1", "call_refund", 399); ins("rv1", "refund_revoke", 5000);
    const r = await stdSummaryReport(env, ...W);
    expect(r.corrections).toEqual({ count: 1, paise: 399 });
    expect(r.topupRefunds).toMatchObject({ revokedFromWalletCount: 1, revokedFromWalletPaise: 5000 });
    expect(stdSummaryCsv(r)).toContain("corrections_paise,399");
    expect(stdSummaryCsv(r).split("\n")[0]).toContain("not net profit");
  });
});

describe("range + auth", () => {
  it("dates mean India days, `to` inclusive", () => {
    const r = stdRange(new URL("https://x/api/admin/hf/std/calls?from=2026-10-11&to=2026-10-11"));
    expect(r.to - r.from).toBe(86_400_000 - 1);
    expect(stdRange(new URL("https://x/y?from=5&to=9"))).toEqual({ from: 5, to: 9 });
  });
  it("other paths are not ours; no token is refused", async () => {
    expect(await hfStdAdminRoute(new Request("https://x/api/admin/hf/other"), env, {} as any)).toBeNull();
    const r = await hfStdAdminRoute(new Request("https://x/api/admin/hf/std/summary"), env, {} as any);
    expect(r && r.status >= 400).toBe(true);
  });
});
