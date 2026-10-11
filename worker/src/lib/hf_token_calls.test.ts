// @ts-nocheck -- uses node:sqlite via the shim

// [HF-TOK-CALLS-1] Token-mode call start gate, per-second settle on lots, snapshot, test-vs-paid host split, host INR ledger + payouts in paise,
// purchase limits. Real SQL on in-memory SQLite (see hf_token_d1_shim.ts). Spec tests: section 11.10 (#2, #3, #7-#10) + the integration cases.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, getLots, balanceSummary, createDebt, reserveForCall, release, getReservation } from "./hf_token_ledger";
import { prepareTokenStart, settleTokenCall, splitHostByKind, estimateForHost, snapshotFor, stdSnapshotFor, DEBT_MESSAGE } from "./hf_token_calls";
import { hostSummary, creditCallEarning, reservePayout, cancelPayoutReserve, markPayoutPaid, listCallEarnings, wholeRupees, HOST_HOLD_MS } from "./hf_host_ledger";
import { readHfTokenConfig, readHfStdPlan } from "./hf_token_config";
import { MICRO, paiseToMicro, chargePaise, stdTariff, STD_TECH_MAX_SECONDS } from "./hf_token_math";

const T = (n: number) => Math.round(n * MICRO);
const TK = readHfTokenConfig({ hfTokensEnabled: true });
const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"];

let env: any;
beforeEach(() => { env = { DB_META: makeDb(MIGS, { alters: true }) }; });

const lot = (uid: string, kind: "purchase" | "test", tokens: number, v: number, op: string, paidRupees?: number) =>
  creditLot(env, uid, {
    kind, pricingVersion: v === 82 ? "gp-v1" : "pt-v1", valuePaisePerToken: v, micro: T(tokens),
    paidPaise: kind === "test" ? 0 : (paidRupees ?? tokens) * 100, provider: kind === "test" ? "admin" : "google_play", providerRef: op,
  }, op);
const callRow = (id: string, caller: string, host: string, ratePaise: number, snap = { cost: 200, bps: 6000 }) =>
  env.DB_META._raw.prepare(
    "INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, call_cost_paise_per_min, host_share_bps, tax_mode, split_rule_version) VALUES (?,?,?,?, 'completed', ?, ?, ?, 'none_unregistered', 'gp-v1/split-v1')",
  ).run(id, caller, host, ratePaise, Date.now(), snap.cost, snap.bps);
const settleIn = (o: any = {}) => ({
  callId: "c1", callerUid: "u1", hostUid: "h1", ratePaise: 2000, callCostPaisePerMin: 200, hostShareBps: 6000,
  connectedSeconds: 60, maxSeconds: 3600, endedAt: 1_000_000, ...o,
});
const rowOf = (id: string) => env.DB_META._raw.prepare("SELECT * FROM hf_calls WHERE id=?").get(id);

describe("start gate", () => {
  it("refuses under 2 minutes and reports the shortfall in rupees; nothing stays reserved", async () => {
    await lot("u1", "purchase", 100, 82, "a"); // Rs 82 of value (an old gp-v1 lot); 2 min at Rs 50/min needs Rs 100
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 5000, tk: TK });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(r.error).toBe("low_balance");
    expect(r.extra.shortfallPaise).toBe(1800);
    expect(r.extra.shortfallRupees).toBe("₹18.00"); // [HF-STD-PLAN-1] reported in rupees, no token figure
    expect(r.message).toContain("₹18.00");
    expect(await getReservation(env, "c1")).toBe(null);
    expect((await balanceSummary(env, "u1")).availableMicro).toBe(T(100));
  });

  it("an empty wallet is refused the same way", async () => {
    const r = await prepareTokenStart(env, { uid: "nobody", callId: "c1", ratePaise: 2000, tk: TK });
    expect(r.ok).toBe(false);
    expect(r.extra.shortfallPaise).toBe(4000);
  });

  it("open debt blocks the call with the owner's wording", async () => {
    await lot("u1", "purchase", 500, 100, "a");
    await createDebt(env, "u1", { amountMicro: T(10), valuePaise: 820, sourceOrderId: "O" }, "d1");
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("debt_open");
    expect(r.message).toBe(DEBT_MESSAGE);
    expect(r.message).toBe("Please clear the amount owed before calling");
  });

  it("max call length = min(60 min, affordable seconds)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    const a = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK });
    expect(a.ok && a.maxSeconds).toBe(246);
    expect(a.limitReason).toBe("balance");
    await lot("u2", "purchase", 5000, 100, "b");
    const b = await prepareTokenStart(env, { uid: "u2", callId: "c2", ratePaise: 2000, tk: TK });
    expect(b.ok && b.maxSeconds).toBe(3600);
    expect(b.limitReason).toBe("time_limit");
  });

  it("two simultaneous starts for the same wallet cannot both hold the same tokens", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    const [x, y] = await Promise.all([
      prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK }),
      prepareTokenStart(env, { uid: "u1", callId: "c2", ratePaise: 2000, tk: TK }),
    ]);
    expect([x, y].filter((r) => r.ok).length).toBe(1);
    const l = (await getLots(env, "u1"))[0];
    expect(l.reservedMicro).toBeLessThanOrEqual(l.leftMicro);
  });

  it("the snapshot comes from config at start", () => {
    const s = snapshotFor(2000, readHfTokenConfig({ hfTokensEnabled: true, hfCallCostPaisePerMin: 300, hfHostShareBps: 5000, hfPricingVersion: "gp-v1" }));
    expect(s).toMatchObject({ ratePaise: 2000, callCostPaisePerMin: 300, hostShareBps: 5000, taxMode: "none_unregistered", splitRuleVersion: "gp-v1/split-v1" });
  });
});

