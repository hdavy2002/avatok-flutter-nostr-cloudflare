// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-STD-PLAN-1] Explicit lot migration: a gp-v1 lot (value 82) becomes a rupee lot of the same spendable paise; idempotent; reservations skipped.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, getLots, balanceSummary, reserveForCall } from "./hf_token_ledger";
import { migrateLotsToRupees, needsRupeeMigration, spendablePaise } from "./hf_std_migrate";
import { loadTokenReconciliation } from "./hf_reconcile_tokens";
import { MICRO, flatTariff, paiseToMicro } from "./hf_token_math";

const T = (n: number) => Math.round(n * MICRO);
let env: any;
const raw = () => env.DB_META._raw;
const buy = (uid: string, tokens: number, v: number, op: string, kind = "purchase") =>
  creditLot(env, uid, { kind, pricingVersion: v === 82 ? "gp-v1" : "gp-r1", valuePaisePerToken: v, micro: T(tokens), paidPaise: tokens * 100, provider: "google_play", providerRef: op }, op);
beforeEach(() => { env = { DB_META: makeDb() }; });

describe("pure helpers", () => {
  it("rupee-exact lots are left alone", () => {
    expect(needsRupeeMigration({ redemption_paise_per_token: 100, tokens_left_micro: 8_200_0000 })).toBe(false);
    expect(needsRupeeMigration({ redemption_paise_per_token: 82, tokens_left_micro: T(100) })).toBe(true);
    expect(needsRupeeMigration({ redemption_paise_per_token: 100, tokens_left_micro: 10_001 })).toBe(true);
    expect(spendablePaise(T(100), 82)).toBe(8200);
    expect(spendablePaise(T(1) + 1, 82)).toBe(82);
  });
});

