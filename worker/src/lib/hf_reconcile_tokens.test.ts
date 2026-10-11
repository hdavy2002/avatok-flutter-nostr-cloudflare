// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-STD-PLAN-1] Token reconciliation is rupee-correct and checks paid = wallet + GST for gp-r2 top-ups.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot } from "./hf_token_ledger";
import { buildTokenReconciliation, lotWalletPaise, topupGstMismatches, loadTokenReconciliation, tokenReconciliationCsv } from "./hf_reconcile_tokens";
import { paiseToMicro, topupSplit } from "./hf_token_math";
import { istDayStart } from "./hf_ist";

const lot = (o: any = {}) => ({ id: "l1", kind: "purchase", created_at: 1, tokens_granted_micro: paiseToMicro(10169), paid_paise: 12000, redemption_paise_per_token: 100, gst_paise: 1831, pricing_version: "gp-r2", source_lot_id: null, ...o });

describe("pure", () => {
  it("wallet value of a rupee lot and of an old gp-v1 lot", () => {
    expect(lotWalletPaise(lot())).toBe(10169);
    expect(lotWalletPaise({ tokens_granted_micro: 100_000_000, redemption_paise_per_token: 82 })).toBe(8200);
  });
  it("Rs 120 -> 101.69 + 18.31 reconciles", () => {
    expect(topupGstMismatches([lot()])).toEqual([]);
  });
  it("flags paid != wallet + gst", () => {
    const bad = topupGstMismatches([lot({ tokens_granted_micro: paiseToMicro(10200), gst_paise: 1831 })]);
    expect(bad.length).toBe(1);
    expect(bad[0]).toMatchObject({ kind: "topup_gst_split", expected: 12000, actual: 12031 });
    expect(topupGstMismatches([lot({ gst_paise: 0 })]).length).toBe(1);
  });
  it("old gp-r1 / gp-v1 lots and migration lots are not checked", () => {
    expect(topupGstMismatches([lot({ pricing_version: "gp-r1", gst_paise: 0, paid_paise: 10000, tokens_granted_micro: paiseToMicro(10000) })])).toEqual([]);
    expect(topupGstMismatches([lot({ pricing_version: "gp-v1", redemption_paise_per_token: 82, gst_paise: 0 })])).toEqual([]);
    expect(topupGstMismatches([lot({ source_lot_id: "old", paid_paise: 5, gst_paise: 0 })])).toEqual([]);
    expect(topupGstMismatches([lot({ kind: "test", paid_paise: 0, gst_paise: 0 })])).toEqual([]);
  });
  it("build: per India day GST included and wallet credited; migration lots not double counted; call refunds counted", () => {
    const day = istDayStart(Date.now());
    const r = buildTokenReconciliation({
      fromMs: day, toMs: day + 86_400_000,
      lots: [lot({ created_at: day + 1000 }), lot({ id: "l2", created_at: day + 2000, source_lot_id: "l0" })],
      calls: [], ledger: [{ kind: "call_refund", delta_micro: 100, rupee_value_paise: 399, created_at: day + 5 }], hostLedger: [], playRefunds: [],
      openDebts: { count: 0, valuePaise: 0, tokensMicro: 0 }, outstanding: { purchaseTokensMicro: 0, testTokensMicro: 0, hostBalancePaise: 0, purchasePaise: 0, testPaise: 0 }, mismatches: [],
    });
    expect(r.totals.purchases).toMatchObject({ count: 1, paidPaise: 12000, gstPaise: 1831, walletPaise: 10169 });
    expect(r.totals.refunds).toMatchObject({ callRefunds: 1, callRefundPaise: 399 });
    expect(tokenReconciliationCsv(r)).toContain("purchases_gst_included_paise");
  });
});

describe("loader (D1 shim)", () => {
  let env: any;
  beforeEach(() => { env = { DB_META: makeDb() }; });
  const buyR2 = (uid: string, paid: number, op: string, forceWallet?: number) => {
    const s = topupSplit(paid, 1800);
    return creditLot(env, uid, { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(forceWallet ?? s.walletPaise), paidPaise: paid, gstPaise: s.gstPaise, provider: "google_play", providerRef: op }, op);
  };
  it("a correct Rs 120 top-up reconciles with GST and wallet totals", async () => {
    await buyR2("u1", 12000, "O1");
    const r = await loadTokenReconciliation(env, Date.now() - 86_400_000, Date.now() + 86_400_000);
    expect(r.totals.purchases).toMatchObject({ count: 1, paidPaise: 12000, gstPaise: 1831, walletPaise: 10169 });
    expect(r.outstanding.purchasePaise).toBe(10169);
    expect(r.mismatches.filter((m) => m.kind === "topup_gst_split")).toEqual([]);
  });
  it("a Rs 102 credit for Rs 120 is a mismatch", async () => {
    await buyR2("u1", 12000, "O2", 10200);
    const r = await loadTokenReconciliation(env, Date.now() - 86_400_000, Date.now() + 86_400_000);
    expect(r.mismatches.filter((m) => m.kind === "topup_gst_split").length).toBe(1);
  });
});