describe("settle on lots", () => {
  it("246 s at Rs 20 on 100 tokens: V 82.00, cost 8.20, host 44.28, platform 29.52, 100 tokens, row written (11.10 #2)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 246 }));
    expect(o).toMatchObject({ billableSeconds: 246, consumedValuePaise: 8200, callCostPaise: 820, hostPaise: 4428, platformPaise: 2952, tokensSpentMicro: T(100) });
    const r = rowOf("c1");
    expect(r).toMatchObject({ billable_seconds: 246, consumed_value_paise: 8200, call_cost_paise: 820, host_earning_paise: 4428, platform_paise: 2952, tokens_spent_micro: T(100), billed_minutes: 4, charged_paise: 8200 });
    expect(JSON.parse(r.lots_used)).toEqual([{ lotId: expect.any(String), kind: "purchase", valuePaisePerToken: 82, micro: T(100), valuePaise: 8200 }]);
    expect(r.rate_paise).toBe(2000); expect(r.call_cost_paise_per_min).toBe(200); expect(r.host_share_bps).toBe(6000);
  });

  it("one full minute: host Rs 10.80, platform Rs 7.20, cost Rs 2.00 (11.10 #3)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 60 }));
    expect([o.hostPaise, o.platformPaise, o.callCostPaise]).toEqual([1080, 720, 200]);
  });

  it("run out mid call: stops at the last whole second the lots can pay for (11.10 #8)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 1000, maxSeconds: 3600 }));
    expect(o.billableSeconds).toBe(246);
    expect(o.shortfall).toBe(true);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
  });

  it("billable seconds are capped at the call's own limit", async () => {
    await lot("u1", "purchase", 5000, 100, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 5000, maxSeconds: 3600 }));
    expect(o.billableSeconds).toBe(3600);
  });

  it("a config change mid call does not touch the call: the split uses the START snapshot (11.10 #10)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    const start = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK });
    callRow("c1", "u1", "h1", 2000, { cost: start.snapshot.callCostPaisePerMin, bps: start.snapshot.hostShareBps });
    // owner changes the live settings during the call
    const changed = readHfTokenConfig({ hfTokensEnabled: true, hfCallCostPaisePerMin: 500, hfHostShareBps: 3000, hfPricingVersion: "gp-v1" });
    expect(snapshotFor(2000, changed).hostShareBps).toBe(3000);
    const row = rowOf("c1"); // what the DO reads back: the frozen numbers
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 60, callCostPaisePerMin: row.call_cost_paise_per_min, hostShareBps: row.host_share_bps }));
    expect(o.hostPaise).toBe(1080);
    expect(o.callCostPaise).toBe(200);
  });

  it("mixed lots: host earns Rs 10.80 a minute throughout (11.10 #9)", async () => {
    await lot("u1", "purchase", 50, 82, "a");
    await lot("u1", "purchase", 100, 100, "b");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 300 }));
    expect(o.lots.map((l) => l.valuePaisePerToken)).toEqual([82, 100]);
    expect(o.hostPaise).toBe(5400); // 5 minutes x Rs 10.80
    expect(o.hostPaidPaise).toBe(5400);
    expect(o.hostTestPaise).toBe(0);
  });

  it("test credits: the host share from test lots is recorded as non-withdrawable, split by value", async () => {
    await lot("u1", "test", 50, 82, "t");
    await lot("u1", "purchase", 100, 100, "b");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 300, endedAt: 5_000_000 }));
    // value: test lot 4100 paise, purchase lot 5900; host total 5400 -> paid floor(5400*5900/10000)=3186, test remainder 2214
    expect([o.hostPaidPaise, o.hostTestPaise]).toEqual([3186, 2214]);
    const rows = env.DB_META._raw.prepare("SELECT kind, amount_paise, available_at FROM hf_host_ledger WHERE host_uid='h1' ORDER BY kind").all();
    expect(rows).toEqual([
      { kind: "call_earning", amount_paise: 3186, available_at: 5_000_000 + HOST_HOLD_MS },
      { kind: "call_earning_test", amount_paise: 2214, available_at: null },
    ]);
    const early = await hostSummary(env, "h1", 5_000_001);
    expect([early.earnedPaise, early.testPaise, early.pendingPaise, early.availablePaise]).toEqual([3186, 2214, 3186, 0]);
    const late = await hostSummary(env, "h1", 5_000_000 + HOST_HOLD_MS + 1);
    expect([late.pendingPaise, late.availablePaise]).toEqual([0, 3186]); // test earnings never become withdrawable
  });

  it("an all-test call earns the host only test earnings", async () => {
    await lot("u1", "test", 100, 82, "t");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 60 }));
    expect([o.hostPaidPaise, o.hostTestPaise]).toEqual([0, 1080]);
    expect((await hostSummary(env, "h1", 9e12)).availablePaise).toBe(0);
  });

  it("settling twice changes nothing (one lot spend, one earning row each)", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const a = await settleTokenCall(env, settleIn({ connectedSeconds: 120 }));
    const b = await settleTokenCall(env, settleIn({ connectedSeconds: 120 }));
    expect(b).toMatchObject({ billableSeconds: a.billableSeconds, tokensSpentMicro: a.tokensSpentMicro, hostPaise: a.hostPaise });
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_host_ledger").get().n).toBe(1);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(100) - a.tokensSpentMicro);
  });

  it("a call that never connected releases everything and pays nobody", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 0 }));
    expect(o).toMatchObject({ billableSeconds: 0, tokensSpentMicro: 0, hostPaise: 0, billedMinutes: 0 });
    expect((await balanceSummary(env, "u1")).availableMicro).toBe(T(100));
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_host_ledger").get().n).toBe(0);
  });

  it("settling after a release (cancelled before connect) is a clean zero, not an error", async () => {
    await lot("u1", "purchase", 100, 82, "a");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    await release(env, "c1");
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 0 }));
    expect(o.tokensSpentMicro).toBe(0);
  });

  it("host rate of Rs 2 or less: host 0, the whole value is call cost", async () => {
    await lot("u1", "purchase", 100, 100, "a");
    callRow("c1", "u1", "h1", 200);
    await reserveForCall(env, "u1", "c1", 200, 3600);
    const o = await settleTokenCall(env, settleIn({ ratePaise: 200, connectedSeconds: 600 }));
    expect([o.hostPaise, o.callCostPaise, o.consumedValuePaise]).toEqual([0, 2000, 2000]);
  });
});

