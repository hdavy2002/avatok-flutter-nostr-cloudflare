// @ts-nocheck -- uses node:sqlite via the shim
// [HF-WIRE-13] Call money rules (HF-REEL-35/36), rules 1-9 with numbers. Pure rules first, then the real ledger + the monitor on in-memory SQLite.
import { describe, it, expect, beforeEach, vi } from "vitest";
const cfg = vi.hoisted(() => ({ v: {} as Record<string, unknown> }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("../routes/config", () => ({ readConfig: async () => cfg.v }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "admin1" }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("./preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary } from "./hf_token_ledger";
import { prepareTokenStart, settleTokenCall, stdSnapshotFor } from "./hf_token_calls";
import { readHfTokenConfig, readHfStdPlan } from "./hf_token_config";
import { paiseToMicro, STD_TECH_MAX_SECONDS } from "./hf_token_math";
import {
  moneyRulesFrom, readMoneyRules, lowBalanceMessage, firstMinuteMessage, firstMinuteDrop, judgeCall, splitPayoutSources, payoutMinimumRupees,
  RULE_FIRST_MINUTE_OVERCHARGE, RULE_NOT_JOINED_CHARGED, RULE_JOINED_CHARGE_MISMATCH, RULE_HOST_PAID_NOT_JOINED,
} from "./hf_money_rules";
import { runHfMoneyMonitor } from "./hf_money_monitor";
import { fanWithdrawablePaise, takeFanPayout, returnFanPayout, fanTakenPaise } from "./hf_fan_payout";
import { hfMoneyAuditRoute } from "../routes/hf_money_audit";

const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql",
  "2026-10-19-hf-money-audit.sql", "2026-10-19-hf-money-rules-alters.sql"];
const TK = readHfTokenConfig({ hfTokensEnabled: true });
const STD = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 });
let env: any;
const q = (sql: string, ...a: unknown[]) => env.DB_META._raw.prepare(sql).all(...a);
const row = (id: string) => env.DB_META._raw.prepare("SELECT * FROM hf_calls WHERE id=?").get(id);
beforeEach(() => {
  env = { DB_META: makeDb(MIGS, { alters: true }) };
  cfg.v = { hfCallsEnabled: true };
});
const lot = (uid: string, paise: number, op: string, kind: "purchase" | "test" = "purchase") =>
  creditLot(env, uid, { kind, pricingVersion: kind === "test" ? "pt-v1" : "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(paise), paidPaise: kind === "test" ? 0 : paise, provider: kind === "test" ? "admin" : "google_play", providerRef: op }, op);
const NOW = Date.now();

/** A call that was started on the real ledger and settled with `seconds` joined (joined=false = never joined). */
async function call(id: string, o: { seconds: number; joined: boolean; drop?: number; endedAgoMs?: number; wallet?: number }) {
  await lot("u1", o.wallet ?? 30000, `lot-${id}`);
  const endedAt = NOW - (o.endedAgoMs ?? 10 * 60_000);
  env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, connected_at, ended_at, tax_mode, split_rule_version) VALUES (?,?,?,399,'completed',?,?,?, 'none_unregistered','std-r1/std-split-v1')")
    .run(id, "u1", "h1", endedAt - 600_000, o.joined ? endedAt - o.seconds * 1000 : null, endedAt);
  const st = await prepareTokenStart(env, { uid: "u1", callId: id, ratePaise: 0, tk: TK, std: STD });
  expect(st.ok).toBe(true);
  return settleTokenCall(env, { callId: id, callerUid: "u1", hostUid: "h1", ratePaise: 399, callCostPaisePerMin: 100, hostShareBps: 0, connectedSeconds: o.seconds,
    maxSeconds: STD_TECH_MAX_SECONDS, endedAt, std: stdSnapshotFor(STD).std, joined: o.joined, dropChargePaise: o.drop ?? 0 });
}

describe("rule config and wording", () => {
  it("defaults are the owner's numbers: Rs 20 to call, Rs 1 for a first-minute break, no payout minimum (HF-REEL-38), gateway refunds off", () => {
    expect(moneyRulesFrom({})).toMatchObject({ minBalancePaise: 2000, dropChargePaise: 100, fanPayoutMinRupees: 0, gatewayRefundsEnabled: false, monitorEnabled: true });
    expect(moneyRulesFrom({ hfFanPayoutMinRupees: 0 }).fanPayoutMinRupees).toBe(0);
    expect(moneyRulesFrom({ hfCallMinBalanceRupees: 30, hfFirstMinuteDropChargePaise: 200, hfFanPayoutMinRupees: 250 })).toMatchObject({ minBalancePaise: 3000, dropChargePaise: 200, fanPayoutMinRupees: 250 });
  });
  it("the app words are exact", () => {
    expect(lowBalanceMessage(2000)).toBe("You need at least ₹20 in your wallet to call. Top up to keep going.");
    expect(firstMinuteMessage(100)).toBe("Call ended in the first minute. We charged ₹1 and returned the rest to your wallet.");
  });
  it("rule 3 boundary: 59 s joined is a drop, exactly 60 s is billed normally, never joined is not a drop", () => {
    expect(firstMinuteDrop({ joined: true, connectedSeconds: 59, dropChargePaise: 100 })).toEqual({ applies: true, chargePaise: 100 });
    expect(firstMinuteDrop({ joined: true, connectedSeconds: 60, dropChargePaise: 100 }).applies).toBe(false);
    expect(firstMinuteDrop({ joined: false, connectedSeconds: 10, dropChargePaise: 100 }).applies).toBe(false);
    expect(firstMinuteDrop({ joined: true, connectedSeconds: 10, dropChargePaise: 0 }).applies).toBe(false);
  });
});

describe("rule 1: Rs 20 to start", () => {
  it("Rs 19.99 is low balance with the owner's message; Rs 20 starts", async () => {
    await lot("low", 1999, "l1");
    const a = await prepareTokenStart(env, { uid: "low", callId: "cl1", ratePaise: 0, tk: TK, std: STD, minBalancePaise: 2000 });
    expect(a).toMatchObject({ ok: false, status: 402, error: "low_balance", message: "You need at least ₹20 in your wallet to call. Top up to keep going." });
    expect(a.extra.minBalancePaise).toBe(2000);
    expect((await balanceSummary(env, "low")).totalPaise).toBe(1999); // nothing reserved
    await lot("ok", 2000, "l2");
    expect((await prepareTokenStart(env, { uid: "ok", callId: "cl2", ratePaise: 0, tk: TK, std: STD, minBalancePaise: 2000 })).ok).toBe(true);
  });
  it("flags off / no minimum passed: behaviour unchanged (the old reserve rule alone decides)", async () => {
    await lot("u2", 1999, "l3"); await lot("u3", 1999, "l4");
    const noMin = await prepareTokenStart(env, { uid: "u2", callId: "cl3", ratePaise: 0, tk: TK, std: STD });
    const zero = await prepareTokenStart(env, { uid: "u3", callId: "cl4", ratePaise: 0, tk: TK, std: STD, minBalancePaise: 0 });
    expect(noMin.ok).toBe(zero.ok);
    if (!noMin.ok) expect(noMin.message).not.toContain("at least ₹20");
  });
});

describe("rules 2-6: what a call costs", () => {
  it("rule 3: joined 30 s and broke = exactly Rs 1, the rest stays in the wallet, the influencer earns nothing", async () => {
    const r = await call("c30", { seconds: 30, joined: true, drop: 100 });
    expect(r).toMatchObject({ consumedValuePaise: 100, hostPaise: 0, moneyRule: "first_minute_drop" });
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 100);
    expect(row("c30")).toMatchObject({ consumed_value_paise: 100, host_earning_paise: 0, money_rule: "first_minute_drop" });
    expect(q("SELECT 1 FROM hf_host_ledger WHERE call_id='c30'")).toHaveLength(0);
  });
  it("rule 2/6: a call joined for 60 s or more is billed normally per second and nothing is returned", async () => {
    const r = await call("c90", { seconds: 90, joined: true, drop: 100 });
    expect(r.moneyRule).toBeNull();
    expect(r.consumedValuePaise).toBeGreaterThan(100);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - r.consumedValuePaise);
  });
  it("rule 4: never joined (declined / cancelled / no answer) costs nothing and the whole reserve is released", async () => {
    const r = await call("cno", { seconds: 0, joined: false, drop: 100 });
    expect(r.consumedValuePaise).toBe(0);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000);
    expect((await balanceSummary(env, "u1")).reservedPaise ?? 0).toBe(0);
  });
  it("rule 3 off (drop charge 0): the old behaviour, the short call is billed by the second", async () => {
    const r = await call("coff", { seconds: 30, joined: true, drop: 0 });
    expect(r.moneyRule).toBeNull();
    expect(r.consumedValuePaise).toBeGreaterThan(0);
    expect(r.consumedValuePaise).not.toBe(100);
  });
});

