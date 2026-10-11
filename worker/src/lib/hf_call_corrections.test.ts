// @ts-nocheck -- uses node:sqlite via the shim
// [HF-STD-PLAN-1] rule 6: call-charge corrections go back to the caller's wallet, once per call; the host is reversed only inside the 7-day hold.
import { describe, it, expect, beforeEach, vi } from "vitest";
const tracked = vi.hoisted(() => ({ events: [] as any[] }));
vi.mock("../hooks", () => ({ track: async (_e: any, uid: string, event: string, app: string, props: any) => { tracked.events.push({ uid, event, app, ...props }); }, trackException: async () => undefined }));
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary, getLots } from "./hf_token_ledger";
import { prepareTokenStart, settleTokenCall, stdSnapshotFor } from "./hf_token_calls";
import { hostSummary, listCallEarnings, reservePayout, HOST_HOLD_MS } from "./hf_host_ledger";
import { readHfTokenConfig, readHfStdPlan } from "./hf_token_config";
import { paiseToMicro, STD_TECH_MAX_SECONDS } from "./hf_token_math";
import { correctCallCharge } from "./hf_call_corrections";

const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"];
const TK = readHfTokenConfig({ hfTokensEnabled: true });
const STD = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 });
let env: any;
beforeEach(() => { env = { DB_META: makeDb(MIGS, { alters: true }) }; tracked.events.length = 0; });

