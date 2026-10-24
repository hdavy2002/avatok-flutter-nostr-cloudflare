// @ts-nocheck -- uses node:sqlite via the shim
// [HF-WALLET-DEDUCTIONS-1] GET /api/hf/wallet lists every rupee that left the wallet, not only calls: merch orders and AI pictures are
// one minus line each, and their refunds are one plus line each (never a bogus "Money added" line).
import { describe, it, expect, beforeEach, vi } from "vitest";
const st = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: st.uid }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: () => false }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfTokensEnabled: true, hfStdPlanEnabled: true, hfAppMinBuild: 2078, hfMerchAiEnabled: true, hfMerchAiChargeRupees: 10 }) }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("./wallet", () => ({ walletOp: async () => ({ status: 200, body: {} }) }));
vi.mock("../lib/hf_merch_products", () => ({ saveMerchArt: async () => ({ ok: false, status: 500, error: "x", message: "x" }) }));
vi.mock("../lib/hf_merch_notify", () => ({ merchTrack: async () => {}, merchFail: async () => {} }));

import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot } from "../lib/hf_token_ledger";
import { paiseToMicro } from "../lib/hf_token_math";
import { spendWalletForAi, refundWalletForAi } from "../lib/hf_merch_ai";
import { spendWalletForOrder, refundWalletForOrder } from "../lib/hf_merch_wallet";
import { normalizeAppWallet } from "../lib/hf_app_wallet";
import { hfCallsRoute } from "./hf_calls";

const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"];
let env: any;
const wallet = async () => (await hfCallsRoute(new Request("https://api.test/api/hf/wallet"), env, "/api/hf/wallet")).json();
beforeEach(async () => {
  env = { DB_META: makeDb(MIGS, { alters: true }), DB_WALLET: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } };
  env.DB_META._raw.exec("CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, display_name TEXT)");
  env.DB_META._raw.exec("CREATE TABLE shop_orders (order_id TEXT PRIMARY KEY, uid TEXT, order_no TEXT)");
  env.DB_META._raw.prepare("INSERT INTO shop_orders VALUES ('ord_1','u1','HF-1042')").run();
  await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(50000), paidPaise: 50000, provider: "cashfree", providerRef: "cf1" }, "cf1");
});

describe("wallet history shows non-call deductions", () => {
  it("an AI picture and a merch order are each one minus line with a plain label", async () => {
    expect((await spendWalletForAi(env, "u1", "gen1", 1000)).ok).toBe(true);
    expect((await spendWalletForOrder(env, "u1", "ord_1", 49900)).ok).toBe(false); // ₹490 left, so a ₹499 order is refused
    expect((await spendWalletForOrder(env, "u1", "ord_1", 30000)).ok).toBe(true);
    const w = await wallet();
    const ai = w.history.filter((h: any) => h.kind === "ai_spent");
    const merch = w.history.filter((h: any) => h.kind === "merch_spent");
    expect(ai).toEqual([expect.objectContaining({ amountPaise: -1000, amount: "-₹10.00", label: "AI picture for your merch" })]);
    expect(merch).toEqual([expect.objectContaining({ amountPaise: -30000, amount: "-₹300.00", label: "Merch order #HF-1042" })]);
    expect(w.wallet.balancePaise).toBe(50000 - 1000 - 30000);
    const app = normalizeAppWallet(w, { limit: 50 });
    expect(app.ledger.filter((r) => r.kind === "spend").map((r) => r.amountPaise).sort()).toEqual([-1000, -30000].sort());
  });
  it("a refund is one plus line (not 'Money added', not 'Call charge corrected'), and the charge line stays", async () => {
    await spendWalletForAi(env, "u1", "gen2", 1000);
    expect((await refundWalletForAi(env, "u1", "gen2")).ok).toBe(true);
    await spendWalletForOrder(env, "u1", "ord_1", 20000);
    expect((await refundWalletForOrder(env, "u1", "ord_1")).ok).toBe(true);
    const w = await wallet();
    const labels = w.history.map((h: any) => h.label);
    expect(labels.filter((l: string) => l === "Money added")).toHaveLength(1); // only the real top-up
    expect(labels).not.toContain("Call charge corrected");
    expect(w.history.find((h: any) => h.kind === "ai_refund")).toMatchObject({ amountPaise: 1000, amount: "+₹10.00" });
    expect(w.history.find((h: any) => h.kind === "merch_refund")).toMatchObject({ amountPaise: 20000, label: "Merch order refunded" });
    expect(w.history.find((h: any) => h.kind === "ai_refund").callId).toBeUndefined();
    expect(w.history.filter((h: any) => h.kind === "ai_spent" || h.kind === "merch_spent")).toHaveLength(2);
    expect(w.wallet.balancePaise).toBe(50000);
  });
});
