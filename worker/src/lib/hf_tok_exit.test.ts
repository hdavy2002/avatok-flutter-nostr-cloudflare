// @ts-nocheck -- uses node:sqlite via the shim

// [HF-TOK-EXIT-1] Token-aware refunds (Google Play), account closing, debt write-off, test-lot removal. Real SQL on in-memory SQLite.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../routes/config", () => ({ readConfig: async () => ({ hfTokensEnabled: true, hfExitGateEnabled: true, hfRefundsEnabled: false, hfRefundWindowDays: 180 }) }));
vi.mock("./pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? `dec(${v})` : null) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../routes/wallet", () => ({ walletOp: async () => ({ status: 200, body: { balance: 0, held: 0 } }) }));
vi.mock("./hf_credits", () => ({ getTestBalance: async () => ({ balance: 0, reserved: 0 }) }));
vi.mock("./payments/registry", () => ({ resolveGateway: () => null }));

import { makeDb } from "./hf_token_d1_shim";
import { creditLot } from "./hf_token_ledger";
import { creditCallEarning, hostSummary } from "./hf_host_ledger";
import { MICRO } from "./hf_token_math";
import {
  unspentSharePaise, requestPlayRefunds, confirmPlayRefund, rejectPlayRefund, cancelPlayRefund, setPlayRefundPort, hasActiveCall, refundableLots, playRefundOpId,
} from "./hf_play_refunds";
import { finishTokenExit, removeTestLots, writeOffDebts } from "./hf_exit_tokens";
import { startExit, cancelExit, runHfExitCron, getExitRow, exitSummary } from "./hf_exit";

const T = (n: number) => Math.round(n * MICRO);
const DAY = 86_400_000;
const MIGS = [
  "2026-10-10-hf-tokens.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql",
  "2026-10-09-hf-host-kyc.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-09-hf-topups.sql", "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-tok-exit-alters.sql",
];

let env: any;
const raw = () => env.DB_META._raw;
beforeEach(() => { env = { DB_META: makeDb(MIGS, { alters: true }) }; setPlayRefundPort(null); });

const lot = (uid: string, kind: "purchase" | "test", tokens: number, v: number, op: string, paidRupees?: number, ageDays = 1) =>
  creditLot(env, uid, {
    kind, pricingVersion: v === 82 ? "gp-v1" : "pt-v1", valuePaisePerToken: v, micro: T(tokens),
    paidPaise: kind === "test" ? 0 : (paidRupees ?? tokens) * 100, provider: kind === "test" ? "admin" : "google_play", providerRef: op,
  }, op).then((r) => { raw().prepare("UPDATE hf_token_lots SET created_at=? WHERE id=?").run(Date.now() - ageDays * DAY, r.lotId); return r.lotId as string; });
const spend = (lotId: string, tokens: number) => raw().prepare("UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro - ? WHERE id=?").run(T(tokens), lotId);
const lotRow = (id: string) => raw().prepare("SELECT * FROM hf_token_lots WHERE id=?").get(id);
const refundRow = (id: string) => raw().prepare("SELECT * FROM hf_refund_requests WHERE id=?").get(id);
const ledgerOps = (op: string) => raw().prepare("SELECT * FROM hf_token_ledger WHERE op_id=?").all(op);

describe("pure share maths", () => {
  it("pro-rata unspent share, floored, never above what was paid", () => {
    expect(unspentSharePaise(10000, T(100), T(100))).toBe(10000);
    expect(unspentSharePaise(10000, T(100), T(40))).toBe(4000);
    expect(unspentSharePaise(10000, T(3), T(1))).toBe(3333);
    expect(unspentSharePaise(10000, T(100), T(200))).toBe(10000);
    expect(unspentSharePaise(10000, 0, 0)).toBe(0);
  });
});