const rlot = (uid: string, paise: number, op: string, kind: "purchase" | "test" = "purchase") =>
  creditLot(env, uid, { kind, pricingVersion: kind === "test" ? "pt-v1" : "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(paise), paidPaise: kind === "test" ? 0 : paise, provider: kind === "test" ? "admin" : "google_play", providerRef: op }, op);
const row = (id: string) => env.DB_META._raw.prepare("SELECT * FROM hf_calls WHERE id=?").get(id);
const q = (sql: string, ...a: unknown[]) => env.DB_META._raw.prepare(sql).all(...a);

/** A finished 60-minute Standard call: caller pays Rs 224.70, host earns Rs 120.00 (held until endedAt + 7 days). */
async function finishedCall(id = "call_one_1", o: { caller?: string; host?: string; minutes?: number; endedAt?: number; kind?: "purchase" | "test"; lot?: number } = {}) {
  const caller = o.caller ?? "u1", host = o.host ?? "h1";
  await rlot(caller, o.lot ?? 30000, `lot-${id}`, o.kind ?? "purchase");
  env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, tax_mode, split_rule_version) VALUES (?,?,?,399,'completed',?, 'none_unregistered','std-r1/std-split-v1')").run(id, caller, host, Date.now());
  await prepareTokenStart(env, { uid: caller, callId: id, ratePaise: 0, tk: TK, std: STD });
  return settleTokenCall(env, {
    callId: id, callerUid: caller, hostUid: host, ratePaise: 399, callCostPaisePerMin: 100, hostShareBps: 0,
    connectedSeconds: (o.minutes ?? 60) * 60, maxSeconds: STD_TECH_MAX_SECONDS, endedAt: o.endedAt ?? Date.now(), std: stdSnapshotFor(STD).std,
  });
}

describe("correctCallCharge", () => {
  it("defaults to the whole charge: wallet is whole again, the host's held earning is reversed", async () => {
    await finishedCall();
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470);
    const r = await correctCallCharge(env, { callId: "call_one_1", adminUid: "admin1", note: "double billed" });
    expect(r).toMatchObject({ ok: true, again: false, correctedPaise: 22470, chargedPaise: 22470, hostReversedPaise: 12000, hostReversal: "reversed" });
    const b = await balanceSummary(env, "u1");
    expect(b.totalPaise).toBe(30000);
    // paid-funded money returns as paid provenance, so spending it again can still produce withdrawable host earnings
    const lots = await getLots(env, "u1");
    const paid = lots.find((l) => l.kind === "purchase" && l.provider === "admin");
    expect(paid).toMatchObject({ valuePaisePerToken: 100, pricingVersion: "gp-r2", grantedMicro: paiseToMicro(22470), paidPaise: 0, provider: "admin" });
    // host: nothing left to earn or to be paid for this call
    const hs = await hostSummary(env, "h1");
    expect(hs.earnedPaise).toBe(0);
    expect(hs.pendingPaise).toBe(0);
    expect(hs.availablePaise).toBe(0);
    expect(row("call_one_1").consumed_value_paise).toBe(22470); // the call's own record stays as billed
  });

  it("a partial correction moves the host's share in proportion (floored)", async () => {
    await finishedCall();
    const r = await correctCallCharge(env, { callId: "call_one_1", amountPaise: 5000, adminUid: "admin1", note: "part" });
    expect(r).toMatchObject({ ok: true, correctedPaise: 5000, hostReversedPaise: Math.floor((12000 * 5000) / 22470), hostReversal: "reversed" });
    expect(r.hostReversedPaise).toBe(2670);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470 + 5000);
    const hs = await hostSummary(env, "h1");
    expect(hs.earnedPaise).toBe(12000 - 2670);
    expect(hs.pendingPaise).toBe(12000 - 2670);
  });

  it("never more than the charge, never zero or fractional", async () => {
    await finishedCall();
    expect(await correctCallCharge(env, { callId: "call_one_1", amountPaise: 22471, adminUid: "a", note: "x" })).toMatchObject({ ok: false, error: "exceeds_charge", maxPaise: 22470 });
    for (const bad of [0, -5, 1.5, NaN]) expect(await correctCallCharge(env, { callId: "call_one_1", amountPaise: bad, adminUid: "a", note: "x" })).toMatchObject({ ok: false, error: "invalid_amount" });
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470); // nothing moved
    expect(q("SELECT 1 FROM hf_token_ledger WHERE kind='call_refund'")).toHaveLength(0);
  });

  it("one correction per call: a second request moves nothing and answers with the first", async () => {
    await finishedCall();
    const a = await correctCallCharge(env, { callId: "call_one_1", amountPaise: 5000, adminUid: "admin1", note: "first" });
    const b = await correctCallCharge(env, { callId: "call_one_1", amountPaise: 9000, adminUid: "admin2", note: "second" });
    expect(b).toMatchObject({ ok: true, again: true, correctedPaise: 5000, hostReversedPaise: a.hostReversedPaise, hostReversal: "reversed" });
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470 + 5000);
    expect(q("SELECT 1 FROM hf_host_ledger WHERE op_id='hfcorr:call_one_1:host:paid'")).toHaveLength(1);
    expect(q("SELECT 1 FROM hf_token_ledger WHERE kind='call_refund'")).toHaveLength(1);
    expect(q("SELECT 1 FROM hf_token_lots WHERE kind='purchase' AND provider='admin'")).toHaveLength(1);
    expect(tracked.events.filter((e) => e.event === "hf_call_charge_corrected")).toHaveLength(1); // the event fires once
  });

  it("a crash after the credit and before the marker is healed by the retry (same amount, one credit)", async () => {
    await finishedCall();
    await correctCallCharge(env, { callId: "call_one_1", amountPaise: 5000, adminUid: "admin1", note: "first" });
    env.DB_META._raw.prepare("DELETE FROM hf_token_ledger WHERE op_id='hfcorr:call_one_1:mark'").run(); // simulate the lost last step
    const r = await correctCallCharge(env, { callId: "call_one_1", amountPaise: 22470, adminUid: "admin1", note: "retry" });
    expect(r).toMatchObject({ ok: true, correctedPaise: 5000, hostReversal: "reversed", hostReversedPaise: 2670 });
    expect(q("SELECT 1 FROM hf_token_ledger WHERE kind='call_refund'")).toHaveLength(1);
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000 - 22470 + 5000);
  });

  it("after the 7-day hold the platform absorbs it: the host keeps his money, the caller still gets hers", async () => {
    await finishedCall("call_old_01", { endedAt: Date.now() - HOST_HOLD_MS - 3_600_000 });
    const r = await correctCallCharge(env, { callId: "call_old_01", adminUid: "admin1", note: "late" });
    expect(r).toMatchObject({ ok: true, correctedPaise: 22470, hostReversedPaise: 0, hostReversal: "after_hold_platform_absorbs" });
    expect((await balanceSummary(env, "u1")).totalPaise).toBe(30000);
    expect(q("SELECT 1 FROM hf_host_ledger WHERE op_id LIKE 'hfcorr:call_old_01:host:%'")).toHaveLength(0);
    const hs = await hostSummary(env, "h1");
    expect(hs.earnedPaise).toBe(12000);
    expect(hs.availablePaise).toBe(12000);
    // and asking again repeats that same decision
    expect(await correctCallCharge(env, { callId: "call_old_01", adminUid: "admin1", note: "again" })).toMatchObject({ again: true, hostReversal: "after_hold_platform_absorbs", hostReversedPaise: 0 });
  });

  it("a call paid only with test credits: caller test provenance and host test earning are both reversed inside hold", async () => {
    await finishedCall("call_test_1", { kind: "test" });
    const r = await correctCallCharge(env, { callId: "call_test_1", adminUid: "admin1", note: "t" });
    expect(r).toMatchObject({ ok: true, correctedPaise: 22470, hostReversedPaise: 12000, hostReversal: "reversed" });
    expect((await getLots(env, "u1")).find((l) => l.kind === "test")).toMatchObject({ grantedMicro: paiseToMicro(22470) });
    expect(q("SELECT amount_paise FROM hf_host_ledger WHERE op_id='hfcorr:call_test_1:host:test'")[0].amount_paise).toBe(-12000);
    expect((await hostSummary(env, "h1")).testPaise).toBe(0);
  });

  it("splits a mixed correction by paid/test provenance and reverses both host earning kinds idempotently", async () => {
    await rlot("u1", 10000, "mixed-paid", "purchase");
    await rlot("u1", 20000, "mixed-test", "test");
    env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, tax_mode, split_rule_version) VALUES ('call_mixed_1','u1','h1',399,'completed',?, 'none_unregistered','std-r1/std-split-v1')").run(Date.now());
    await prepareTokenStart(env, { uid: "u1", callId: "call_mixed_1", ratePaise: 0, tk: TK, std: STD });
    await settleTokenCall(env, { callId: "call_mixed_1", callerUid: "u1", hostUid: "h1", ratePaise: 399, callCostPaisePerMin: 100,
      hostShareBps: 0, connectedSeconds: 3600, maxSeconds: STD_TECH_MAX_SECONDS, endedAt: Date.now(), std: stdSnapshotFor(STD).std });
    const first = await correctCallCharge(env, { callId: "call_mixed_1", adminUid: "admin1" });
    // Simulate a crash after the paid reversal but before the test reversal: retry must heal the missing half even across the hold boundary.
    env.DB_META._raw.prepare("DELETE FROM hf_host_ledger WHERE op_id='hfcorr:call_mixed_1:host:test'").run();
    env.DB_META._raw.prepare("UPDATE hf_host_ledger SET available_at=0 WHERE call_id='call_mixed_1' AND kind='call_earning'").run();
    const second = await correctCallCharge(env, { callId: "call_mixed_1", amountPaise: 1, adminUid: "admin2" });
    expect(first).toMatchObject({ ok: true, again: false, correctedPaise: 22470, hostReversedPaise: 12000, hostReversal: "reversed" });
    expect(second).toMatchObject({ ok: true, again: true, correctedPaise: 22470, hostReversedPaise: 12000, hostReversal: "reversed" });
    const returned = q("SELECT kind,tokens_granted_micro,source_lot_id FROM hf_token_lots WHERE provider_ref='hfcorr:call_mixed_1' ORDER BY kind");
    expect(returned).toEqual([
      expect.objectContaining({ kind: "purchase", tokens_granted_micro: paiseToMicro(10000) }),
      expect.objectContaining({ kind: "test", tokens_granted_micro: paiseToMicro(12470) }),
    ]);
    expect(returned.every((x: any) => !!x.source_lot_id)).toBe(true);
    expect(q("SELECT kind,amount_paise FROM hf_host_ledger WHERE op_id IN ('hfcorr:call_mixed_1:host:paid','hfcorr:call_mixed_1:host:test') ORDER BY kind"))
      .toEqual([expect.objectContaining({ kind: "admin_adjust", amount_paise: -5340 }), expect.objectContaining({ kind: "call_earning_test", amount_paise: -6660 })]);
  });

  it("not charged / unknown calls are refused", async () => {
    expect(await correctCallCharge(env, { callId: "nope_nope_1", adminUid: "a", note: "x" })).toMatchObject({ ok: false, error: "not_found" });
    env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at) VALUES ('call_free_1','u9','h1',399,'completed',1)").run();
    expect(await correctCallCharge(env, { callId: "call_free_1", adminUid: "a", note: "x" })).toMatchObject({ ok: false, error: "no_charge" });
  });

  it("the note records the paid share of the refund (traceability), and the lot is traceable to the call", async () => {
    await finishedCall();
    await correctCallCharge(env, { callId: "call_one_1", adminUid: "admin1", note: "n" });
    const l = q("SELECT note, purchase_id, op_id FROM hf_token_ledger WHERE op_id='hfcorr:call_one_1:paid'")[0];
    expect(l.note).toBe("call_refund:call_one_1;paid=22470");
    expect(l.purchase_id).toBe("hfcorr:call_one_1"); // provider ref of the lot
    expect(l.op_id).toBe("hfcorr:call_one_1:paid");
    expect(q("SELECT provider_ref, provider, source_lot_id FROM hf_token_lots WHERE kind='purchase' AND provider='admin'")[0]).toMatchObject({ provider_ref: "hfcorr:call_one_1", provider: "admin" });
    const half = await (async () => { await finishedCall("call_two_22", { caller: "u2", host: "h2" }); await correctCallCharge(env, { callId: "call_two_22", amountPaise: 10000, adminUid: "admin1", note: "n" }); return q("SELECT note FROM hf_token_ledger WHERE op_id='hfcorr:call_two_22:paid'")[0].note; })();
    expect(half).toBe("call_refund:call_two_22;paid=10000");
  });

  it("the wallet history line: ledger gets one 'call_refund' row linked to the call, worth the corrected rupees, no token movement", async () => {
    await finishedCall();
    await correctCallCharge(env, { callId: "call_one_1", amountPaise: 5000, adminUid: "admin1", note: "n" });
    const m = q("SELECT * FROM hf_token_ledger WHERE kind='call_refund'");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ uid: "u1", call_id: "call_one_1", delta_micro: 0, rupee_value_paise: 5000, op_id: "hfcorr:call_one_1:mark", note: "host=reversed" });
  });

  it("emits hf_call_charge_corrected with call id, amount and the host decision", async () => {
    await finishedCall();
    await correctCallCharge(env, { callId: "call_one_1", amountPaise: 5000, adminUid: "admin1", note: "n" });
    expect(tracked.events.find((e) => e.event === "hf_call_charge_corrected")).toMatchObject({ uid: "admin1", call_id: "call_one_1", amount_paise: 5000, host_reversal: "reversed", host_reversed_paise: 2670, caller_uid: "u1" });
  });

  it("host totals stay right across several calls and after the hold passes", async () => {
    const now = Date.now();
    await finishedCall("call_a_0001", { caller: "u1", host: "h1" });
    await finishedCall("call_b_0001", { caller: "u2", host: "h1" });
    await correctCallCharge(env, { callId: "call_a_0001", adminUid: "admin1", note: "n" }); // full: -12000 on the held earning of call A
    let hs = await hostSummary(env, "h1", now);
    expect(hs.earnedPaise).toBe(12000); // only call B left
    expect(hs.pendingPaise).toBe(12000);
    expect(hs.availablePaise).toBe(0); // the reversal does not eat into money that is already withdrawable (there is none yet)
    const per = await listCallEarnings(env, "h1");
    expect(per.find((p) => p.callId === "call_a_0001").paidPaise).toBe(0);
    expect(per.find((p) => p.callId === "call_b_0001").paidPaise).toBe(12000);
    hs = await hostSummary(env, "h1", now + HOST_HOLD_MS + 60_000); // 7 days later
    expect(hs.maturedPaise).toBe(12000); // A: +12000 -12000, B: +12000
    expect(hs.availablePaise).toBe(12000);
    expect(hs.pendingPaise).toBe(0);
    // the payout check uses the same arithmetic: Rs 120 can be reserved, Rs 121 cannot
    expect((await reservePayout(env, "h1", "p-too-much", 12100, now + HOST_HOLD_MS + 60_000)).ok).toBe(false);
    expect((await reservePayout(env, "h1", "p-ok", 12000, now + HOST_HOLD_MS + 60_000)).ok).toBe(true);
  });

  it("a pending reversal does not reduce another call's matured money", async () => {
    const now = Date.now();
    await finishedCall("call_old_02", { caller: "u1", host: "h1", endedAt: now - HOST_HOLD_MS - 3_600_000 }); // matured: Rs 120 withdrawable
    await finishedCall("call_new_02", { caller: "u2", host: "h1" }); // held
    await correctCallCharge(env, { callId: "call_new_02", adminUid: "admin1", note: "n" });
    const hs = await hostSummary(env, "h1", now);
    expect(hs.availablePaise).toBe(12000);
    expect(hs.pendingPaise).toBe(0);
  });
});
