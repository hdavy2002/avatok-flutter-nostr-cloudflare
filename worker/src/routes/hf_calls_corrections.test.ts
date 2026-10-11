// @ts-nocheck -- uses node:sqlite via the shim
// [HF-STD-PLAN-1] POST /api/admin/hf/calls/:id/correct + the wallet history line it creates (one line, linked to the call).
import { describe, it, expect, beforeEach, vi } from "vitest";
const st = vi.hoisted(() => ({ uid: "admin1" }));
vi.mock("../authz", () => ({ requireUser: async () => (st.uid ? { uid: st.uid } : { error: "unauthorized", status: 401 }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfTokensEnabled: true }) }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("./wallet", () => ({ walletOp: async () => ({ status: 200, body: {} }) }));

import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot } from "../lib/hf_token_ledger";
import { prepareTokenStart, settleTokenCall, stdSnapshotFor } from "../lib/hf_token_calls";
import { readHfTokenConfig, readHfStdPlan } from "../lib/hf_token_config";
import { paiseToMicro, STD_TECH_MAX_SECONDS } from "../lib/hf_token_math";
import { hfCallsRoute } from "./hf_calls";

const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"];
const STD = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 }); const TK = readHfTokenConfig({ hfTokensEnabled: true });
let env: any; let audits: any[];
beforeEach(async () => {
  audits = []; st.uid = "admin1";
  env = { DB_META: makeDb(MIGS, { alters: true }), DB_WALLET: { prepare: () => ({ bind: (...a: any[]) => ({ run: async () => { audits.push(a); return {}; } }) }) } };
  env.DB_META._raw.exec("CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, display_name TEXT)");
  await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(30000), paidPaise: 30000, provider: "google_play", providerRef: "GPA.1" }, "hfplay:GPA.1");
  env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, tax_mode, split_rule_version) VALUES ('call_route_1','u1','h1',399,'completed',?, 'none_unregistered','std-r1/std-split-v1')").run(Date.now());
  await prepareTokenStart(env, { uid: "u1", callId: "call_route_1", ratePaise: 0, tk: TK, std: STD });
  await settleTokenCall(env, { callId: "call_route_1", callerUid: "u1", hostUid: "h1", ratePaise: 399, callCostPaisePerMin: 100, hostShareBps: 0, connectedSeconds: 3600, maxSeconds: STD_TECH_MAX_SECONDS, endedAt: Date.now(), std: stdSnapshotFor(STD).std });
});
const post = (id: string, body: any) => hfCallsRoute(new Request(`https://api.test/api/admin/hf/calls/${id}/correct`, { method: "POST", body: JSON.stringify(body) }), env, `/api/admin/hf/calls/${id}/correct`);

describe("POST /api/admin/hf/calls/:id/correct", () => {
  it("corrects, answers in the contract shape, and writes an audit row", async () => {
    const r = await post("call_route_1", { amountPaise: 5000, note: "billing error" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, correctedPaise: 5000, corrected: "₹50.00", hostReversedPaise: 2670, hostReversal: "reversed" });
    expect(audits).toHaveLength(1);
    expect(audits[0][2]).toBe("hf_call_charge_corrected");
    expect(audits[0][3]).toBe("call_route_1");
  });
  it("defaults to the whole charge and is idempotent", async () => {
    const a = await (await post("call_route_1", { note: "x" })).json();
    const b = await (await post("call_route_1", { amountPaise: 100, note: "y" })).json();
    expect(a).toMatchObject({ correctedPaise: 22470, hostReversedPaise: 12000, again: false });
    expect(b).toMatchObject({ correctedPaise: 22470, hostReversedPaise: 12000, again: true });
  });
  it("needs an admin, a note, a sane amount, and a real call", async () => {
    st.uid = "someone";
    expect((await post("call_route_1", { note: "x" })).status).toBe(403);
    st.uid = "admin1";
    expect((await post("call_route_1", {})).status).toBe(400);
    expect((await post("call_route_1", { note: "x", amountPaise: 1.5 })).status).toBe(400);
    expect((await post("call_route_1", { note: "x", amountPaise: 99999 })).status).toBe(400);
    expect((await post("call_missing_1", { note: "x" })).status).toBe(404);
  });
  it("the caller's wallet history shows ONE 'Call charge corrected' line, linked to the call, and no duplicate credit line", async () => {
    await post("call_route_1", { amountPaise: 5000, note: "x" });
    st.uid = "u1";
    const w = await (await hfCallsRoute(new Request("https://api.test/api/hf/wallet"), env, "/api/hf/wallet")).json();
    const lines = w.history.filter((h: any) => /correct|Test credit/i.test(h.label) || h.kind === "call_refund" || h.kind === "admin_adjust");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "call_refund", label: "Call charge corrected", amountPaise: 5000, amount: "+₹50.00", callId: "call_route_1" });
    expect(w.wallet.balancePaise).toBe(30000 - 22470 + 5000);
    expect(w.history.map((h: any) => h.label).join(" ")).not.toMatch(/token/i); // (the legacy `tokens` key is a rupee copy for old app builds)
    expect(w.history.filter((h: any) => h.kind === "call_spent")).toHaveLength(1);
  });
  it("[review] a rupee-lot migration adds no history lines (it is the same money, not a credit and a removal)", async () => {
    const { migrateLotsToRupees } = await import("../lib/hf_std_migrate");
    await creditLot(env, "u1", { kind: "test", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: 10_000_000, paidPaise: 0, provider: "admin", providerRef: "t" }, "tgrant");
    st.uid = "u1";
    const before = (await (await hfCallsRoute(new Request("https://api.test/api/hf/wallet"), env, "/api/hf/wallet")).json()).history.length;
    expect((await migrateLotsToRupees(env, { dryRun: false })).migrated).toHaveLength(1);
    const w = await (await hfCallsRoute(new Request("https://api.test/api/hf/wallet"), env, "/api/hf/wallet")).json();
    expect(w.history).toHaveLength(before);
  });
});