describe("judgeCall (the monitor's maths)", () => {
  const base = { status: "completed", connectedAt: 1000, endedAt: 31_000, chargedPaise: 0, normalChargePaise: 200, hostEarningPaise: 0, joinedSeconds: 30, settled: true };
  it("first-minute overcharge is refunded down to Rs 1; exactly Rs 1 is fine; less than Rs 1 is shown to an admin", () => {
    expect(judgeCall({ ...base, chargedPaise: 200 }, { dropChargePaise: 100 })).toMatchObject({ kind: "refund", rule: RULE_FIRST_MINUTE_OVERCHARGE, refundPaise: 100, expectedPaise: 100 });
    expect(judgeCall({ ...base, chargedPaise: 100 }, { dropChargePaise: 100 })).toEqual({ kind: "ok" });
    expect(judgeCall({ ...base, chargedPaise: 0 }, { dropChargePaise: 100 }).kind).toBe("flag");
  });
  it("never joined but charged is refunded in full; a host paid for a call that never joined is flagged, not touched", () => {
    const nj = { ...base, connectedAt: null, joinedSeconds: 0 };
    expect(judgeCall({ ...nj, chargedPaise: 500 }, { dropChargePaise: 100 })).toMatchObject({ kind: "refund", rule: RULE_NOT_JOINED_CHARGED, refundPaise: 500, expectedPaise: 0 });
    expect(judgeCall({ ...nj, hostEarningPaise: 300 }, { dropChargePaise: 100 })).toMatchObject({ kind: "flag", rule: RULE_HOST_PAID_NOT_JOINED });
  });
  it("rule 6: a made call that differs from the frozen price is flagged, never auto-refunded", () => {
    const made = { ...base, joinedSeconds: 120, chargedPaise: 900, normalChargePaise: 700 };
    expect(judgeCall(made, { dropChargePaise: 100 })).toMatchObject({ kind: "flag", rule: RULE_JOINED_CHARGE_MISMATCH });
    expect(judgeCall({ ...made, chargedPaise: 700 }, { dropChargePaise: 100 })).toEqual({ kind: "ok" });
  });
  it("a call still being settled is skipped", () => {
    expect(judgeCall({ ...base, settled: false, chargedPaise: 999 }, { dropChargePaise: 100 })).toEqual({ kind: "ok" });
  });
});

