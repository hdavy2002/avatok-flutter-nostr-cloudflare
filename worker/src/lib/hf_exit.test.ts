// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-EXIT-1] Pay-out-first account closure: gate decisions (pure) + start / cancel / cron on real SQL with a stateful fake WalletDO.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const wallet = { balance: 0, held: 0, resv: new Map<string, number>(), ops: new Map<string, any>() };
vi.mock("../routes/wallet", () => ({
  walletOp: async (_env: any, _uid: string, op: any) => {
    if (op.op === "release") return { status: 200, body: { released: 0, balance: wallet.balance, held: wallet.held } };
    if (op.op === "balance") return { status: 200, body: { balance: wallet.balance, held: wallet.held } };
    if (op.op_id && wallet.ops.has(op.op_id)) return wallet.ops.get(op.op_id);
    let out: any;
    if (op.op === "reserve") {
      const outstanding = [...wallet.resv.values()].reduce((a, b) => a + b, 0);
      out = wallet.balance < outstanding + op.amount ? { status: 402, body: { ok: false } } : (wallet.resv.set(op.ref, op.amount), { status: 200, body: { ok: true } });
    } else if (op.op === "release_reservation") { wallet.resv.delete(op.ref); out = { status: 200, body: { ok: true } }; }
    else out = { status: 400, body: {} };
    if (op.op_id) wallet.ops.set(op.op_id, out);
    return out;
  },
}));
vi.mock("../routes/config", () => ({ readConfig: async () => ({ hfExitGateEnabled: true, hfRefundsEnabled: false, hfRefundWindowDays: 180 }) }));
vi.mock("./pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? `dec(${v})` : null) }));
vi.mock("./hf_credits", () => ({ getTestBalance: async () => ({ balance: 40, reserved: 0 }) }));
vi.mock("./payments/registry", () => ({ resolveGateway: () => null }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));

import { decideDeletion, nextExitStep, exitSummary, startExit, cancelExit, runHfExitCron, exitFlagsFrom, getExitRow } from "./hf_exit";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const DAY = 86_400_000;
const NOW = Date.now();
const mig = (n: string) => readFileSync(new URL(`../../migrations/${n}`, import.meta.url), "utf8");

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, verified_at INTEGER);
    CREATE TABLE hf_payout (uid TEXT PRIMARY KEY, upi_enc TEXT, upi_verified INTEGER DEFAULT 0, account_enc TEXT, account_last4 TEXT, ifsc TEXT, name_at_bank_enc TEXT, name_match INTEGER DEFAULT 0);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, ended_at INTEGER, host_paid_rupees INTEGER);
    CREATE TABLE hf_host_test_earnings (id TEXT PRIMARY KEY, host_uid TEXT, rupees INTEGER);
  `);
  db.exec(mig("2026-10-09-hf-topups.sql")); db.exec(mig("2026-10-09-hf-payouts.sql")); db.exec(mig("2026-10-10-hf-wallet-exit.sql"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
    _run: () => db.prepare(q).run(...args),
  });
  return { db, env: { DB_META: { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { for (const s of l) s._run(); return []; } } } as any };
}

let h: ReturnType<typeof makeEnv>;
const trigger = vi.fn(async () => ({ scheduled: 1 }));
const bank = (uid: string) => h.db.exec(`INSERT INTO hf_hosts VALUES ('${uid}','live'); INSERT INTO hf_kyc VALUES ('${uid}', 1); INSERT INTO hf_payout VALUES ('${uid}','u','1','acc','1234','HDFC0001','nm',1);`);
const host = (uid: string) => h.db.exec(`INSERT INTO hf_hosts VALUES ('${uid}','live');`);
const call = (id: string, host_uid: string, ageDays: number, paid: number) => h.db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?)").run(id, "someone", host_uid, NOW - ageDays * DAY, paid);
const topup = (id: string, uid: string, rupees: number, ageDays: number) =>
  h.db.prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, gateway_order_id, status, credited, paid_at, created_at, updated_at, refunded_rupees) VALUES (?,?,?,?,?,'paid',1,?,?,?,0)")
    .run(id, uid, rupees, "razorpay", `o_${id}`, NOW - ageDays * DAY, NOW - ageDays * DAY, NOW - ageDays * DAY);

beforeEach(() => {
  h = makeEnv(); trigger.mockClear();
  wallet.balance = 0; wallet.held = 0; wallet.resv.clear(); wallet.ops.clear();
});

describe("decideDeletion (pure)", () => {
  const g = { gateEnabled: true, isHfUser: true, hasMoney: true, exitStatus: null };
  it("zero real money deletes as today", () => {
    expect(decideDeletion({ ...g, hasMoney: false })).toBe("delete");
    expect(decideDeletion({ ...g, isHfUser: false, hasMoney: true })).toBe("delete"); // legacy-platform wallet is not HF money
  });
  it("real money pauses deletion", () => expect(decideDeletion(g)).toBe("exit"));
  it("an exit already in progress keeps deletion paused even with an empty wallet", () => {
    for (const s of ["waiting_hold", "waiting_payouts", "ready"]) expect(decideDeletion({ ...g, hasMoney: false, exitStatus: s })).toBe("exit");
    expect(decideDeletion({ ...g, hasMoney: false, exitStatus: "done" })).toBe("delete");
    expect(decideDeletion({ ...g, hasMoney: false, exitStatus: "cancelled" })).toBe("delete");
  });
  it("gate off = old behaviour", () => expect(decideDeletion({ ...g, gateEnabled: false })).toBe("delete"));
  it("flags: gate defaults ON, refunds default OFF, window default 180", () => {
    expect(exitFlagsFrom({})).toEqual({ refundsEnabled: false, windowDays: 180, gateEnabled: true });
    expect(exitFlagsFrom({ hfExitGateEnabled: false, hfRefundsEnabled: true, hfRefundWindowDays: 90 })).toEqual({ refundsEnabled: true, windowDays: 90, gateEnabled: false });
  });
});

describe("nextExitStep (pure)", () => {
  const base = { status: "waiting_payouts", held: 0, hasPayout: false, payoutStatus: null, refundStatus: null };
  it("held earnings keep waiting; after the hold the exit payout is made", () => {
    expect(nextExitStep({ ...base, status: "waiting_hold", held: 50 })).toBe("wait_hold");
    expect(nextExitStep({ ...base, status: "waiting_hold", held: 0 })).toBe("make_payout");
  });
  it("open payout or refund keeps waiting; paid / refunded / rejected settle; cancelled never does", () => {
    expect(nextExitStep({ ...base, hasPayout: true, payoutStatus: "approved" })).toBe("wait_payouts");
    expect(nextExitStep({ ...base, hasPayout: true, payoutStatus: "paid", refundStatus: "processing" })).toBe("wait_payouts");
    expect(nextExitStep({ ...base, hasPayout: true, payoutStatus: "paid", refundStatus: "refunded" })).toBe("trigger_deletion");
    expect(nextExitStep({ ...base, hasPayout: true, payoutStatus: "rejected" })).toBe("trigger_deletion");
    expect(nextExitStep({ ...base, refundStatus: "rejected" })).toBe("trigger_deletion");
    expect(nextExitStep({ ...base, hasPayout: true, payoutStatus: "cancelled" })).toBe("wait_payouts");
    expect(nextExitStep({ ...base, status: "ready" })).toBe("trigger_deletion");
  });
});

describe("exitSummary", () => {
  it("a user with no HF footprint is never pulled in, whatever the wallet holds", async () => {
    wallet.balance = 900;
    const s = await exitSummary(h.env, "legacy");
    expect(s.isHfUser).toBe(false); expect(s.hasMoney).toBe(false);
  });
  it("an HF user with an empty wallet has no money; test credits are reported as dropped", async () => {
    topup("t1", "u1", 100, 3);
    const s = await exitSummary(h.env, "u1");
    expect(s.isHfUser).toBe(true); expect(s.hasMoney).toBe(false); expect(s.testCredits).toBe(40);
    expect((await startExit(h.env, "u1", { forfeit: false, trigger })).error).toBe("nothing_to_settle");
  });
  it("reports refundable, withdrawable, held and the release date", async () => {
    bank("h1"); topup("t1", "h1", 300, 5);
    call("c1", "h1", 20, 100); call("c2", "h1", 2, 80);
    wallet.balance = 400; wallet.held = 80; // 300 own top-up + 100 matured earnings, 80 held
    const s = await exitSummary(h.env, "h1");
    expect(s).toMatchObject({ hasMoney: true, paidBalance: 480, withdrawable: 100, held: 80, refundable: 300, manualRefund: 0, forfeitRupees: 0, bankOk: true });
    expect(Math.abs(s.heldReleaseAt - (NOW - 2 * DAY + 7 * DAY))).toBeLessThan(1000);
  });
});

describe("startExit / cron", () => {
  it("caller with unused top-up money: refund request, then deletion only after it is refunded", async () => {
    topup("t1", "c1", 300, 5); wallet.balance = 300;
    const r = await startExit(h.env, "c1", { forfeit: false, trigger });
    expect(r).toMatchObject({ ok: true, status: "waiting_payouts", payoutId: null });
    const refund = h.db.prepare("SELECT * FROM hf_refund_requests WHERE uid='c1'").get();
    expect(refund).toMatchObject({ amount_rupees: 300, exit: 1, status: "requested" });
    expect(await startExit(h.env, "c1", { forfeit: false, trigger })).toMatchObject({ ok: true, replay: true });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM hf_refund_requests").get().n).toBe(1);

    await runHfExitCron(h.env, trigger, NOW);
    expect(trigger).not.toHaveBeenCalled();
    h.db.prepare("UPDATE hf_refund_requests SET status='refunded'").run();
    expect(await runHfExitCron(h.env, trigger, NOW)).toMatchObject({ scanned: 1, done: 1 });
    expect(trigger).toHaveBeenCalledTimes(1); expect(trigger.mock.calls[0][1]).toBe("c1");
    expect((await getExitRow(h.env, "c1")).status).toBe("done");
    await runHfExitCron(h.env, trigger, NOW);
    expect(trigger).toHaveBeenCalledTimes(1); // never twice
  });

  it("host with held earnings: waits for the hold, then makes ONE exit payout that skips the minimum, then deletes after it is paid", async () => {
    bank("h1");
    call("c1", "h1", 20, 100); call("c2", "h1", 2, 80);
    wallet.balance = 100; wallet.held = 80;
    const r = await startExit(h.env, "h1", { forfeit: false, trigger });
    expect(r).toMatchObject({ ok: true, status: "waiting_hold", payoutId: null, refundId: null });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests").get().n).toBe(0);

    await runHfExitCron(h.env, trigger, NOW); // still held
    expect((await getExitRow(h.env, "h1")).status).toBe("waiting_hold");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests").get().n).toBe(0);

    // the hold ends: the 80 matures into the balance and the call is now 7+ days old
    wallet.held = 0; wallet.balance = 180;
    h.db.prepare("UPDATE hf_calls SET ended_at=? WHERE id='c2'").run(NOW - 8 * DAY);
    await runHfExitCron(h.env, trigger, NOW);
    const p = h.db.prepare("SELECT * FROM hf_payout_requests").get();
    expect(p).toMatchObject({ host_uid: "h1", amount_rupees: 180, exit: 1, status: "requested" }); // 180 < the Rs500 minimum
    expect(wallet.resv.get(`hfpayout:${p.id}`)).toBe(180);
    const row = await getExitRow(h.env, "h1");
    expect(row).toMatchObject({ status: "waiting_payouts", payout_id: p.id });
    expect(trigger).not.toHaveBeenCalled();

    h.db.prepare("UPDATE hf_payout_requests SET status='paid'").run();
    await runHfExitCron(h.env, trigger, NOW);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect((await getExitRow(h.env, "h1")).status).toBe("done");
  });

  it("an admin-rejected exit payout still lets the closure finish", async () => {
    bank("h1"); call("c1", "h1", 20, 150); wallet.balance = 150;
    expect(await startExit(h.env, "h1", { forfeit: false, trigger })).toMatchObject({ ok: true, status: "waiting_payouts" });
    h.db.prepare("UPDATE hf_payout_requests SET status='rejected', reject_reason='bank mismatch'").run();
    await runHfExitCron(h.env, trigger, NOW);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("a host without a verified bank must explicitly give the earnings up; then the closure goes straight through", async () => {
    host("h2"); call("c1", "h2", 20, 120); wallet.balance = 120;
    const a = await startExit(h.env, "h2", { forfeit: false, trigger });
    expect(a).toMatchObject({ ok: false, error: "forfeit_required", forfeitRupees: 120 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests").get().n).toBe(0);
    const b = await startExit(h.env, "h2", { forfeit: true, trigger });
    expect(b).toMatchObject({ ok: true, status: "ready" });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect((await getExitRow(h.env, "h2"))).toMatchObject({ status: "done", note: "forfeit:120" });
  });

  it("test credits alone never block: a host with only test earnings has nothing to settle", async () => {
    host("h3"); h.db.exec("INSERT INTO hf_host_test_earnings VALUES ('x','h3',500)");
    expect((await startExit(h.env, "h3", { forfeit: false, trigger })).error).toBe("nothing_to_settle");
  });

  it("cancel works while nothing is approved, releases the money, and is refused afterwards", async () => {
    topup("t1", "c1", 300, 5); wallet.balance = 300;
    await startExit(h.env, "c1", { forfeit: false, trigger });
    const id = h.db.prepare("SELECT id FROM hf_refund_requests").get().id;
    h.db.prepare("UPDATE hf_refund_requests SET status='processing'").run();
    expect(await cancelExit(h.env, "c1")).toMatchObject({ ok: false, error: "cannot_cancel" });
    h.db.prepare("UPDATE hf_refund_requests SET status='requested'").run();
    expect(await cancelExit(h.env, "c1")).toEqual({ ok: true });
    expect(wallet.resv.has(`hfrefund:${id}`)).toBe(false);
    expect((await getExitRow(h.env, "c1")).status).toBe("cancelled");
    await runHfExitCron(h.env, trigger, NOW);
    expect(trigger).not.toHaveBeenCalled();
    expect(await cancelExit(h.env, "c1")).toMatchObject({ ok: false, error: "no_exit" });
  });
});
