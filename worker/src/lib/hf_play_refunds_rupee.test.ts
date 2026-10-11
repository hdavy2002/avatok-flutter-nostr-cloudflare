// @ts-nocheck -- uses node:sqlite via the shim
// [HF-STD-PLAN-1] Top-up refunds on the new rupee lots (gp-r2): Rs 120 paid, Rs 101.69 credited. The refundable amount is what was PAID
// (GST included) in proportion to the unspent wallet money; test lots and adjustment lots are never refundable.
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("./pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? `dec(${v})` : null) }));
const sent = vi.hoisted(() => ({ wa: [] as string[] }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+919999999999" }));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async (_e: any, _to: string, text: string) => { sent.wa.push(text); return { ok: true }; } }));

import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary } from "./hf_token_ledger";
import { paiseToMicro } from "./hf_token_math";
import { requestPlayRefunds, confirmPlayRefund, refundableLots, setPlayRefundPort, unspentSharePaise } from "./hf_play_refunds";

const MIGS = [
  "2026-10-10-hf-tokens.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql",
  "2026-10-09-hf-host-kyc.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-09-hf-topups.sql", "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-tok-exit-alters.sql",
];
let env: any;
const raw = () => env.DB_META._raw;
beforeEach(() => { env = { DB_META: makeDb(MIGS, { alters: true }) }; sent.wa.length = 0; });

/** A Play top-up of Rs 120 (GST included): wallet Rs 101.69, GST Rs 18.31. */
const topup = (uid = "u1", order = "GPA.1") =>
  creditLot(env, uid, { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(10169), paidPaise: 12000, provider: "google_play", providerRef: order, gstPaise: 1831 }, `hfplay:${order}`).then((r) => r.lotId as string);
const spendPaise = (lotId: string, paise: number) => raw().prepare("UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro - ? WHERE id=?").run(paiseToMicro(paise), lotId);

describe("rupee lot refunds", () => {
  it("a fully unspent Rs 120 top-up refunds Rs 120.00 through Google (the whole order), not Rs 101.69", async () => {
    const lot = await topup();
    expect(unspentSharePaise(12000, paiseToMicro(10169), paiseToMicro(10169))).toBe(12000);
    const lots = await refundableLots(env, "u1", 180);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ lotId: lot, sharePaise: 12000, wholeOrder: true, paidPaise: 12000 });
    const req = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(req).toMatchObject({ ok: true, amountPaise: 12000, lots: 1 });
    let asked: any = null;
    setPlayRefundPort({ refundOrderFor: async (_e: any, a: any) => { asked = a; return { ok: true }; } });
    const done = await confirmPlayRefund(env, req.ids[0], "admin1", { packageId: "com.test" });
    expect(done).toMatchObject({ ok: true, status: "refunded", recordedPaise: 12000 });
    expect(asked).toMatchObject({ orderId: "GPA.1" });
    // the unspent wallet money is gone, no debt, and the person is told in rupees
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(0);
    expect(raw().prepare("SELECT status FROM hf_token_lots WHERE id=?").get(lot).status).toBe("revoked");
    expect(sent.wa.join(" ")).toContain("₹120.00");
    expect(sent.wa.join(" ")).not.toMatch(/token/i);
    setPlayRefundPort(null);
  });

  it("a half-spent top-up refunds the proportional rupees of what was paid", async () => {
    const lot = await topup();
    spendPaise(lot, 5000); // Rs 50.00 of the Rs 101.69 used: Rs 51.69 left
    const lots = await refundableLots(env, "u1", 180);
    expect(lots[0].sharePaise).toBe(Math.floor((12000 * 5169) / 10169)); // 6099
    expect(lots[0].sharePaise).toBe(6099);
    expect(lots[0].wholeOrder).toBe(false);
    const req = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(req.amountPaise).toBe(6099);
    // Google refunds whole orders only: the admin refunds the partial amount in the Play Console and records it
    const noAmount = await confirmPlayRefund(env, req.ids[0], "admin1", { packageId: "com.test" });
    expect(noAmount).toMatchObject({ ok: false, error: "recorded_amount_required" });
    expect(noAmount.message).toContain("₹60.99");
    const done = await confirmPlayRefund(env, req.ids[0], "admin1", { packageId: "com.test", manual: true, recordedPaise: 6099 });
    expect(done).toMatchObject({ ok: true, status: "refunded", recordedPaise: 6099 });
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(0);
    expect(sent.wa.join(" ")).toContain("₹60.99");
  });

  it("test lots and adjustment lots (including call-charge corrections) are never refundable", async () => {
    await creditLot(env, "u1", { kind: "test", pricingVersion: "pt-v1", valuePaisePerToken: 100, micro: paiseToMicro(10000), paidPaise: 0, provider: "admin", providerRef: "t1" }, "t1");
    await creditLot(env, "u1", { kind: "adjustment", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(5000), paidPaise: 0, provider: "admin", providerRef: "hfcorr:x", note: "call_refund:x" }, "hfcorr:x");
    expect(await refundableLots(env, "u1", null)).toHaveLength(0);
    expect(await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 })).toMatchObject({ ok: false, error: "nothing_refundable" });
    // a real top-up next to them is still the only refundable thing
    await topup();
    const lots = await refundableLots(env, "u1", 180);
    expect(lots).toHaveLength(1);
    expect(lots[0].sharePaise).toBe(12000);
  });

  it("a fully spent top-up refunds nothing", async () => {
    const lot = await topup();
    spendPaise(lot, 10169);
    expect(await refundableLots(env, "u1", 180)).toHaveLength(0);
  });
});