describe("host split by kind (pure)", () => {
  it("floors the paid part and gives the remainder to test earnings", () => {
    expect(splitHostByKind(5400, 10000, 5900)).toEqual({ paidPaise: 3186, testPaise: 2214 });
    expect(splitHostByKind(1080, 2000, 2000)).toEqual({ paidPaise: 1080, testPaise: 0 });
    expect(splitHostByKind(1080, 2000, 0)).toEqual({ paidPaise: 0, testPaise: 1080 });
    expect(splitHostByKind(0, 2000, 2000)).toEqual({ paidPaise: 0, testPaise: 0 });
    expect(splitHostByKind(100, 0, 0)).toEqual({ paidPaise: 0, testPaise: 100 });
    const s = splitHostByKind(1001, 3, 1);
    expect(s.paidPaise + s.testPaise).toBe(1001);
  });
});

describe("host INR ledger and payouts in paise", () => {
  const earn = (paise: number, callId: string, endedAt: number) => creditCallEarning(env, "h1", callId, paise, "call_earning", endedAt);
  const NOW = 10 * 86_400_000 * 5;
  const LONG_AGO = NOW - HOST_HOLD_MS - 1000;

  it("a duplicate earning for the same call is one row", async () => {
    expect((await earn(1080, "c1", LONG_AGO)).applied).toBe(true);
    expect((await earn(1080, "c1", LONG_AGO)).applied).toBe(false);
    expect((await hostSummary(env, "h1", NOW)).earnedPaise).toBe(1080);
  });

  it("pending vs available: only earnings past the 7 day hold are withdrawable", async () => {
    await earn(2000, "old", LONG_AGO);
    await earn(3000, "new", NOW);
    const s = await hostSummary(env, "h1", NOW);
    expect([s.earnedPaise, s.maturedPaise, s.pendingPaise, s.availablePaise]).toEqual([5000, 2000, 3000, 2000]);
  });

  it("withdrawal reserve uses paise, whole rupees only, and the leftover paise stay in the balance", async () => {
    await earn(123456, "c1", LONG_AGO); // Rs 1,234.56
    expect(wholeRupees((await hostSummary(env, "h1", NOW)).availablePaise)).toBe(1234);
    const r = await reservePayout(env, "h1", "p1", 123400, NOW);
    expect(r.ok).toBe(true);
    const s = await hostSummary(env, "h1", NOW);
    expect(s.availablePaise).toBe(56);
    expect(wholeRupees(s.availablePaise)).toBe(0);
  });

  it("two requests cannot both fit; a retry of the same request is not a second reserve", async () => {
    await earn(100000, "c1", LONG_AGO);
    expect((await reservePayout(env, "h1", "p1", 60000, NOW)).ok).toBe(true);
    expect((await reservePayout(env, "h1", "p2", 60000, NOW)).ok).toBe(false);
    expect((await reservePayout(env, "h1", "p1", 60000, NOW)).again).toBe(true);
    expect((await hostSummary(env, "h1", NOW)).availablePaise).toBe(40000);
  });

  it("unmatured earnings cannot be reserved", async () => {
    await earn(100000, "c1", NOW);
    expect((await reservePayout(env, "h1", "p1", 50000, NOW)).ok).toBe(false);
  });

  it("test earnings are never withdrawable", async () => {
    await creditCallEarning(env, "h1", "c1", 100000, "call_earning_test", LONG_AGO);
    expect((await hostSummary(env, "h1", NOW)).availablePaise).toBe(0);
    expect((await reservePayout(env, "h1", "p1", 10000, NOW)).ok).toBe(false);
  });

  it("cancel / reject gives the reserve back once; paid freezes it", async () => {
    await earn(100000, "c1", LONG_AGO);
    await reservePayout(env, "h1", "p1", 60000, NOW);
    expect((await cancelPayoutReserve(env, "h1", "p1")).ok).toBe(true);
    expect((await cancelPayoutReserve(env, "h1", "p1")).ok).toBe(true); // idempotent
    expect((await hostSummary(env, "h1", NOW)).availablePaise).toBe(100000);
    expect((await markPayoutPaid(env, "h1", "p1")).ok).toBe(false); // cancelled: cannot be paid

    await reservePayout(env, "h1", "p2", 50000, NOW);
    expect((await markPayoutPaid(env, "h1", "p2")).ok).toBe(true);
    expect((await markPayoutPaid(env, "h1", "p2")).ok).toBe(true); // idempotent
    await cancelPayoutReserve(env, "h1", "p2"); // too late: already paid
    expect((await hostSummary(env, "h1", NOW)).availablePaise).toBe(50000);
    expect((await cancelPayoutReserve(env, "h1", "never")).ok).toBe(false);
  });

  it("per-call earnings fold the paid and test parts of one call", async () => {
    await creditCallEarning(env, "h1", "c1", 3186, "call_earning", 1000);
    await creditCallEarning(env, "h1", "c1", 2214, "call_earning_test", 1000);
    await creditCallEarning(env, "h1", "c2", 1080, "call_earning", 2000);
    const l = await listCallEarnings(env, "h1");
    expect(l.find((x) => x.callId === "c1")).toMatchObject({ paidPaise: 3186, testPaise: 2214 });
    expect(l.length).toBe(2);
  });
});

