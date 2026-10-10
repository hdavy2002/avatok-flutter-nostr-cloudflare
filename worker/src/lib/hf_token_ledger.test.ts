// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for

// [HF-TOK-LEDGER-1] Runs the real ledger SQL against an in-memory SQLite (node:sqlite) behind a tiny D1 shim (same approach as hf_credits.test.ts).
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import {
  creditLot, getLots, balanceSummary, hasOpenDebt, reserveForCall, release, settleCall, revokeLot, createDebt, clearDebtsFromLot, getReservation,
} from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

const T = (n: number) => Math.round(n * MICRO);
const buy = (env: any, uid: string, tokens: number, v: number, op: string, extra: any = {}) =>
  creditLot(env, uid, { kind: "purchase", pricingVersion: v === 82 ? "gp-v1" : "pt-v1", valuePaisePerToken: v, micro: T(tokens), paidPaise: tokens * 100, provider: "google_play", providerRef: op, ...extra }, op);

let env: any;
beforeEach(() => { env = { DB_META: makeDb() }; });

describe("hf_token_ledger credit", () => {
  it("the same op id twice makes one lot and one ledger row", async () => {
    const a = await buy(env, "u1", 100, 82, "hfplay:O1");
    const b = await buy(env, "u1", 100, 82, "hfplay:O1");
    const c = await buy(env, "u1", 100, 82, "hfplay:O1");
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false); expect(c.applied).toBe(false);
    expect(b.lotId).toBe(a.lotId);
    expect((await getLots(env, "u1")).length).toBe(1);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger").get().n).toBe(1);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(100));
  });

  it("rejects non-positive or fractional micro amounts", async () => {
    expect((await creditLot(env, "u1", { kind: "test", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: 0, paidPaise: 0, provider: null, providerRef: null }, "x")).applied).toBe(false);
    expect((await creditLot(env, "u1", { kind: "test", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: 1.5, paidPaise: 0, provider: null, providerRef: null }, "y")).applied).toBe(false);
  });

  it("lots come back oldest first and the summary groups by value", async () => {
    await buy(env, "u1", 50, 82, "a");
    await buy(env, "u1", 100, 100, "b");
    await buy(env, "u1", 10, 82, "c");
    const lots = await getLots(env, "u1");
    expect(lots.map((l) => l.providerRef)).toEqual(["a", "b", "c"]);
    const s = await balanceSummary(env, "u1");
    expect(s.byValue).toEqual([{ valuePaisePerToken: 82, micro: T(60) }, { valuePaisePerToken: 100, micro: T(100) }]);
    expect(s.debtMicro).toBe(0);
  });
});

