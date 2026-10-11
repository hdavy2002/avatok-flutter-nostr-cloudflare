// @ts-nocheck -- uses node:sqlite via the shim
// [HF-STD-PLAN-1] adversarial review scenarios: whole-balance reservation, a second call, a top-up mid call, Play credit exactly once.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("./hf_topup_notify", () => ({ notifyTopupCredited: async () => ({}) }));
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary, getLots } from "./hf_token_ledger";
import { prepareTokenStart, settleTokenCall, stdSnapshotFor } from "./hf_token_calls";
import { readHfTokenConfig, readHfStdPlan } from "./hf_token_config";
import { paiseToMicro, chargePaise, stdTariff, STD_TECH_MAX_SECONDS } from "./hf_token_math";
import { makePlayWorld, makeEnv, CFG } from "./hf_play_testkit";
import { processPlayPurchase, accountHashFor, rememberAccount } from "./hf_play";

const TK = readHfTokenConfig({ hfTokensEnabled: true });
const STD = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 });
const TAR = stdTariff();
const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"];

describe("Standard calls on Rs 101.69", () => {
  let env: any;
  beforeEach(async () => {
    env = { DB_META: makeDb(MIGS, { alters: true }) };
    await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(10169), paidPaise: 12000, provider: "google_play", providerRef: "GPA.1" }, "hfplay:GPA.1");
    env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, tax_mode, split_rule_version) VALUES ('c1','u1','h1',399,'completed',?, 'none_unregistered','std-r1/std-split-v1')").run(Date.now());
  });
  const settle = (connected: number, maxSeconds: number) => settleTokenCall(env, {
    callId: "c1", callerUid: "u1", hostUid: "h1", ratePaise: 399, callCostPaisePerMin: 100, hostShareBps: 0,
    connectedSeconds: connected, maxSeconds, endedAt: Date.now(), std: stdSnapshotFor(STD).std,
  });

  it("(a) reserves the whole balance; a call far past the limit is charged at most the reservation, never below zero", async () => {
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    expect(r.ok).toBe(true);
    expect(chargePaise(TAR, r.maxSeconds)).toBeLessThanOrEqual(10169);
    expect(chargePaise(TAR, r.maxSeconds + 1)).toBeGreaterThan(10169);
    expect(r.maxSeconds).toBe(1529); // about 25 min 29 s
    const o = await settle(r.maxSeconds + 500, r.maxSeconds);
    expect(o.billableSeconds).toBe(r.maxSeconds);
    expect(o.consumedValuePaise).toBe(chargePaise(TAR, r.maxSeconds));
    const b = await balanceSummary(env, "u1");
    expect(b.totalPaise).toBe(10169 - o.consumedValuePaise);
    expect(b.totalPaise).toBeGreaterThanOrEqual(0);
    expect(b.availablePaise).toBe(b.totalPaise); // reservation fully gone
    const lots = env.DB_META._raw.prepare("SELECT tokens_left_micro l, tokens_reserved_micro r FROM hf_token_lots").all();
    for (const l of lots) { expect(l.l).toBeGreaterThanOrEqual(0); expect(l.r).toBe(0); }
  });

  it("(b) a second call by the same caller while the first holds the balance is refused with nothing reserved", async () => {
    expect((await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD })).ok).toBe(true);
    const two = await prepareTokenStart(env, { uid: "u1", callId: "c2", ratePaise: 0, tk: TK, std: STD });
    expect(two.ok).toBe(false);
    expect(two.status).toBe(402);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) n FROM hf_token_ledger WHERE op_id='hftres:c2'").get().n).toBe(0);
  });

  it("(c) a top-up DURING the call is not spent beyond what the call's limit allowed", async () => {
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(50847), paidPaise: 60000, provider: "google_play", providerRef: "GPA.2" }, "hfplay:GPA.2");
    const o = await settle(r.maxSeconds + 3600, r.maxSeconds); // the DO's backstop fired late: connected time is longer than the limit
    expect(o.billableSeconds).toBe(r.maxSeconds);
    expect(o.consumedValuePaise).toBeLessThanOrEqual(10169);
    const lots = await getLots(env, "u1");
    expect(lots.find((l) => l.providerRef === "GPA.2").leftMicro).toBe(paiseToMicro(50847)); // the new money is untouched
  });

  it("(c2) a short call after a mid-call top-up spends only from the reserved lot and releases the rest", async () => {
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 0, tk: TK, std: STD });
    await creditLot(env, "u1", { kind: "test", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(1000), paidPaise: 0, provider: "admin", providerRef: "t" }, "t1");
    const o = await settle(600, r.maxSeconds);
    expect(o.consumedValuePaise).toBe(3990); // 10 min at Rs 3.99
    expect(o.hostTestPaise).toBe(0); // all from the purchase lot
    expect((await balanceSummary(env, "u1")).availablePaise).toBe(10169 - 3990 + 1000);
  });
});