describe("refund requests per purchase lot", () => {
  it("one request per unspent purchase lot, test lots never; the amount is the unspent share", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    const b = await lot("u1", "purchase", 50, 82, "GPA.2", 41);
    await lot("u1", "test", 30, 100, "t1");
    spend(b, 20); // 30 of 50 left -> 60% of Rs 41 = 2460 paise
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(r.ok).toBe(true);
    expect(r.ids.length).toBe(2);
    expect(r.amountPaise).toBe(8200 + 2460);
    const rows = raw().prepare("SELECT * FROM hf_refund_requests ORDER BY amount_paise DESC").all();
    expect(rows.map((x: any) => x.kind)).toEqual(["play_refund", "play_refund"]);
    expect(rows.map((x: any) => x.order_id).sort()).toEqual(["GPA.1", "GPA.2"]);
    expect(rows[0].lot_id).toBe(a);
    // asking again does not create more
    const again = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_refund_requests").get().n).toBe(2);
    expect(again.ok).toBe(false);
    expect(again.error).toBe("nothing_refundable"); // lots with an open request are not offered again
  });

  it("outside the 180 day window is refused for a user request but allowed for a closure", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.old", 82, 200);
    expect((await refundableLots(env, "u1", 180)).length).toBe(0);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(r.ok).toBe(false);
    const c = await requestPlayRefunds(env, "u1", { exit: true, windowDays: 180 });
    expect(c.ok).toBe(true);
    expect(c.ids.length).toBe(1);
  });

  it("is refused while the user is on a call", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    raw().prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at) VALUES ('c1','u1','h1',2000,'connected',?)").run(Date.now());
    expect(await hasActiveCall(env, "u1")).toBe(true);
    expect(await hasActiveCall(env, "h1")).toBe(true);
    expect(await hasActiveCall(env, "other")).toBe(false);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("active_call");
  });

  it("cancel and reject leave the tokens alone", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    const id = r.ids[0];
    expect((await cancelPlayRefund(env, id, "u1")).ok).toBe(true);
    expect(refundRow(id).status).toBe("cancelled");
    const r2 = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    const rj = await rejectPlayRefund(env, r2.ids[0], "adm", "not eligible");
    expect(rj.ok).toBe(true);
    expect(refundRow(r2.ids[0]).status).toBe("rejected");
    expect(lotRow(a).tokens_left_micro).toBe(T(100));
  });
});

describe("admin confirm", () => {
  it("whole unspent order goes through Google, then the tokens are removed exactly once", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    const id = r.ids[0];
    const calls: any[] = [];
    setPlayRefundPort({ refundOrderFor: async (_e: any, x: any) => { calls.push(x); return { ok: true }; } });
    const c = await confirmPlayRefund(env, id, "adm", { packageId: "com.x" });
    expect(c.ok).toBe(true);
    expect(calls).toEqual([{ orderId: "GPA.1", packageId: "com.x" }]);
    expect(refundRow(id).status).toBe("refunded");
    expect(refundRow(id).recorded_paise).toBe(8200);
    expect(lotRow(a).tokens_left_micro).toBe(0);
    expect(ledgerOps(playRefundOpId(id)).length).toBe(1);
    // a second confirm is a replay: no second Google call, no second revoke
    const c2 = await confirmPlayRefund(env, id, "adm", { packageId: "com.x" });
    expect(c2.ok && c2.replay).toBe(true);
    expect(calls.length).toBe(1);
    expect(ledgerOps(playRefundOpId(id)).length).toBe(1);
  });

  it("Google unreachable: the row goes back to a retryable state and nothing is removed", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    const c = await confirmPlayRefund(env, r.ids[0], "adm", { packageId: "com.x" }); // no port wired
    expect(c.ok).toBe(false);
    expect(["requested", "failed"]).toContain(refundRow(r.ids[0]).status);
    expect(lotRow(a).tokens_left_micro).toBe(T(100));
    setPlayRefundPort({ refundOrderFor: async () => ({ ok: true }) });
    expect((await confirmPlayRefund(env, r.ids[0], "adm", { packageId: "com.x" })).ok).toBe(true);
    expect(lotRow(a).tokens_left_micro).toBe(0);
  });

  it("Google says already refunded: counts as done", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    setPlayRefundPort({ refundOrderFor: async () => ({ ok: false, error: "already_refunded", alreadyRefunded: true }) });
    expect((await confirmPlayRefund(env, r.ids[0], "adm", { packageId: "com.x" })).ok).toBe(true);
    expect(refundRow(r.ids[0]).status).toBe("refunded");
  });

  it("partly spent: needs the amount the admin refunded in the Play Console; a lower amount needs a note", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 100);
    spend(a, 40); // 60% left -> Rs 60 owed
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    const id = r.ids[0];
    expect(refundRow(id).amount_paise).toBe(6000);
    setPlayRefundPort({ refundOrderFor: async () => { throw new Error("must not be called for a partial refund"); } });
    const none = await confirmPlayRefund(env, id, "adm", { packageId: "com.x" });
    expect(none.ok).toBe(false);
    expect(lotRow(a).tokens_left_micro).toBe(T(60));
    const less = await confirmPlayRefund(env, id, "adm", { packageId: "com.x", manual: true, recordedPaise: 5000 });
    expect(less.ok).toBe(false); // less than owed without a note
    const ok = await confirmPlayRefund(env, id, "adm", { packageId: "com.x", manual: true, recordedPaise: 6000 });
    expect(ok.ok).toBe(true);
    expect(refundRow(id).recorded_paise).toBe(6000);
    expect(refundRow(id).status).toBe("refunded");
    expect(lotRow(a).tokens_left_micro).toBe(0);
    // the spent part stays as spent; the removal is one ledger row of exactly the unused tokens
    const led = ledgerOps(playRefundOpId(id));
    expect(led.length).toBe(1);
    expect(Math.abs(led[0].delta_micro)).toBe(T(60));
  });

  it("tokens spent after the request: the amount changed, so it must be re-checked (409)", async () => {
    const a = await lot("u1", "purchase", 100, 82, "GPA.1", 100);
    const r = await requestPlayRefunds(env, "u1", { exit: false, windowDays: 180 });
    spend(a, 10);
    setPlayRefundPort({ refundOrderFor: async () => ({ ok: true }) });
    const c = await confirmPlayRefund(env, r.ids[0], "adm", { packageId: "com.x" });
    expect(c.ok).toBe(false);
    expect(c.status).toBe(409);
    expect(c.error).toBe("lot_changed");
    expect(lotRow(a).tokens_left_micro).toBe(T(90));
  });
});