describe("rule 9: the monitor", () => {
  it("fixes a first-minute overcharge ONCE (run twice = one fix), refund goes to the wallet, never the gateway", async () => {
    const gw = vi.fn(() => { throw new Error("gateway must not be called"); });
    vi.stubGlobal("fetch", gw);
    const r = await call("bad30", { seconds: 30, joined: true, drop: 0 }); // settled by the OLD rules: charged by the second
    const charged = r.consumedValuePaise;
    expect(charged).toBeGreaterThan(100);
    const first = await runHfMoneyMonitor(env, NOW);
    expect(first.fixed).toBe(1);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 100); // wallet now holds all but the Rs 1
    const second = await runHfMoneyMonitor(env, NOW + 60_000);
    expect(second.fixed).toBe(0);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 100);
    expect(q("SELECT 1 FROM hf_token_ledger WHERE kind='call_refund' AND call_id='bad30'")).toHaveLength(1);
    expect(q("SELECT status, rule, fix_op_id FROM hf_money_audit")).toEqual([{ status: "fixed", rule: RULE_FIRST_MINUTE_OVERCHARGE, fix_op_id: "hfcorr:bad30" }]);
    expect(gw).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("a correct first-minute call and a correct normal call are left alone", async () => {
    await call("good30", { seconds: 30, joined: true, drop: 100 });
    const s = await runHfMoneyMonitor(env, NOW);
    expect(s).toMatchObject({ fixed: 0, flagged: 0 });
    expect(q("SELECT 1 FROM hf_money_audit")).toHaveLength(0);
  });
  it("what it must not fix goes to the admin table (idempotent) and the admin route lists it; money is not touched", async () => {
    await call("odd", { seconds: 120, joined: true, drop: 100 });
    env.DB_META._raw.prepare("UPDATE hf_calls SET consumed_value_paise=consumed_value_paise+500, charged_paise=charged_paise+500 WHERE id='odd'").run();
    const before = (await balanceSummary(env, "u1")).totalPaise;
    await runHfMoneyMonitor(env, NOW); await runHfMoneyMonitor(env, NOW + 1000);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(before);
    expect(q("SELECT status, rule FROM hf_money_audit")).toEqual([{ status: "open", rule: RULE_JOINED_CHARGE_MISMATCH }]);
    const res = await hfMoneyAuditRoute(new Request("https://x/api/admin/hf/money-audit?status=open"), env, "/api/admin/hf/money-audit");
    const body = await res.json();
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0]).toMatchObject({ subject_id: "odd", rule: RULE_JOINED_CHARGE_MISMATCH, status: "open", uid: "u1" });
    expect(body.counts.open).toBe(1);
  });
  it("auto-fix off: an overcharge is only written to the admin table", async () => {
    cfg.v = { hfCallsEnabled: true, hfMoneyMonitorAutoFix: false };
    await call("bad2", { seconds: 20, joined: true, drop: 0 });
    const before = (await balanceSummary(env, "u1")).totalPaise;
    const s = await runHfMoneyMonitor(env, NOW);
    expect(s.fixed).toBe(0);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(before);
    expect(q("SELECT status FROM hf_money_audit")).toEqual([{ status: "open" }]);
  });
  it("flags off: the monitor does nothing", async () => {
    await call("bad3", { seconds: 20, joined: true, drop: 0 });
    for (const c of [{ hfCallsEnabled: false }, { hfCallsEnabled: true, hfMoneyMonitorEnabled: false }]) {
      cfg.v = c;
      expect(await runHfMoneyMonitor(env, NOW)).toMatchObject({ scannedCalls: 0, fixed: 0, flagged: 0 });
    }
    expect(q("SELECT 1 FROM hf_money_audit")).toHaveLength(0);
  });
});