describe("migrateLotsToRupees", () => {
  it("a gp-v1 lot with 100 tokens left becomes a Rs 82.00 rupee lot; balance in paise is identical", async () => {
    const a = await buy("u1", 100, 82, "hfplay:O1");
    const before = await balanceSummary(env, "u1");
    expect(before.availablePaise).toBe(8200);
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.dryRun).toBe(false);
    expect(rep.migrated.length).toBe(1);
    expect(rep.migrated[0]).toMatchObject({ lotId: a.lotId, uid: "u1", beforePaise: 8200, afterPaise: 8200 });
    const after = await balanceSummary(env, "u1");
    expect(after.availablePaise).toBe(8200);
    expect(after.totalPaise).toBe(8200);
    const lots = await getLots(env, "u1");
    expect(lots.length).toBe(1);
    expect(lots[0]).toMatchObject({ pricingVersion: "gp-r2", valuePaisePerToken: 100, leftMicro: 8200 * 10_000, kind: "purchase", paidPaise: 10000, provider: "google_play", providerRef: "hfplay:O1" });
    expect(raw().prepare("SELECT source_lot_id AS s FROM hf_token_lots WHERE id=?").get(lots[0].id).s).toBe(a.lotId);
    const old = raw().prepare("SELECT status, tokens_left_micro AS l FROM hf_token_lots WHERE id=?").get(a.lotId);
    expect(old).toEqual({ status: "migrated", l: 0 });
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id IN (?,?,?)").get(`hfmig:${a.lotId}`, `hfmigcr:${a.lotId}`, `hfmigdone:${a.lotId}`).n).toBe(3);
    // never a second "purchase" row in the history
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE kind='purchase'").get().n).toBe(1);
    expect(rep.perUser).toEqual([{ uid: "u1", lots: 1, beforePaise: 8200, afterPaise: 8200, skippedLots: 0 }]);
  });

  it("dry run (the default) writes nothing", async () => {
    await buy("u1", 100, 82, "O1");
    const rep = await migrateLotsToRupees(env);
    expect(rep.dryRun).toBe(true);
    expect(rep.migrated.length).toBe(1);
    expect(rep.migrated[0].newLotId).toBeNull();
    expect((await getLots(env, "u1"))[0].valuePaisePerToken).toBe(82);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_lots").get().n).toBe(1);
  });

  it("running twice changes nothing", async () => {
    await buy("u1", 100, 82, "O1");
    await migrateLotsToRupees(env, { dryRun: false });
    const snap = () => JSON.stringify([raw().prepare("SELECT * FROM hf_token_lots ORDER BY rowid").all(), raw().prepare("SELECT op_id, delta_micro FROM hf_token_ledger ORDER BY rowid").all()]);
    const s1 = snap();
    const rep2 = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep2.migrated.length).toBe(0);
    expect(snap()).toBe(s1);
  });

  it("walks every cursor batch in one run, then a rerun is empty", async () => {
    await buy("u1", 10, 82, "O1");
    await buy("u2", 20, 82, "O2");
    await buy("u3", 30, 82, "O3");
    const first = await migrateLotsToRupees(env, { dryRun: false, batchSize: 2 });
    expect(first).toMatchObject({ batches: 2, scanned: 3 });
    expect(first.migrated).toHaveLength(3);
    expect((await migrateLotsToRupees(env, { dryRun: false, batchSize: 2 })).scanned).toBe(0);
  });

  it("a lot that is already rupee-exact is untouched", async () => {
    await buy("u1", 50, 100, "O2");
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.scanned).toBe(0);
    expect(rep.migrated.length).toBe(0);
    expect((await getLots(env, "u1")).length).toBe(1);
  });

  it("a reserved lot is skipped and reported, balance untouched", async () => {
    await buy("u1", 100, 82, "O1");
    const r = await reserveForCall(env, "u1", "call1", flatTariff(399), 120);
    expect(r.ok).toBe(true);
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.migrated.length).toBe(0);
    expect(rep.skipped.length).toBe(1);
    expect(rep.skipped[0]).toMatchObject({ uid: "u1", reason: "reserved" });
    expect((await getLots(env, "u1"))[0].valuePaisePerToken).toBe(82);
  });

  it("floors fractions of a paisa exactly like the balance does; sub-paisa lots are closed with no new lot", async () => {
    await creditLot(env, "u2", { kind: "test", pricingVersion: "gp-r1", valuePaisePerToken: 100, micro: 1_234_567, paidPaise: 0, provider: null, providerRef: null }, "t1");
    const before = await balanceSummary(env, "u2");
    expect(before.availablePaise).toBe(123);
    await migrateLotsToRupees(env, { dryRun: false });
    const after = await balanceSummary(env, "u2");
    expect(after.availablePaise).toBe(123);
    expect((await getLots(env, "u2"))[0]).toMatchObject({ kind: "test", valuePaisePerToken: 100, leftMicro: 1_230_000, pricingVersion: "gp-r2" });
    await creditLot(env, "u3", { kind: "test", pricingVersion: "gp-r1", valuePaisePerToken: 100, micro: 5_000, paidPaise: 0, provider: null, providerRef: null }, "t2");
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.migrated.length).toBe(1);
    expect((await getLots(env, "u3")).length).toBe(0);
  });

  it("heals a crash between closing the old lot and crediting the new one", async () => {
    const a = await buy("u1", 100, 82, "O1");
    // simulate step 1 only
    const lot = raw().prepare("SELECT tokens_left_micro AS l FROM hf_token_lots WHERE id=?").get(a.lotId);
    raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES ('x','u1','admin_adjust',?,?,?,?,1)").run(a.lotId, -lot.l, 8200, `hfmig:${a.lotId}`);
    raw().prepare("UPDATE hf_token_lots SET tokens_left_micro=0, status='migrated' WHERE id=?").run(a.lotId);
    expect((await balanceSummary(env, "u1")).availablePaise).toBe(0);
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.migrated.length).toBe(1);
    expect(rep.migrated[0].resumed).toBe(true);
    expect((await balanceSummary(env, "u1")).availablePaise).toBe(8200);
    expect((await migrateLotsToRupees(env, { dryRun: false })).migrated.length).toBe(0);
  });

  it("repairs every replacement invariant after a crash following credit, then writes the final marker", async () => {
    const a = await buy("u1", 100, 82, "hfplay:O-crash");
    raw().prepare("INSERT INTO hf_play_purchases (id,purchase_token,order_id,product_id,uid,state,lot_id,created_at) VALUES ('p','tok-crash','O-crash','hf_tokens_100','u1','credited',?,1)").run(a.lotId);
    await migrateLotsToRupees(env, { dryRun: false });
    const replacement = raw().prepare("SELECT id FROM hf_token_lots WHERE source_lot_id=?").get(a.lotId).id;
    raw().prepare("DELETE FROM hf_token_ledger WHERE op_id=?").run(`hfmigdone:${a.lotId}`);
    raw().prepare("UPDATE hf_token_lots SET pricing_version='bad', redemption_paise_per_token=7, tokens_granted_micro=1, paid_paise=0, provider=NULL, provider_ref=NULL, created_at=999, gst_paise=9, source_lot_id=NULL WHERE id=?").run(replacement);
    raw().prepare("UPDATE hf_token_ledger SET uid='wrong',kind='purchase',lot_id='wrong',delta_micro=1,rupee_value_paise=1,call_id='wrong',purchase_id=NULL,note='wrong',created_at=999 WHERE op_id=?").run(`hfmigcr:${a.lotId}`);
    raw().prepare("UPDATE hf_play_purchases SET lot_id=? WHERE id='p'").run(a.lotId);
    const repaired = await migrateLotsToRupees(env, { dryRun: false });
    expect(repaired).toMatchObject({ repaired: 1, remaining: 0, done: true });
    expect(raw().prepare("SELECT pricing_version,redemption_paise_per_token,tokens_granted_micro,paid_paise,provider,provider_ref,created_at,gst_paise,source_lot_id FROM hf_token_lots WHERE id=?").get(replacement))
      .toMatchObject({ pricing_version: "gp-r2", redemption_paise_per_token: 100, tokens_granted_micro: paiseToMicro(8200), paid_paise: 10000,
        provider: "google_play", provider_ref: "hfplay:O-crash", source_lot_id: a.lotId });
    expect(raw().prepare("SELECT uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,purchase_id,note,created_at FROM hf_token_ledger WHERE op_id=?").get(`hfmigcr:${a.lotId}`))
      .toMatchObject({ uid: "u1", kind: "admin_adjust", lot_id: replacement, delta_micro: paiseToMicro(8200), rupee_value_paise: 8200,
        call_id: null, purchase_id: "hfplay:O-crash", note: "hf_std_migration" });
    expect(raw().prepare("SELECT lot_id FROM hf_play_purchases WHERE id='p'").get().lot_id).toBe(replacement);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id=?").get(`hfmigdone:${a.lotId}`).n).toBe(1);
  });

  it("the token reconciliation stays clean after a migration (lot balances, no double purchase)", async () => {
    await buy("u1", 100, 82, "O1");
    await migrateLotsToRupees(env, { dryRun: false });
    const rec = await loadTokenReconciliation(env, Date.now() - 86_400_000, Date.now() + 86_400_000);
    expect(rec.mismatches.filter((m) => m.kind === "lot_balance")).toEqual([]);
    expect(rec.totals.purchases.count).toBe(1);
  });
});