describe("closing: test lots and debts", () => {
  it("test lots are removed and open debts written off, once, with a record", async () => {
    const t = await lot("u1", "test", 30, 100, "t1");
    raw().prepare("INSERT INTO hf_token_debts (id, uid, amount_micro, value_paise, source_order_id, status, created_at) VALUES ('d1','u1',?,820,'O','open',?)").run(T(10), Date.now());
    const f = await finishTokenExit(env, "u1");
    expect(f).toEqual({ testLots: 1, debts: 1 });
    expect(lotRow(t).tokens_left_micro).toBe(0);
    expect(raw().prepare("SELECT status FROM hf_token_debts WHERE id='d1'").get().status).toBe("written_off");
    expect(ledgerOps("hftwo:d1").length).toBe(1);
    const again = await finishTokenExit(env, "u1");
    expect(again).toEqual({ testLots: 0, debts: 0 });
    expect(ledgerOps("hftwo:d1").length).toBe(1);
    expect(await removeTestLots(env, "u1")).toBe(0);
    expect((await writeOffDebts(env, "u1")).count).toBe(0);
  });
});

describe("startExit with tokens", () => {
  it("a caller: one refund per purchase lot, test lot ignored in money; closing waits for the admin", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    await lot("u1", "purchase", 50, 82, "GPA.2", 41);
    await lot("u1", "test", 30, 100, "t1");
    const s = await exitSummary(env, "u1");
    expect(s.hasMoney).toBe(true);
    expect(s.refundable).toBeCloseTo(123, 5);
    const r = await startExit(env, "u1", { forfeit: false });
    expect(r.ok).toBe(true);
    const row = await getExitRow(env, "u1");
    expect(JSON.parse(row.refund_ids).length).toBe(2);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_refund_requests WHERE kind='play_refund' AND exit=1").get().n).toBe(2);
    // cancel puts everything back
    expect((await cancelExit(env, "u1")).ok).toBe(true);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_refund_requests WHERE status='requested'").get().n).toBe(0);
  });

  it("is refused while the user is on a call", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 82);
    raw().prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at) VALUES ('c1','h9','u1',2000,'ringing_host',?)").run(Date.now());
    const r = await startExit(env, "u1", { forfeit: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("active_call");
  });

  it("a host: earnings out of the INR ledger are paid first, after the 7-day hold, minimum waived", async () => {
    raw().prepare("INSERT INTO hf_hosts (uid, status, display_name, created_at, updated_at) VALUES ('h1','live','H',1,1)").run();
    raw().prepare("INSERT INTO hf_kyc (uid, verified_at, updated_at) VALUES ('h1', 1, 1)").run();
    raw().prepare("INSERT INTO hf_payout (uid, upi_enc, upi_verified, account_enc, account_last4, ifsc, name_at_bank_enc, name_match, updated_at) VALUES ('h1','u',1,'acc','1234','HDFC0001','nm',1,1)").run();
    const now = Date.now();
    await creditCallEarning(env, "h1", "cA", 7_550, "call_earning", now - 10 * DAY); // available (hold over): Rs 75.50
    await creditCallEarning(env, "h1", "cB", 2_000, "call_earning", now - 1 * DAY);  // still held: Rs 20
    const r = await startExit(env, "h1", { forfeit: false });
    expect(r.ok).toBe(true);
    const row = await getExitRow(env, "h1");
    expect(row.status).toBe("waiting_hold"); // the held part makes closing wait
    // move the hold into the past and run the cron
    raw().prepare("UPDATE hf_host_ledger SET available_at=? WHERE call_id='cB'").run(now - 1000);
    await runHfExitCron(env, { now: Date.now() }).catch(() => undefined);
    const p = raw().prepare("SELECT * FROM hf_payout_requests WHERE host_uid='h1' AND exit=1").all();
    expect(p.length).toBe(1);
    expect(p[0].amount_rupees).toBe(95); // 75.50 + 20.00 = 95.50, whole rupees
    expect(p[0].wallet_ref.startsWith("hfhl:")).toBe(true);
    const sum = await hostSummary(env, "h1");
    expect(sum.availablePaise).toBe(50); // the half rupee stays behind and is dropped at closure
  });
});
