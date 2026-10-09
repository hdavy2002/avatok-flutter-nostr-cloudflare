// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-EXIT-1] Refund allocation math (pure) + request lifecycle on real SQL with a stateful fake WalletDO and a fake gateway.
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
    } else if (op.op === "consume_reserved") {
      const r = wallet.resv.get(op.ref);
      if (!r) out = { status: 404, body: { ok: false, consumed: 0 } };
      else { const c = Math.min(r, op.amount); wallet.balance -= c; wallet.resv.delete(op.ref); out = { status: 200, body: { ok: true, consumed: c } }; }
    } else if (op.op === "release_reservation") { wallet.resv.delete(op.ref); out = { status: 200, body: { ok: true } }; }
    else out = { status: 400, body: {} };
    if (op.op_id) wallet.ops.set(op.op_id, out);
    return out;
  },
}));
const gw: any = { refund: vi.fn(), listRefunds: vi.fn(), configured: () => true, id: "razorpay" };
vi.mock("./payments/registry", () => ({ resolveGateway: () => gw }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));

import {
  allocateRefund, rawCallerMoney, topupRemaining, createRefundRequest, processRefund, markPaidManually, rejectRefund, cancelRefund,
  refundableFor, getRefund, parseAllocations, gatewayRefundOpId, markSliceSent,
} from "./hf_refunds";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const DAY = 86_400_000;
const NOW = Date.now();
const mig = (n: string) => readFileSync(new URL(`../../migrations/${n}`, import.meta.url), "utf8");

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, ended_at INTEGER, host_paid_rupees INTEGER);`);
  db.exec(mig("2026-10-09-hf-topups.sql")); db.exec(mig("2026-10-09-hf-payouts.sql")); db.exec(mig("2026-10-10-hf-wallet-exit.sql"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
    _run: () => db.prepare(q).run(...args),
  });
  const env = {
    DB_META: { prepare: (q: string) => stmt(q), batch: async (list: any[]) => { for (const s of list) s._run(); return []; } },
  } as any;
  return { db, env };
}

let h: ReturnType<typeof makeEnv>;
function topup(id: string, rupees: number, ageDays: number, refunded = 0, uid = "u1") {
  h.db.prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, gateway_order_id, status, credited, paid_at, created_at, updated_at, refunded_rupees) VALUES (?,?,?,?,?,'paid',1,?,?,?,?)")
    .run(id, uid, rupees, "razorpay", `order_${id}`, NOW - ageDays * DAY, NOW - ageDays * DAY, NOW - ageDays * DAY, refunded);
}

beforeEach(() => {
  h = makeEnv();
  wallet.balance = 0; wallet.held = 0; wallet.resv.clear(); wallet.ops.clear();
  gw.refund.mockReset(); gw.listRefunds = vi.fn(async () => ({ found: false, gateway_refund_id: null }));
  gw.refund.mockImplementation(async (_e: any, a: any) => ({ accepted: true, gateway_refund_id: `rfnd_${a.opId}` }));
});

describe("allocateRefund (pure)", () => {
  const t = (id: string, amt: number, ageDays: number, refunded = 0, pending = 0) => ({ id, amount_rupees: amt, refunded_rupees: refunded, paid_at: NOW - ageDays * DAY, pending });
  it("takes the NEWEST top-up first", () => {
    const r = allocateRefund([t("a", 200, 30), t("b", 300, 5), t("c", 100, 60)], 400, NOW, 180);
    expect(r.allocations).toEqual([{ topupId: "b", rupees: 300 }, { topupId: "a", rupees: 100 }]);
    expect(r.total).toBe(400);
    expect(r.eligibleTotal).toBe(600);
  });
  it("skips top-ups older than the window (exactly 180 days is still inside)", () => {
    const r = allocateRefund([t("old", 500, 181), t("edge", 100, 180), t("new", 50, 1)], 1000, NOW, 180);
    expect(r.allocations.map((a) => a.topupId)).toEqual(["new", "edge"]);
    expect(r.total).toBe(150);
  });
  it("no window (account closure) reaches old top-ups", () => {
    expect(allocateRefund([t("old", 500, 400)], 500, NOW, null).total).toBe(500);
  });
  it("subtracts what was already refunded and what other open requests already promised", () => {
    const r = allocateRefund([t("a", 300, 5, 100, 50), t("b", 200, 10, 200)], 1000, NOW, 180);
    expect(r.allocations).toEqual([{ topupId: "a", rupees: 150 }]);
    expect(topupRemaining(t("b", 200, 10, 200))).toBe(0);
  });
  it("never exceeds what is wanted, ignores junk and unpaid rows", () => {
    expect(allocateRefund([t("a", 300, 5)], 120, NOW, 180).total).toBe(120);
    expect(allocateRefund([t("a", 300, 5)], NaN, NOW, 180).total).toBe(0);
    expect(allocateRefund([{ id: "x", amount_rupees: 100, refunded_rupees: null, paid_at: null }], 100, NOW, 180).total).toBe(0);
  });
});

describe("rawCallerMoney (host earnings are never refundable)", () => {
  it("removes host earnings still in the wallet and open reservations", () => {
    expect(rawCallerMoney({ balance: 550, held: 0, totalHostPaid: 150, paidPayouts: 0, openRefundReserved: 0 })).toBe(400);
    expect(rawCallerMoney({ balance: 300, held: 100, totalHostPaid: 500, paidPayouts: 200, openRefundReserved: 0 })).toBe(100); // 400 - (500-200)
    expect(rawCallerMoney({ balance: 400, held: 0, totalHostPaid: 0, paidPayouts: 0, openRefundReserved: 150 })).toBe(250);
    expect(rawCallerMoney({ balance: 100, held: 0, totalHostPaid: 500, paidPayouts: 0, openRefundReserved: 0 })).toBe(-400);
  });
});

describe("refundableFor + createRefundRequest", () => {
  it("caps by the wallet, then allocates newest-first inside the window", async () => {
    topup("t1", 200, 10); topup("t2", 300, 5); topup("t3", 500, 200);
    wallet.balance = 400; // the old 500 and part of the rest were spent (FIFO)
    const r = await refundableFor(h.env, "u1", 180, NOW);
    expect(r.callerMoney).toBe(400);
    expect(r.refundable).toBe(400);
    expect(r.allocations).toEqual([{ topupId: "t2", rupees: 300 }, { topupId: "t1", rupees: 100 }]);
  });
  it("excludes the host's call earnings sitting in the wallet", async () => {
    topup("t1", 500, 3);
    wallet.balance = 650; // 500 own + 150 earned
    h.db.prepare("INSERT INTO hf_calls VALUES ('c1','x','u1',?,150)").run(NOW - 20 * DAY);
    expect((await refundableFor(h.env, "u1", 180, NOW)).refundable).toBe(500);
    wallet.balance = 200; // spent most of own money
    expect((await refundableFor(h.env, "u1", 180, NOW)).refundable).toBe(50);
  });
  it("creates a request, reserves the money, and a second request cannot take the same rupees", async () => {
    topup("t1", 300, 2); wallet.balance = 300;
    const a = await createRefundRequest(h.env, "u1", { exit: false, amount: 200, windowDays: 180 });
    expect(a.ok).toBe(true);
    expect(wallet.resv.get(`hfrefund:${a.id}`)).toBe(200);
    const b = await createRefundRequest(h.env, "u1", { exit: false, amount: 150, windowDays: 180 });
    expect(b.ok).toBe(false); expect(b.error).toBe("insufficient_refundable");
    const c = await createRefundRequest(h.env, "u1", { exit: false, amount: 100, windowDays: 180 });
    expect(c.ok).toBe(true);
  });
  it("rejects bad amounts and nothing-to-refund", async () => {
    topup("t1", 300, 2); wallet.balance = 300;
    expect((await createRefundRequest(h.env, "u1", { exit: false, amount: 0, windowDays: 180 })).error).toBe("invalid_amount");
    expect((await createRefundRequest(h.env, "u1", { exit: false, amount: 12.5, windowDays: 180 })).error).toBe("invalid_amount");
    expect((await createRefundRequest(h.env, "u2", { exit: false, windowDays: 180 })).error).toBe("nothing_refundable");
  });
  it("closure refund ignores the window and adds a manual-only slice for money no top-up can carry", async () => {
    topup("old", 100, 400); wallet.balance = 160;
    const r = await createRefundRequest(h.env, "u1", { exit: true, windowDays: 180 });
    expect(r.ok).toBe(true); expect(r.amount).toBe(160);
    const row = await getRefund(h.env, r.id);
    expect(row.exit).toBe(1);
    expect(parseAllocations(row.allocations)).toMatchObject([{ topupId: "old", rupees: 100 }, { topupId: null, rupees: 60, error: "manual_only" }]);
  });
});

describe("processRefund / manual / reject / cancel", () => {
  async function open(amount = 400) {
    topup("t1", 200, 10); topup("t2", 300, 5); wallet.balance = amount;
    const r = await createRefundRequest(h.env, "u1", { exit: false, amount, windowDays: 180 });
    expect(r.ok).toBe(true);
    return r.id as string;
  }
  it("approving twice sends exactly one gateway refund per allocation and debits the wallet once", async () => {
    const id = await open();
    const a = await processRefund(h.env, id, "admin1");
    expect(a).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).toHaveBeenCalledTimes(2);
    const calls = gw.refund.mock.calls.map((c: any) => [c[1].gatewayOrderId, c[1].amountPaise, c[1].opId]);
    expect(calls).toContainEqual(["order_t2", 30000, gatewayRefundOpId(id, "t2")]);
    expect(calls).toContainEqual(["order_t1", 10000, gatewayRefundOpId(id, "t1")]);
    const b = await processRefund(h.env, id, "admin1");
    expect(b).toMatchObject({ ok: true, status: "refunded", replay: true });
    expect(gw.refund).toHaveBeenCalledTimes(2);
    expect(wallet.balance).toBe(0);
    const t2 = h.db.prepare("SELECT refunded_rupees FROM hf_topups WHERE id='t2'").get();
    expect(Number(t2.refunded_rupees)).toBe(300);
    expect(Number(h.db.prepare("SELECT refunded_rupees FROM hf_topups WHERE id='t1'").get().refunded_rupees)).toBe(100);
  });
  it("a concurrent second approve while processing is refused", async () => {
    const id = await open();
    h.db.prepare("UPDATE hf_refund_requests SET status='processing' WHERE id=?").run(id);
    const r = await processRefund(h.env, id, "admin1");
    expect(r).toMatchObject({ ok: false, status: 409, error: "in_progress" });
    expect(gw.refund).not.toHaveBeenCalled();
  });
  it("partial gateway failure -> failed; retry only re-sends the failed slice; wallet untouched until all done", async () => {
    const id = await open();
    gw.refund.mockImplementationOnce(async (_e: any, a: any) => ({ accepted: true, gateway_refund_id: "ok1" }))
      .mockImplementationOnce(async () => ({ accepted: false, gateway_refund_id: null, error: "gateway_down" }));
    const a = await processRefund(h.env, id, "admin1");
    expect(a).toMatchObject({ ok: true, status: "failed" });
    expect(wallet.balance).toBe(400); expect(wallet.resv.has(`hfrefund:${id}`)).toBe(true);
    const allocs = parseAllocations((await getRefund(h.env, id)).allocations);
    expect(allocs.map((x) => x.status).sort()).toEqual(["failed", "refunded"]);
    gw.refund.mockClear();
    const b = await processRefund(h.env, id, "admin1");
    expect(b).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).toHaveBeenCalledTimes(1);
    expect(wallet.balance).toBe(0);
    // each top-up credited exactly once
    expect(Number(h.db.prepare("SELECT SUM(refunded_rupees) AS s FROM hf_topups").get().s)).toBe(400);
  });
  it("paid manually after a failure records the UTR, marks the open slices manual and consumes the reservation", async () => {
    const id = await open();
    gw.refund.mockImplementation(async () => ({ accepted: false, gateway_refund_id: null, error: "too_old" }));
    await processRefund(h.env, id, "admin1");
    expect((await markPaidManually(h.env, id, "admin1", "UTR123456")).status).toBe("refunded");
    const row = await getRefund(h.env, id);
    expect(row.utr).toBe("UTR123456");
    expect(parseAllocations(row.allocations).every((x) => x.status === "manual")).toBe(true);
    expect(wallet.balance).toBe(0);
    expect(await markPaidManually(h.env, id, "admin1", "UTR123456")).toMatchObject({ ok: true, replay: true });
    expect(await markPaidManually(h.env, id, "admin1", "OTHER99999")).toMatchObject({ ok: false, error: "already_refunded" });
  });
  it("reject releases the money; refused once part of the refund went out", async () => {
    const id = await open();
    expect(await rejectRefund(h.env, id, "admin1", "wrong account")).toMatchObject({ ok: true, status: "rejected" });
    expect(wallet.resv.has(`hfrefund:${id}`)).toBe(false);
    expect(wallet.balance).toBe(400);
    expect(await rejectRefund(h.env, id, "admin1", "wrong account")).toMatchObject({ ok: true, replay: true });
    // second request, partial failure, then reject is refused
    const id2 = (await createRefundRequest(h.env, "u1", { exit: false, amount: 400, windowDays: 180 })).id;
    gw.refund.mockImplementationOnce(async () => ({ accepted: true, gateway_refund_id: "ok" })).mockImplementationOnce(async () => ({ accepted: false, gateway_refund_id: null, error: "x" }));
    await processRefund(h.env, id2, "admin1");
    expect(await rejectRefund(h.env, id2, "admin1", "nope")).toMatchObject({ ok: false, error: "partly_refunded" });
  });
  it("the user can cancel only while requested, and not a closure refund", async () => {
    const id = await open();
    expect(await cancelRefund(h.env, id, "someone-else")).toMatchObject({ ok: false, status: 404 });
    expect(await cancelRefund(h.env, id, "u1")).toMatchObject({ ok: true, status: "cancelled" });
    expect(wallet.resv.has(`hfrefund:${id}`)).toBe(false);
    const ex = (await createRefundRequest(h.env, "u1", { exit: true, windowDays: 180 })).id;
    expect(await cancelRefund(h.env, ex, "u1")).toMatchObject({ ok: false, error: "exit_request" });
    expect(await cancelRefund(h.env, ex, "u1", true)).toMatchObject({ ok: true });
  });
  it("an unconfigured gateway fails the slice instead of throwing", async () => {
    const id = await open();
    gw.configured = () => false;
    try { expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "failed" }); }
    finally { gw.configured = () => true; }
    expect(gw.refund).not.toHaveBeenCalled();
  });
});

describe("double-refund safety (submitting / needs_check)", () => {
  async function open() {
    topup("t1", 300, 5); wallet.balance = 300;
    return (await createRefundRequest(h.env, "u1", { exit: false, amount: 300, windowDays: 180 })).id as string;
  }
  const setAlloc = (id: string, patch: any, status = "failed") => {
    const row = h.db.prepare("SELECT allocations FROM hf_refund_requests WHERE id=?").get(id);
    const al = JSON.parse(row.allocations); Object.assign(al[0], patch);
    h.db.prepare("UPDATE hf_refund_requests SET allocations=?, status=? WHERE id=?").run(JSON.stringify(al), status, id);
  };
  const alloc0 = async (id: string) => parseAllocations((await getRefund(h.env, id)).allocations)[0];

  it("the slice is written as 'submitting' BEFORE the gateway is called, and the gateway gets our slice id", async () => {
    const id = await open();
    let seen: any = null;
    gw.refund.mockImplementation(async (_e: any, a: any) => { seen = JSON.parse(h.db.prepare("SELECT allocations FROM hf_refund_requests WHERE id=?").get(id).allocations)[0]; return { accepted: true, gateway_refund_id: "r1" }; });
    await processRefund(h.env, id, "admin1");
    expect(seen.status).toBe("submitting"); expect(typeof seen.attemptAt).toBe("number");
    const opId = gw.refund.mock.calls[0][1].opId;
    expect(opId).toBe(gatewayRefundOpId(id, "t1"));
    expect(opId.length).toBeLessThanOrEqual(40); expect(opId).toMatch(/^[A-Za-z0-9_]+$/);
  });
  it("crash after gateway success: retry finds the existing refund and makes NO second call", async () => {
    const id = await open();
    setAlloc(id, { status: "submitting", attemptAt: NOW }, "processing"); // what a crashed run leaves behind
    h.db.prepare("UPDATE hf_refund_requests SET status='failed' WHERE id=?").run(id);
    gw.listRefunds.mockResolvedValue({ found: true, gateway_refund_id: "rfnd_existing" });
    const r = await processRefund(h.env, id, "admin1");
    expect(r).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).not.toHaveBeenCalled();
    expect(gw.listRefunds.mock.calls[0][1]).toMatchObject({ gatewayOrderId: "order_t1", opId: gatewayRefundOpId(id, "t1") });
    expect((await alloc0(id)).gatewayRefundId).toBe("rfnd_existing");
    expect(Number(h.db.prepare("SELECT refunded_rupees AS r FROM hf_topups WHERE id='t1'").get().r)).toBe(300);
    expect(wallet.balance).toBe(0);
  });
  it("gateway says no such refund exists: safe to send it", async () => {
    const id = await open();
    setAlloc(id, { status: "submitting", attemptAt: NOW });
    gw.refund.mockResolvedValue({ accepted: true, gateway_refund_id: "new1" });
    expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).toHaveBeenCalledTimes(1);
  });
  it("gateway cannot be asked -> needs_check, nothing sent, nothing debited; a plain retry still does not resend", async () => {
    const id = await open();
    setAlloc(id, { status: "submitting", attemptAt: NOW });
    gw.listRefunds.mockResolvedValue(null);
    expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "failed" });
    expect((await alloc0(id)).status).toBe("needs_check");
    expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "failed" });
    expect(gw.refund).not.toHaveBeenCalled();
    expect(wallet.balance).toBe(300);
  });
  it("an adapter without listRefunds also ends in needs_check", async () => {
    const id = await open();
    setAlloc(id, { status: "submitting", attemptAt: NOW });
    gw.listRefunds = undefined;
    await processRefund(h.env, id, "admin1");
    expect((await alloc0(id)).status).toBe("needs_check");
    expect(gw.refund).not.toHaveBeenCalled();
  });
  it("a timeout during the call leaves the slice needs_check (it may have gone through), not failed", async () => {
    const id = await open();
    gw.refund.mockResolvedValue({ accepted: false, gateway_refund_id: null, error: "gateway_unreachable" });
    expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "failed" });
    expect((await alloc0(id)).status).toBe("needs_check");
    gw.refund.mockReset(); gw.listRefunds.mockResolvedValue({ found: true, gateway_refund_id: "late1" });
    expect(await processRefund(h.env, id, "admin1")).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).not.toHaveBeenCalled();
  });
  it("admin can resubmit a needs_check slice explicitly (and only that one)", async () => {
    const id = await open();
    setAlloc(id, { status: "needs_check" });
    gw.listRefunds.mockResolvedValue(null);
    gw.refund.mockResolvedValue({ accepted: true, gateway_refund_id: "again1" });
    expect(await processRefund(h.env, id, "admin1", { resubmit: ["t1"] })).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).toHaveBeenCalledTimes(1);
  });
  it("admin 'mark sent' records the slice once and finishes the request", async () => {
    const id = await open();
    setAlloc(id, { status: "needs_check" });
    gw.listRefunds.mockResolvedValue(null);
    const r = await markSliceSent(h.env, id, "admin1", "t1", "rfnd_seen_in_dashboard");
    expect(r).toMatchObject({ ok: true, status: "refunded" });
    expect(gw.refund).not.toHaveBeenCalled();
    expect(Number(h.db.prepare("SELECT refunded_rupees AS r FROM hf_topups WHERE id='t1'").get().r)).toBe(300);
    expect(await markSliceSent(h.env, id, "admin1", "t1", null)).toMatchObject({ ok: true, replay: true });
    expect(Number(h.db.prepare("SELECT refunded_rupees AS r FROM hf_topups WHERE id='t1'").get().r)).toBe(300);
  });
  it("reject is refused while a slice is submitting / needs_check", async () => {
    const id = await open();
    setAlloc(id, { status: "needs_check" });
    expect(await rejectRefund(h.env, id, "admin1", "no way")).toMatchObject({ ok: false, error: "partly_refunded" });
  });
});