describe("no spend limits (HF-NOLIMITS-1)", () => {
  it("calls are not limited by spend: a big day of purchases never blocks a call", async () => {
    await lot("u1", "purchase", 2000, 82, "a", 2000); // a large amount bought in one day
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK });
    expect(r.ok).toBe(true);
  });
});

describe("caller estimate", () => {
  it("Rs 20/min at Rs 0.82: 24.39 tokens a minute, 100 tokens = about 4 min 6 s", () => {
    const e = estimateForHost([{ id: "a", valuePaisePerToken: 82, leftMicro: T(100) }], 2000, 82);
    expect(e.tokensPerMinute).toBe("24.39");
    expect(e.aboutText).toBe("about 4 min 6 s");
    expect(e.canStart).toBe(true);
  });
  it("mixed lots follow the order they will be used: 50 @0.82 + 100 @1.00 -> about 7 min 3 s", () => {
    const e = estimateForHost([{ id: "a", valuePaisePerToken: 82, leftMicro: T(50) }, { id: "b", valuePaisePerToken: 100, leftMicro: T(100) }], 2000, 82);
    expect(e.tokensPerMinute).toBe("24.39"); // first lot's value
    expect(e.affordableSeconds).toBe(423);
    expect(e.aboutText).toBe("about 7 min 3 s");
  });
  it("an empty wallet quotes at the active value and says to add money", () => {
    const e = estimateForHost([], 2000, 82);
    expect(e.tokensPerMinute).toBe("24.39");
    expect(e.canStart).toBe(false);
    expect(e.aboutText).toBe("add money to call");
  });
  it("a future Re 1 value costs 20 tokens a minute while the host still earns Rs 10.80 (11.10 #10)", async () => {
    expect(estimateForHost([{ id: "p", valuePaisePerToken: 100, leftMicro: T(100) }], 2000, 100).tokensPerMinute).toBe("20.00");
    await lot("u1", "purchase", 100, 100, "p");
    callRow("c1", "u1", "h1", 2000);
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const o = await settleTokenCall(env, settleIn({ connectedSeconds: 60 }));
    expect(o.hostPaise).toBe(1080);
    expect(o.tokensSpentMicro).toBe(T(20));
  });
});