describe("hf_token_ledger reserve / settle / release", () => {
  it("mixed lots: the first 123 s use the 0.82 lot, then the 1.00 lot; per-lot value adds up", async () => {
    await buy(env, "u1", 50, 82, "a");
    await buy(env, "u1", 100, 100, "b");
    const r = await reserveForCall(env, "u1", "call1", 2000, 3600);
    expect(r.ok).toBe(true);
    // 50*0.82 = 41.00 Rs + 100*1.00 = 100 Rs = Rs 141 at Rs 20/min -> 423 s
    expect(r.secondsCovered).toBe(423);
    const s = await settleCall(env, "u1", "call1", 2000, 300);
    expect(s.ok).toBe(true);
    expect(s.totalValuePaise).toBe(10000);
    expect(s.lots.map((l) => [l.valuePaisePerToken, l.valuePaise])).toEqual([[82, 4100], [100, 5900]]);
    expect(s.lots[0].micro).toBe(T(50));
    expect(s.lots[1].micro).toBe(T(59));
    const left = await getLots(env, "u1");
    expect(left.length).toBe(1);
    expect(left[0].leftMicro).toBe(T(41));
    expect(left[0].reservedMicro).toBe(0);
  });

  it("settle is idempotent and returns the first result", async () => {
    await buy(env, "u1", 100, 82, "a");
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const a = await settleCall(env, "u1", "c1", 2000, 60);
    const b = await settleCall(env, "u1", "c1", 2000, 60);
    const c = await settleCall(env, "u1", "c1", 2000, 999);
    expect(a.again).toBe(false); expect(b.again).toBe(true);
    expect(b.totalMicro).toBe(a.totalMicro); expect(c.totalMicro).toBe(a.totalMicro);
    expect(b.billableSeconds).toBe(60);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(100) - a.totalMicro);
  });

  it("reserve is idempotent per call and holds tokens inside left", async () => {
    await buy(env, "u1", 100, 82, "a");
    const a = await reserveForCall(env, "u1", "c1", 2000, 3600);
    const b = await reserveForCall(env, "u1", "c1", 2000, 3600);
    expect(a.ok && b.ok).toBe(true);
    expect(b.again).toBe(true);
    expect(b.reservedMicro).toBe(a.reservedMicro);
    const s = await balanceSummary(env, "u1");
    expect(s.totalMicro).toBe(T(100));
    expect(s.availableMicro).toBe(0); // 246 s at Rs 20 takes all 100 tokens
  });

  it("a second call cannot reserve tokens the first already holds", async () => {
    await buy(env, "u1", 100, 82, "a");
    expect((await reserveForCall(env, "u1", "c1", 2000, 3600)).ok).toBe(true);
    const r2 = await reserveForCall(env, "u1", "c2", 2000, 3600);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("insufficient");
  });

  it("concurrent reserves cannot overdraw a lot", async () => {
    await buy(env, "u1", 100, 82, "a");
    const [x, y] = await Promise.all([reserveForCall(env, "u1", "c1", 2000, 3600), reserveForCall(env, "u1", "c2", 2000, 3600)]);
    const oks = [x, y].filter((r) => r.ok);
    expect(oks.length).toBe(1);
    const lot = (await getLots(env, "u1"))[0];
    expect(lot.reservedMicro).toBeLessThanOrEqual(lot.leftMicro);
    expect(lot.reservedMicro).toBe(T(100));
  });

  it("concurrent reserves that both fit take only what exists (second gets the smaller cover)", async () => {
    await buy(env, "u1", 100, 82, "a");
    const [x, y] = await Promise.all([reserveForCall(env, "u1", "c1", 2000, 120), reserveForCall(env, "u1", "c2", 2000, 120)]);
    expect(x.ok && y.ok).toBe(true);
    const lot = (await getLots(env, "u1"))[0];
    expect(lot.reservedMicro).toBe(x.reservedMicro + y.reservedMicro);
    expect(lot.reservedMicro).toBeLessThanOrEqual(lot.leftMicro);
  });

  it("run out mid call: billing stops at the last whole second the lots can pay for", async () => {
    await buy(env, "u1", 100, 82, "a");
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const s = await settleCall(env, "u1", "c1", 2000, 1000);
    expect(s.billableSeconds).toBe(246);
    expect(s.shortfall).toBe(true);
    expect(s.totalMicro).toBe(T(100));
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
  });

  it("release gives everything back, is idempotent, and a later settle is refused", async () => {
    await buy(env, "u1", 100, 82, "a");
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    expect((await release(env, "c1")).released).toBe(true);
    expect((await release(env, "c1")).released).toBe(false);
    const s = await balanceSummary(env, "u1");
    expect(s.availableMicro).toBe(T(100));
    const late = await settleCall(env, "u1", "c1", 2000, 60);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe("released");
  });

  it("settle with zero seconds releases the whole reservation and spends nothing", async () => {
    await buy(env, "u1", 100, 82, "a");
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const s = await settleCall(env, "u1", "c1", 2000, 0);
    expect(s.ok && s.totalMicro).toBe(0);
    expect((await balanceSummary(env, "u1")).availableMicro).toBe(T(100));
  });

  it("settle can spend a further lot when the reservation was smaller than the call", async () => {
    await buy(env, "u1", 50, 82, "a");
    await reserveForCall(env, "u1", "c1", 2000, 3600); // holds all of lot a (123 s)
    await buy(env, "u1", 100, 100, "b"); // arrives mid call
    const s = await settleCall(env, "u1", "c1", 2000, 300);
    expect(s.billableSeconds).toBe(300);
    expect(s.lots.map((l) => l.valuePaisePerToken)).toEqual([82, 100]);
    expect(s.totalValuePaise).toBe(10000);
  });

  it("an empty wallet cannot reserve", async () => {
    const r = await reserveForCall(env, "nobody", "c1", 2000, 3600);
    expect(r.ok).toBe(false);
    expect(await getReservation(env, "c1")).toBe(null);
  });
});

