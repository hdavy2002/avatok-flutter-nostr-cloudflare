// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-LIMITS-1] Route level: receipt issued on top-up settle, owner-only receipt pages, reconciliation endpoint.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
vi.mock("./wallet", () => ({ walletOp: async () => ({ status: 200, body: { ok: true, balance: 100 } }) }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("./config", () => ({ readConfig: async () => cfg }));
let currentUid = "u1";
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: currentUid }), isFail: (u: any) => !!u?.error }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: unknown, uid: string) => uid === "admin" }));

import { hfWalletLimitsRoute } from "./hf_wallet_limits";
import { settleHfTopup } from "../lib/hf_topup";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, status TEXT, created_at INTEGER, ended_at INTEGER, billed_minutes INTEGER, paid_rupees INTEGER, test_rupees INTEGER, host_paid_rupees INTEGER, host_test_rupees INTEGER, limit_cap_rupees INTEGER);
           CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
           CREATE TABLE hf_payout_requests (id TEXT PRIMARY KEY, host_uid TEXT, amount_rupees INTEGER, status TEXT, utr TEXT, paid_at INTEGER);
           INSERT INTO users VALUES ('u1','Asha'),('u2','Ben');`);
  db.exec(readFileSync(new URL("../../migrations/2026-10-09-hf-topups.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/2026-10-10-hf-wallet-limits.sql", import.meta.url), "utf8").replace(/^ALTER TABLE.*$/m, ""));
  const stmt = (q: string, args: unknown[] = []) => ({
    q, args,
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  const batch = async (list: any[]) => { for (const s of list) db.prepare(s.q).run(...s.args); return []; };
  const wdb = new DatabaseSync(":memory:");
  wdb.exec(`CREATE TABLE wallet_transactions (id TEXT, uid TEXT, type TEXT, amount INTEGER, ref TEXT, created_at INTEGER); CREATE TABLE admin_audit (id TEXT, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER);`);
  const wstmt = (q: string, args: unknown[] = []) => ({ bind: (...a: unknown[]) => wstmt(q, a), run: async () => { wdb.prepare(q).run(...args); return { meta: { changes: 1 } }; }, all: async () => ({ results: wdb.prepare(q).all(...args) }), first: async () => wdb.prepare(q).get(...args) ?? null });
  return { db, wdb, env: { DB_META: { prepare: (q: string) => stmt(q), batch }, DB_WALLET: { prepare: (q: string) => wstmt(q) } } as any };
}
let h: ReturnType<typeof makeEnv>;
const hit = (method: string, path: string, body?: unknown) =>
  hfWalletLimitsRoute(new Request(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), h.env, path.split("?")[0]);

beforeEach(() => { h = makeEnv(); cfg = {}; currentUid = "u1"; });

const fakeAdapter = { fetchOrder: async () => ({ status: "paid", amount_paise: 50000 }) } as any;
const topupRow = (id = "hftop_aaaaaaaaaaaaaaaaaaaaaaaa") => ({ id, uid: "u1", amount_rupees: 500, gateway: "razorpay", gateway_order_id: "o1", status: "created", credited: 0, raw_status: null, created_at: 1, updated_at: 1, paid_at: null });

describe("receipt on top-up settle", () => {
  it("issues one receipt per settled top-up, even if settle is replayed; the owner can list and view it, others cannot", async () => {
    const row = topupRow();
    h.db.prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, gateway_order_id, status, credited, created_at, updated_at) VALUES (?,?,?,?,?,?,0,1,1)").run(row.id, row.uid, 500, "razorpay", "o1", "created");
    const ev = { status: "paid", amountPaise: 50000, currency: "INR", gatewayPaymentId: "pay_9", gatewayOrderId: "o1" };
    expect((await settleHfTopup(h.env, fakeAdapter, row, ev)).result).toBe("credited");
    await settleHfTopup(h.env, fakeAdapter, row, ev); // replay (row object is stale on purpose): same op, same receipt
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM hf_receipts").get().n).toBe(1);

    const list = await (await hit("GET", "/api/hf/wallet/receipts")).json();
    expect(list.invoicing).toBe(false);
    expect(list.receipts).toHaveLength(1);
    expect(list.receipts[0]).toMatchObject({ kind: "receipt", amountRupees: 500 });
    expect(list.receipts[0].number).toMatch(/^HF\/R\/\d{4}-\d{2}\/1$/);

    const page = await hit("GET", `/api/hf/wallet/receipts/${list.receipts[0].id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Payment receipt");
    expect(html).toContain("not a tax invoice");
    expect(html).toContain("Asha");

    currentUid = "u2";
    expect((await hit("GET", `/api/hf/wallet/receipts/${list.receipts[0].id}`)).status).toBe(404);
    expect((await (await hit("GET", "/api/hf/wallet/receipts")).json()).receipts).toHaveLength(0);
  });
});

describe("GET /api/admin/hf/reconciliation", () => {
  it("returns the report, flags a paid top-up with no wallet credit, and exports CSV", async () => {
    currentUid = "admin";
    const day = Date.parse("2026-10-09T18:30:00Z") + 3600_000; // 10 Oct 01:00 IST
    h.db.prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, status, credited, paid_at, created_at, updated_at) VALUES ('hftop_a','u1',500,'razorpay','paid',1,?,?,?)").run(day, day, day);
    h.db.prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, status, credited, paid_at, created_at, updated_at) VALUES ('hftop_b','u1',200,'cashfree','paid',1,?,?,?)").run(day, day, day);
    h.wdb.prepare("INSERT INTO wallet_transactions VALUES ('t1','u1','hf_topup',200,'hftop:hftop_b',?)").run(day + 1000);
    h.db.prepare("INSERT INTO hf_calls (id, caller_uid, status, created_at, ended_at, billed_minutes, paid_rupees, test_rupees, host_paid_rupees, host_test_rupees) VALUES ('c1','u1','completed',?,?,3,30,0,13,0)").run(day, day);
    h.db.prepare("INSERT INTO hf_payout_requests VALUES ('p1','h1',600,'paid','UTR999999',?)").run(day);

    const res = await hit("GET", "/api/admin/hf/reconciliation?from=2026-10-10&to=2026-10-10");
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.days).toHaveLength(1);
    expect(b.totals.topups).toMatchObject({ count: 2, rupees: 700 });
    expect(b.totals.walletCredits).toEqual({ count: 1, rupees: 200 });
    expect(b.totals.calls.paid).toBe(30);
    expect(b.totals.platformShare.paid).toBe(17);
    expect(b.totals.payouts).toEqual({ count: 1, rupees: 600 });
    expect(b.refundsAvailable).toBe(false); // no hf_refund_requests table here
    expect(b.mismatches.map((m: any) => [m.kind, m.topupId])).toEqual([["paid_without_credit", "hftop_a"]]);
    expect(b.liabilities.callerWalletsApprox).toBe(700 - 30);
    expect(b.liabilities.hostEarningsApprox).toBe(13 - 600);

    const csv = await hit("GET", "/api/admin/hf/reconciliation?from=2026-10-10&to=2026-10-10&format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("paid_without_credit,hftop_a");
  });
  it("rejects a bad range and non-admins", async () => {
    expect((await hit("GET", "/api/admin/hf/reconciliation")).status).toBe(403);
    currentUid = "admin";
    expect((await hit("GET", "/api/admin/hf/reconciliation?from=2026-13-01")).status).toBe(400);
  });
});