// ── [HF-STD-PLAN-1] Standard plan, end to end on rupee lots ──────────────────────────────────────────────
describe("Standard plan calls", () => {
  const STD = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 });
  const TAR = stdTariff();
  const rlot = (uid: string, paise: number, op: string, kind: "purchase" | "test" = "purchase") =>
    creditLot(env, uid, {
      kind, pricingVersion: kind === "test" ? "pt-v1" : "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(paise),
      paidPaise: kind === "test" ? 0 : paise, provider: kind === "test" ? "admin" : "google_play", providerRef: op,
    }, op);
  const stdCallRow = (id: string, caller = "u1", host = "h1") => callRow(id, caller, host, 399, { cost: 100, bps: 0 });
  const stdIn = (o: any = {}) => ({
    callId: "c1", callerUid: "u1", hostUid: "h1", ratePaise: 399, callCostPaisePerMin: 100, hostShareBps: 0,
    connectedSeconds: 3600, maxSeconds: STD_TECH_MAX_SECONDS, endedAt: 1_000_000, std: stdSnapshotFor(STD).std, ...o,
  });

  it("reports wallet affordability beyond 24 hours while the call start path keeps its separate operational ceiling", () => {
    const e = estimateForHost([{ id: "rich", valuePaisePerToken: 100, leftMicro: paiseToMicro(1_000_000) }], TAR, 100, null);
    expect(e.affordableSeconds).toBeGreaterThan(STD_TECH_MAX_SECONDS);
    expect(e.affordableChargePaise).toBe(chargePaise(TAR, e.affordableSeconds));
  });

  it("reserves the WHOLE balance (no 60-minute cap): Rs 500 runs well past 3600 seconds", async () => {
    await rlot("u1", 50000, "a");
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    expect(r.ok).toBe(true);
    expect(r.maxSeconds).toBeGreaterThan(3600);
    expect(r.limitReason).toBe("balance");
    expect(r.snapshot.std).toBeTruthy();
    // what is reserved is everything the balance can pay for, to the last whole second; under 1 paisa-second of change is left
    const res = await getReservation(env, "c1");
    expect(res.secondsCovered).toBe(r.maxSeconds);
    expect(chargePaise(TAR, r.maxSeconds)).toBeLessThanOrEqual(50000);
    expect(chargePaise(TAR, r.maxSeconds + 1)).toBeGreaterThan(50000);
    expect((await balanceSummary(env, "u1")).availablePaise).toBeLessThan(6);
  });

  it("the old host-rate path still caps at 60 minutes", async () => {
    await rlot("u1", 300000, "a"); // Rs 3,000 at Rs 20/min would pay for 150 minutes
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 2000, tk: TK });
    expect(r.ok).toBe(true);
    expect(r.maxSeconds).toBe(3600);
    expect(r.limitReason).toBe("time_limit");
  });

  it("starting needs 2 minutes = Rs 7.98: Rs 7.98 starts, Rs 7.97 does not", async () => {
    await rlot("u1", 798, "a");
    const ok = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    expect(ok.ok).toBe(true);
    expect(ok.maxSeconds).toBeGreaterThanOrEqual(120);
    await rlot("u2", 797, "b");
    const no = await prepareTokenStart(env, { uid: "u2", callId: "c2", ratePaise: 0, tk: TK, std: STD });
    expect(no.ok).toBe(false);
    expect(no.status).toBe(402);
    expect(no.extra.shortfallPaise).toBe(1);
    expect(await getReservation(env, "c2")).toBe(null);
  });

  it("low balance is said in rupees, with no token wording", async () => {
    await rlot("u1", 500, "a");
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("low_balance");
    expect(r.message).toBe("You need about ₹2.98 more in your wallet to start this call.");
    expect(r.extra).toMatchObject({ shortfallPaise: 298, shortfallRupees: "₹2.98" });
    expect(r.message).not.toMatch(/token/i);
    expect(JSON.stringify(r.extra)).not.toMatch(/Tokens/);
  });

  it("settle: a 60-minute call gives the owner's numbers and writes them on hf_calls", async () => {
    await rlot("u1", 30000, "a");
    stdCallRow("c1");
    await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    const o = await settleTokenCall(env, stdIn());
    expect(o).toMatchObject({ billableSeconds: 3600, shortfall: false, consumedValuePaise: 22470, hostPaise: 12000, callCostPaise: 6000, platformPaise: 4470 });
    const row = rowOf("c1");
    expect(row).toMatchObject({ consumed_value_paise: 22470, host_earning_paise: 12000, call_cost_paise: 6000, platform_paise: 4470, billable_seconds: 3600, charged_paise: 22470 });
    expect(JSON.parse(row.lots_used)[0].kind).toBe("purchase");
    // wallet: 30000 - 22470 left, nothing stays reserved
    const b = await balanceSummary(env, "u1");
    expect(b.totalPaise).toBe(7530);
    expect(b.availablePaise).toBe(7530);
    // the host got the Rs 120.00 as paid earnings (purchase lot), held 7 days
    const hs = await hostSummary(env, "h1", 1_000_000);
    expect(hs.earnedPaise).toBe(12000);
    expect(hs.pendingPaise).toBe(12000);
    expect(hs.testPaise).toBe(0);
  });

  it("settle: the other owner examples (30, 90, 120 minutes)", async () => {
    for (const [mins, v, h] of [[30, 11970, 6000], [90, 32220, 18000], [120, 41970, 24000]] as const) {
      const uid = `u${mins}`, id = `call${mins}xx`;
      await rlot(uid, 50000, `lot${mins}`);
      stdCallRow(id, uid, `h${mins}`);
      await prepareTokenStart(env, { uid, callId: id, ratePaise: 0, tk: TK, std: STD });
      const o = await settleTokenCall(env, stdIn({ callId: id, callerUid: uid, hostUid: `h${mins}`, connectedSeconds: mins * 60 }));
      expect(o.consumedValuePaise).toBe(v);
      expect(o.hostPaise).toBe(h);
      expect(o.hostPaise + o.callCostPaise + o.platformPaise).toBe(v);
    }
  });

  it("two simultaneous starts cannot both reserve the same money", async () => {
    await rlot("u1", 1000, "a");
    const [x, y] = await Promise.all([
      prepareTokenStart(env, { uid: "u1", callId: "ca", ratePaise: 0, tk: TK, std: STD }),
      prepareTokenStart(env, { uid: "u1", callId: "cb", ratePaise: 0, tk: TK, std: STD }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const b = await balanceSummary(env, "u1");
    expect(b.totalPaise).toBe(1000);
    expect(b.availablePaise).toBeLessThan(6);
    const lost = x.ok ? y : x;
    expect(lost.status).toBe(402);
  });

  it("settle twice is idempotent: one spend, one host earning, same numbers", async () => {
    await rlot("u1", 30000, "a");
    stdCallRow("c1");
    await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    const a = await settleTokenCall(env, stdIn());
    const b = await settleTokenCall(env, stdIn());
    expect(b).toEqual(a);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470);
    const n = env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_host_ledger WHERE call_id='c1'").get().n;
    expect(n).toBe(1);
    expect((await hostSummary(env, "h1", 1_000_000)).earnedPaise).toBe(12000);
  });

  it("when the money runs out the call stops at the last whole second the wallet can pay for", async () => {
    await rlot("u1", 1000, "a");
    stdCallRow("c1");
    const st = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    // the phone line stayed up for 2 hours (e.g. a late hang-up event): billing still stops where the wallet ran out
    const o = await settleTokenCall(env, stdIn({ connectedSeconds: 7200 }));
    expect(o.shortfall).toBe(true);
    expect(o.billableSeconds).toBe(st.maxSeconds);
    expect(chargePaise(TAR, o.billableSeconds)).toBeLessThanOrEqual(1000);
    expect(chargePaise(TAR, o.billableSeconds + 1)).toBeGreaterThan(1000);
    expect(o.consumedValuePaise).toBe(chargePaise(TAR, o.billableSeconds));
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(1000 - o.consumedValuePaise);
  });

  it("a config change in the middle of a call does not change it (the snapshot rules)", async () => {
    await rlot("u1", 30000, "a");
    stdCallRow("c1");
    const snap = stdSnapshotFor(STD); // taken at start
    await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    const changed = readHfStdPlan({ hfStdTier1PaisePerMin: 999, hfStdTier2PaisePerMin: 900, hfStdTier3PaisePerMin: 800, hfStdHostPaisePerMin: 500, hfStdPhoneCostPaisePerMin: 300 });
    expect(stdSnapshotFor(changed).std.tariff).not.toEqual(snap.std.tariff); // the new config really is different...
    const o = await settleTokenCall(env, stdIn({ std: snap.std })); // ...but the call settles on what was frozen at start
    expect(o).toMatchObject({ consumedValuePaise: 22470, hostPaise: 12000, callCostPaise: 6000, platformPaise: 4470 });
    expect(snap.splitRuleVersion).toBe("std-r1/std-split-v1");
    expect(snap.ratePaise).toBe(399);
  });

  it("a purchase lot and a test lot in one call: host earning splits by the value each lot paid", async () => {
    await rlot("u1", 10000, "t1", "test"); // oldest: spent first
    await rlot("u1", 20000, "p1", "purchase");
    stdCallRow("c1");
    await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    const o = await settleTokenCall(env, stdIn());
    expect(o.consumedValuePaise).toBe(22470);
    const paidValue = o.lots.filter((l: any) => l.kind === "purchase").reduce((t: number, l: any) => t + l.valuePaise, 0);
    expect(paidValue).toBe(12470);
    expect(o.hostPaidPaise).toBe(Math.floor((12000 * 12470) / 22470)); // 6659
    expect(o.hostTestPaise).toBe(12000 - o.hostPaidPaise);
    expect(o.hostPaidPaise + o.hostTestPaise).toBe(o.hostPaise);
    const hs = await hostSummary(env, "h1", 1_000_000);
    expect(hs.earnedPaise).toBe(o.hostPaidPaise); // only the real-money part is withdrawable
    expect(hs.testPaise).toBe(o.hostTestPaise);
  });

  it("an all-test-lot call earns the host nothing withdrawable", async () => {
    await rlot("u1", 30000, "t1", "test");
    stdCallRow("c1");
    await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    const o = await settleTokenCall(env, stdIn());
    expect(o.hostPaidPaise).toBe(0);
    expect(o.hostTestPaise).toBe(12000);
    expect((await hostSummary(env, "h1", 1_000_000)).earnedPaise).toBe(0);
  });
});