describe("[HF-STD-PLAN-1 review] migration keeps a purchase's history", () => {
  it("a half-spent gp-v1 purchase: refund share, debt on a Google void and the refund window are what they were before", async () => {
    const { settleCall, revokeLot } = await import("./hf_token_ledger");
    const { pickRefundableLots } = await import("./hf_play_refunds");
    const refundableLots = async (_e: any, uid: string, days: number) =>
      pickRefundableLots(raw().prepare("SELECT * FROM hf_token_lots WHERE uid=? AND kind='purchase' AND status='active' AND tokens_left_micro>0").all(uid), new Set(), Date.now(), days);
    const a = await buy("u1", 100, 82, "hfplay:O9"); // Rs 100 paid, worth Rs 82
    const old = Date.now() - 100 * 86_400_000;
    raw().prepare("UPDATE hf_token_lots SET created_at=? WHERE id=?").run(old, a.lotId);
    const s = await settleCall(env, "u1", "c1", flatTariff(4100), 60); // spend Rs 41 = 50 tokens
    expect(s.ok && s.totalValuePaise).toBe(4100);
    const before = await refundableLots(env, "u1", 180);
    expect(before[0]).toMatchObject({ sharePaise: 5000, wholeOrder: false });
    await migrateLotsToRupees(env, { dryRun: false });
    const lots = await getLots(env, "u1");
    expect(lots[0]).toMatchObject({ leftMicro: 4100 * 10_000, grantedMicro: 8200 * 10_000, createdAt: old, paidPaise: 10000 });
    const after = await refundableLots(env, "u1", 180);
    expect(after[0]).toMatchObject({ sharePaise: 5000, wholeOrder: false });
    const v = await revokeLot(env, lots[0].id, "hfvoid:O9");
    expect(v.debtValuePaise).toBe(4100);
  });
  it("a purchase lot with less than a paisa left is not closed (its Google purchase keeps pointing at a live lot)", async () => {
    const a = await buy("u1", 1, 82, "hfplay:O10");
    raw().prepare("UPDATE hf_token_lots SET tokens_left_micro=5 WHERE id=?").run(a.lotId);
    raw().prepare("UPDATE hf_token_ledger SET delta_micro=5 WHERE op_id=?").run("hfplay:O10");
    const rep = await migrateLotsToRupees(env, { dryRun: false });
    expect(rep.skipped).toEqual([expect.objectContaining({ lotId: a.lotId, reason: "dust_purchase" })]);
    expect(raw().prepare("SELECT status FROM hf_token_lots WHERE id=?").get(a.lotId).status).toBe("active");
  });
});