describe("Play credit with GST, exactly once", () => {
  let world: any, env: any;
  const TOKN = (n: number) => `purchase-token-${n}-abcdefghij`;
  beforeEach(() => { world = makePlayWorld(); env = makeEnv(); vi.stubGlobal("fetch", world.fetchImpl); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const buy = async (uid: string, n: number, o: any = {}) => { const h = await accountHashFor(env, uid); await rememberAccount(env, uid, h); world.buy(TOKN(n), { obfuscated: h, ...o }); return TOKN(n); };

  it("(f) verify twice + RTDN + a concurrent verify: one lot of Rs 101.69 and every answer reports the same credit", async () => {
    const t = await buy("u1", 1);
    const [a, b] = await Promise.all([
      processPlayPurchase(env, CFG, { productId: "hf_rupees_120", purchaseToken: t, uid: "u1", source: "verify" }),
      processPlayPurchase(env, CFG, { productId: "hf_rupees_120", purchaseToken: t, source: "rtdn" }),
    ]);
    const c = await processPlayPurchase(env, CFG, { productId: "hf_rupees_120", purchaseToken: t, uid: "u1", source: "verify" });
    for (const x of [a, b, c]) expect(x).toMatchObject({ ok: true, paidPaise: 12000, walletPaise: 10169, gstPaise: 1831, tokensMicro: 101_690_000 });
    expect([a, b, c].filter((x) => x.duplicate === false).length).toBe(1);
    const lots = env.DB_META._raw.prepare("SELECT tokens_granted_micro g, paid_paise p, gst_paise s FROM hf_token_lots").all();
    expect(lots).toEqual([{ g: 101_690_000, p: 12000, s: 1831 }]);
  });

  it("Play reports the price in capitals or lowercase: either is the real rupee price (Rs 118 -> Rs 100 + Rs 18)", async () => {
    const t = await buy("u1", 2, { priceMicros: 118_000_000, currency: "INR" });
    expect(await processPlayPurchase(env, CFG, { productId: "hf_rupees_120", purchaseToken: t, uid: "u1", source: "verify" })).toMatchObject({ paidPaise: 11800, walletPaise: 10000, gstPaise: 1800 });
  });

  it("(g) a product still on gp-r1 credits its old count (102 units = Rs 102, no GST split)", async () => {
    const t = await buy("u1", 3, { sku: "hf_tokens_100" });
    const r = await processPlayPurchase(env, CFG, { productId: "hf_tokens_100", purchaseToken: t, uid: "u1", source: "verify" });
    expect(r).toMatchObject({ ok: true, paidPaise: 12000, walletPaise: 10200, gstPaise: 0 });
    expect(env.DB_META._raw.prepare("SELECT pricing_version v, redemption_paise_per_token r FROM hf_token_lots").get()).toEqual({ v: "gp-r1", r: 100 });
  });
});

describe("[review] purchase records after a rupee-lot migration", () => {
  it("a migrated purchase gets no second 'Purchase record' (the new lot is the same order)", async () => {
    const { backfillPurchaseRecords } = await import("./hf_receipts");
    const { migrateLotsToRupees } = await import("./hf_std_migrate");
    const env: any = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-10-hf-wallet-limits.sql"]) };
    await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: 100_000_000, paidPaise: 10000, provider: "google_play", providerRef: "GPA.9" }, "hfplay:GPA.9");
    const cfg = {};
    await backfillPurchaseRecords(env, cfg, "u1");
    const n = () => env.DB_META._raw.prepare("SELECT COUNT(*) n FROM hf_receipts WHERE source='play_purchase'").get().n;
    expect(n()).toBe(1);
    expect((await migrateLotsToRupees(env, { dryRun: false })).migrated).toHaveLength(1);
    await backfillPurchaseRecords(env, cfg, "u1");
    expect(n()).toBe(1);
  });
});