describe("rule 7: refunds only to the wallet", () => {
  it("gateway refunds are off unless the flag is set", async () => {
    expect((await readMoneyRules(env)).gatewayRefundsEnabled).toBe(false);
    cfg.v = { hfGatewayRefundsEnabled: true };
    expect((await readMoneyRules(env)).gatewayRefundsEnabled).toBe(true);
  });
  it("the wallet-refund route answers refund_to_wallet_only and creates no request", async () => {
    const { hfRefundsRoute } = await import("../routes/hf_refunds");
    const res = await hfRefundsRoute(new Request("https://x/api/hf/wallet/refunds", { method: "POST", body: "{}", headers: { "content-type": "application/json", "idempotency-key": "k" } }), env, "/api/hf/wallet/refunds");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("refund_to_wallet_only");
  });
});

describe("rule 8: anyone can withdraw wallet money; test credits never", () => {
  it("only purchase money in whole rupees is withdrawable; test credits and an open debt are not", async () => {
    await lot("f1", 12050, "p1"); await lot("f1", 5000, "t1", "test");
    expect(await fanWithdrawablePaise(env, "f1")).toBe(12000);
    await lot("f2", 5000, "t2", "test");
    expect(await fanWithdrawablePaise(env, "f2")).toBe(0);
  });
  it("take then return puts the money back in the wallet once; the request cannot take test money", async () => {
    await lot("f3", 20000, "p3"); await lot("f3", 5000, "t3", "test");
    expect(await takeFanPayout(env, "f3", "po1", 25000)).toMatchObject({ ok: false });
    expect(await takeFanPayout(env, "f3", "po1", 15000)).toMatchObject({ ok: true, takenPaise: 15000 });
    expect(await takeFanPayout(env, "f3", "po1", 15000)).toMatchObject({ ok: true, again: true }); // replay moves nothing
    expect((await balanceSummary(env, "f3")).totalPaise).toBe(25000 - 15000);
    expect(await fanTakenPaise(env, "po1")).toBe(15000);
    expect(await returnFanPayout(env, "f3", "po1")).toMatchObject({ ok: true, returnedPaise: 15000 });
    expect(await returnFanPayout(env, "f3", "po1")).toMatchObject({ ok: true, again: true });
    expect((await balanceSummary(env, "f3")).totalPaise).toBe(25000);
  });
  it("wallet money first, influencer earnings (7-day hold already applied) for the rest; the fan minimum is Rs 100, earnings keep Rs 500", () => {
    expect(splitPayoutSources(300, 20000, 50000)).toEqual({ lotsPaise: 20000, earningsPaise: 10000 });
    expect(splitPayoutSources(100, 20000, 0)).toEqual({ lotsPaise: 10000, earningsPaise: 0 });
    expect(splitPayoutSources(800, 20000, 50000)).toBeNull();
    expect(payoutMinimumRupees({ lotsPaise: 10000, earningsPaise: 0 }, 100, 500)).toBe(100);
    expect(payoutMinimumRupees({ lotsPaise: 0, earningsPaise: 50000 }, 100, 500)).toBe(500);
    // [HF-WIRE-18] HF-REEL-38: configured 0 means no minimum for anyone
    expect(payoutMinimumRupees({ lotsPaise: 10000, earningsPaise: 0 }, 0, 0)).toBe(0);
    expect(payoutMinimumRupees({ lotsPaise: 0, earningsPaise: 50000 }, 0, 0)).toBe(0);
  });
});
