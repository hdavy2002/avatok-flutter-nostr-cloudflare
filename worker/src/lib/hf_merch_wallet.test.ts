// @ts-nocheck -- uses node:sqlite via the shared D1 shim
// [HF-MERCH-CORE-1] Real ledger SQL: merch is paid from PURCHASE lots only, and the "already charged" shortcut only counts a full, standing charge.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary, getLots } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";
import { spendWalletForOrder, refundWalletForOrder, merchRefundMarkOpId } from "./hf_merch_wallet";

const T = (n: number) => Math.round(n * MICRO);
const lot = (env: any, uid: string, kind: "purchase" | "test", tokens: number, op: string) =>
  creditLot(env, uid, { kind, pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: T(tokens), paidPaise: kind === "purchase" ? tokens * 100 : 0, provider: kind === "purchase" ? "cashfree" : "test", providerRef: op }, op);

let env: any;
beforeEach(() => { env = { DB_META: makeDb() }; });

describe("merch wallet: test credit is not spendable", () => {
  it("only test credit -> insufficient, balance 0, hint set", async () => {
    await lot(env, "u1", "test", 1000, "t1");
    const r = await spendWalletForOrder(env, "u1", "shp_a", 50_000);
    expect(r).toMatchObject({ ok: false, reason: "insufficient", balancePaise: 0, testCreditNotUsable: true });
    expect((await balanceSummary(env, "u1")).availableTestPaise).toBe(100_000); // untouched
  });
  it("purchase 300 + test 1000: a 500 order is refused with purchase-only balance, a 300 order spends only the purchase lot", async () => {
    await lot(env, "u1", "purchase", 300, "p1");
    await lot(env, "u1", "test", 1000, "t1");
    const short = await spendWalletForOrder(env, "u1", "shp_a", 50_000);
    expect(short).toMatchObject({ ok: false, reason: "insufficient", balancePaise: 30_000, shortPaise: 20_000, testCreditNotUsable: true });
    const ok = await spendWalletForOrder(env, "u1", "shp_b", 30_000);
    expect(ok).toMatchObject({ ok: true, spentPaise: 30_000 });
    const left = await getLots(env, "u1");
    expect(left.filter((l) => l.kind === "purchase").reduce((a, l) => a + l.leftMicro, 0)).toBe(0);
    expect(left.filter((l) => l.kind === "test").reduce((a, l) => a + l.leftMicro, 0)).toBe(T(1000));
  });
  it("no test credit -> no hint", async () => {
    await lot(env, "u1", "purchase", 10, "p1");
    expect(await spendWalletForOrder(env, "u1", "shp_a", 50_000)).toMatchObject({ ok: false, reason: "insufficient", testCreditNotUsable: false });
  });
});

describe("merch wallet: already-charged shortcut", () => {
  it("a retry after a full charge is ok and charges once", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    const a = await spendWalletForOrder(env, "u1", "shp_a", 20_000);
    const b = await spendWalletForOrder(env, "u1", "shp_a", 20_000);
    expect(a.ok && b.ok && b.again).toBe(true);
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(30_000);
  });
  it("after the charge was refunded, the shortcut must NOT say ok", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    await spendWalletForOrder(env, "u1", "shp_a", 20_000);
    expect((await refundWalletForOrder(env, "u1", "shp_a")).ok).toBe(true);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id=?").get(merchRefundMarkOpId("shp_a")).n).toBe(1);
    expect(await spendWalletForOrder(env, "u1", "shp_a", 20_000)).toMatchObject({ ok: false, reason: "conflict" });
  });
  it("a charge smaller than the order must NOT say ok", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    await spendWalletForOrder(env, "u1", "shp_a", 10_000);
    expect(await spendWalletForOrder(env, "u1", "shp_a", 20_000)).toMatchObject({ ok: false, reason: "conflict" });
  });
});
