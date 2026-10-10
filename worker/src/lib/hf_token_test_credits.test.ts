// @ts-nocheck -- uses node:sqlite via the shim
// [HF-TOK-LEDGER-1] Admin test credits as `test` lots + the hf_credits migration helper.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { grantTestLot, migrateTestCreditsToLots } from "./hf_token_test_credits";
import { getLots, balanceSummary, reserveForCall, settleCall } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

let env: any;
beforeEach(() => { env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-credits.sql"]) }; });

describe("test credits as lots", () => {
  it("writes a test lot at the active gp-v2 value (51 paise) and is idempotent per key", async () => {
    const a = await grantTestLot(env, "u1", 200, "k1", "qa", "gp-v2");
    const b = await grantTestLot(env, "u1", 200, "k1", "qa", "gp-v2");
    expect(a.ok && a.applied).toBe(true);
    expect(b.ok && b.applied).toBe(false);
    const lots = await getLots(env, "u1");
    expect(lots.length).toBe(1);
    expect(lots[0]).toMatchObject({ kind: "test", valuePaisePerToken: 51, paidPaise: 0, grantedMicro: 200 * MICRO, pricingVersion: "gp-v2" });
  });
  it("rejects bad amounts and unknown versions", async () => {
    expect((await grantTestLot(env, "u1", 0, "k", "n", "gp-v2")).ok).toBe(false);
    expect((await grantTestLot(env, "u1", 2001, "k", "n", "gp-v2")).ok).toBe(false);
    expect((await grantTestLot(env, "u1", 1.5, "k", "n", "gp-v2")).ok).toBe(false);
    expect((await grantTestLot(env, "u1", 5, "k", "n", "nope")).ok).toBe(false);
  });
  it("a test lot pays for a call like any other lot", async () => {
    await grantTestLot(env, "u1", 100, "k1", "qa", "gp-v2");
    await reserveForCall(env, "u1", "c1", 2000, 3600);
    const s = await settleCall(env, "u1", "c1", 2000, 153); // 100 tokens x Rs 0.51 = Rs 51 = 153 s at Rs 20/min
    expect(s.ok && s.lots[0].kind).toBe("test");
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
  });
});

describe("migrate hf_credits test balance", () => {
  const seed = () => {
    env.DB_META._raw.exec("INSERT INTO hf_credits (uid, test_balance, test_reserved, updated_at) VALUES ('a', 120, 0, 1), ('b', 0, 0, 1), ('c', 5, 0, 1)");
  };
  it("dry run changes nothing; real run keeps the RUPEE value (rupees / 0.51 tokens) once per user and keeps hf_credits", async () => {
    seed();
    const dry = await migrateTestCreditsToLots(env, { dryRun: true, pricingVersionId: "gp-v2" });
    expect(dry.rows.map((r) => [r.uid, r.tokens, r.migrated])).toEqual([["a", 235.294118, false], ["c", 9.803922, false]]);
    expect((await getLots(env, "a")).length).toBe(0);
    const real = await migrateTestCreditsToLots(env, { dryRun: false, pricingVersionId: "gp-v2" });
    expect(real.rows.every((r) => r.migrated)).toBe(true);
    expect((await balanceSummary(env, "a")).totalMicro).toBe(235_294_118); // Rs 120 / Rs 0.51, rounded up to the micro
    expect((await getLots(env, "a"))[0]).toMatchObject({ kind: "test", valuePaisePerToken: 51, pricingVersion: "gp-v2" });
    const again = await migrateTestCreditsToLots(env, { dryRun: false, pricingVersionId: "gp-v2" });
    expect(again.rows.every((r) => r.alreadyMigrated && !r.migrated)).toBe(true);
    expect((await balanceSummary(env, "a")).totalMicro).toBe(235_294_118);
    expect(env.DB_META._raw.prepare("SELECT test_balance FROM hf_credits WHERE uid='a'").get().test_balance).toBe(120);
  });
});