describe("hf_token_ledger debt and refunds", () => {
  it("refund before any spend removes the lot and leaves no debt", async () => {
    const c = await buy(env, "u1", 100, 82, "O1");
    const r = await revokeLot(env, c.lotId, "hfvoid:O1");
    expect(r.applied).toBe(true);
    expect(r.removedMicro).toBe(T(100));
    expect(r.debtMicro).toBe(0);
    expect(await hasOpenDebt(env, "u1")).toBe(false);
    expect((await getLots(env, "u1")).length).toBe(0);
    expect((await revokeLot(env, c.lotId, "hfvoid:O1")).applied).toBe(false);
  });

  it("refund after 60 tokens spent removes 40, owes 60, then the next purchase clears the debt first", async () => {
    const c = await buy(env, "u1", 100, 82, "O1");
    // Rs 49.20/min = 82 paise a second = exactly 1 token a second at 0.82
    await reserveForCall(env, "u1", "c1", 4920, 100);
    const st = await settleCall(env, "u1", "c1", 4920, 60);
    expect(st.totalMicro).toBe(T(60));
    const r = await revokeLot(env, c.lotId, "hfvoid:O1");
    expect(r.removedMicro).toBe(T(40));
    expect(r.debtMicro).toBe(T(60));
    expect(r.debtValuePaise).toBe(4920);
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    const mid = await balanceSummary(env, "u1");
    expect(mid.debtValuePaise).toBe(4920);
    expect(mid.totalMicro).toBe(0);
    // a repeat of the same refund changes nothing
    expect((await revokeLot(env, c.lotId, "hfvoid:O1")).applied).toBe(false);
    expect((await balanceSummary(env, "u1")).debtValuePaise).toBe(4920);
    // next purchase: 100 tokens at Re 1 value; the Rs 49.20 owed takes 49.2 tokens of it
    await buy(env, "u1", 100, 100, "O2");
    expect(await hasOpenDebt(env, "u1")).toBe(false);
    const after = await balanceSummary(env, "u1");
    expect(after.totalMicro).toBe(T(50.8));
    // a retry of the same credit op does not charge the debt twice
    await buy(env, "u1", 100, 100, "O2");
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(50.8));
  });

  it("a purchase smaller than the debt clears part of it and the debt stays open", async () => {
    await createDebt(env, "u1", { amountMicro: T(100), valuePaise: 8200, sourceOrderId: "O0" }, "hfvoid:O0");
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    await buy(env, "u1", 50, 100, "O3"); // worth Rs 50
    const s = await balanceSummary(env, "u1");
    expect(s.debtValuePaise).toBe(3200);
    expect(s.totalMicro).toBe(0);
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    await buy(env, "u1", 100, 100, "O4");
    expect(await hasOpenDebt(env, "u1")).toBe(false);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(100) - T(32));
  });

  it("createDebt is idempotent per op id", async () => {
    await createDebt(env, "u1", { amountMicro: T(10), valuePaise: 820, sourceOrderId: "O" }, "d1");
    await createDebt(env, "u1", { amountMicro: T(10), valuePaise: 820, sourceOrderId: "O" }, "d1");
    expect((await balanceSummary(env, "u1")).debtValuePaise).toBe(820);
  });

  it("test lots never clear debt", async () => {
    await createDebt(env, "u1", { amountMicro: T(10), valuePaise: 820, sourceOrderId: "O" }, "d1");
    await creditLot(env, "u1", { kind: "test", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: T(500), paidPaise: 0, provider: null, providerRef: null }, "t1");
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(T(500));
  });

  it("clearDebtsFromLot is a no-op with no debt", async () => {
    const c = await buy(env, "u1", 10, 82, "a");
    expect(await clearDebtsFromLot(env, "u1", c.lotId, "a")).toEqual({ clearedValuePaise: 0, microUsed: 0 });
  });
});
