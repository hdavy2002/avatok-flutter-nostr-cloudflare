// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-PAYOUT-1] Route-level: real SQL (in-memory SQLite behind a D1 shim) + a stateful fake WalletDO.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const wallet = { balance: 0, held: 0, resv: new Map<string, number>(), ops: new Map<string, any>(), calls: [] as string[] };
vi.mock("./wallet", () => ({
  walletOp: async (_env: any, _uid: string, op: any) => {
    wallet.calls.push(op.op);
    if (op.op === "release") return { status: 200, body: { released: 0, balance: wallet.balance, held: wallet.held } };
    if (op.op === "balance") return { status: 200, body: { balance: wallet.balance, held: wallet.held } };
    if (op.op_id && wallet.ops.has(op.op_id)) return wallet.ops.get(op.op_id);
    let out: any;
    if (op.op === "reserve") {
      const outstanding = [...wallet.resv.values()].reduce((a, b) => a + b, 0);
      out = wallet.balance < outstanding + op.amount ? { status: 402, body: { ok: false, error: "insufficient balance" } }
        : (wallet.resv.set(op.ref, (wallet.resv.get(op.ref) ?? 0) + op.amount), { status: 200, body: { ok: true } });
    } else if (op.op === "consume_reserved") {
      const r = wallet.resv.get(op.ref);
      if (!r) out = { status: 404, body: { ok: false, error: "no_active_reservation", consumed: 0 } };
      else { const c = Math.min(r, op.amount); wallet.balance -= c; wallet.resv.delete(op.ref); out = { status: 200, body: { ok: true, consumed: c } }; }
    } else if (op.op === "release_reservation") { wallet.resv.delete(op.ref); out = { status: 200, body: { ok: true } }; }
    else out = { status: 400, body: {} };
    if (op.op_id) wallet.ops.set(op.op_id, out);
    return out;
  },
}));
let currentUid = "host1";
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: currentUid }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfPayoutsEnabled: true, hfPayoutMinRupees: 500, hfPayoutMaxPerWeek: 2 }) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../lib/pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? `dec(${v})` : null) }));
vi.mock("../money", () => ({
  rateLimit: async () => null,
  withIdempotency: async (req: Request, _e: any, uid: string, fn: () => Promise<Response>) => {
    const key = req.headers.get("idempotency-key");
    if (!key) return new Response(JSON.stringify({ error: "Idempotency-Key header required on money routes" }), { status: 400 });
    const k = `${uid}:${key}`;
    if (idem.has(k)) return idem.get(k)!.clone();
    const res = await fn();
    if (res.status < 500) idem.set(k, res.clone());
    return res;
  },
}));
const idem = new Map<string, Response>();

import { hfPayoutsRoute } from "./hf_payouts";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const DAY = 86_400_000;

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT, display_name TEXT, slug TEXT);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, verified_at INTEGER);
    CREATE TABLE hf_payout (uid TEXT PRIMARY KEY, upi_enc TEXT, upi_verified INTEGER DEFAULT 0, account_enc TEXT, account_last4 TEXT, ifsc TEXT, name_at_bank_enc TEXT, name_match INTEGER DEFAULT 0);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, host_uid TEXT, ended_at INTEGER, host_paid_rupees INTEGER, host_earned_tokens INTEGER);
    CREATE TABLE hf_host_test_earnings (id TEXT PRIMARY KEY, host_uid TEXT, call_id TEXT, rupees INTEGER, created_at INTEGER);
  `);
  db.exec(readFileSync(new URL("../../migrations/2026-10-09-hf-payouts.sql", import.meta.url), "utf8"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  const audits: any[] = [];
  const wdb = { prepare: (q: string) => ({ bind: (...a: unknown[]) => ({ run: async () => { audits.push(a); return { meta: { changes: 1 } }; } }) }) };
  return { db, audits, env: { DB_META: { prepare: (q: string) => stmt(q) }, DB_WALLET: wdb, TOKENS: {} } as any };
}

let h: ReturnType<typeof makeEnv>;
const NOW = Date.now();
function seedHost() {
  h.db.exec(`INSERT INTO hf_hosts VALUES ('host1','live','Asha','asha'); INSERT INTO hf_kyc VALUES ('host1', 1);
    INSERT INTO hf_payout VALUES ('host1','u','1','acc','1234','HDFC0001','nm',1);`);
}
function call(id: string, ageDays: number, paid: number | null) {
  h.db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?)").run(id, "host1", NOW - ageDays * DAY, paid, paid ?? 0);
}
const hit = async (method: string, path: string, body?: unknown, key?: string) =>
  hfPayoutsRoute(new Request(`https://x${path}`, { method, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), h.env, path.split("?")[0]);
const jsonOf = async (r: Response | null) => ({ ...(await r!.json()), status: r!.status });

beforeEach(() => {
  h = makeEnv(); idem.clear(); currentUid = "host1";
  wallet.balance = 0; wallet.held = 0; wallet.resv.clear(); wallet.ops.clear(); wallet.calls = [];
});

describe("POST /api/hosts/me/payouts", () => {
  it("needs an Idempotency-Key", async () => {
    seedHost();
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }))).status).toBe(400);
  });
  it("legacy NULL calls, young calls and test earnings give nothing to withdraw", async () => {
    seedHost(); wallet.balance = 5000;
    call("legacy", 30, null); call("young", 2, 900);
    h.db.prepare("INSERT INTO hf_host_test_earnings VALUES ('t','host1','c',800,?)").run(NOW - 30 * DAY);
    const r = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k1"));
    expect(r.status).toBe(402); expect(r.error).toBe("insufficient_withdrawable"); expect(r.withdrawable).toBe(0);
    const g = await jsonOf(await hit("GET", "/api/hosts/me/payouts"));
    expect(g.withdrawable).toBe(0); expect(g.testEarnings).toBe(800);
  });
  it("validation codes: below minimum, kyc, bank", async () => {
    seedHost(); wallet.balance = 2000; call("c1", 20, 2000);
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 499 }, "a"))).error).toBe("below_minimum");
    h.db.exec("DELETE FROM hf_kyc");
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "b"))).error).toBe("kyc_required");
    h.db.exec("INSERT INTO hf_kyc VALUES ('host1',1); UPDATE hf_payout SET name_match=0");
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "c"))).error).toBe("bank_required");
  });
  it("reserves, subtracts open requests from what is left, and replays by idempotency key", async () => {
    seedHost(); wallet.balance = 1500; call("c1", 20, 1500);
    const a = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k1"));
    expect(a.status).toBe(200); expect(wallet.resv.get(`hfpayout:${a.id}`)).toBe(600);
    const again = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k1"));
    expect(again.id).toBe(a.id);
    expect(h.db.prepare("SELECT COUNT(*) n FROM hf_payout_requests").get().n).toBe(1);
    const g = await jsonOf(await hit("GET", "/api/hosts/me/payouts"));
    expect(g.withdrawable).toBe(900);
    const over = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 901 }, "k2"));
    expect(over.error).toBe("insufficient_withdrawable");
    const snap = JSON.parse(h.db.prepare("SELECT bank_snapshot s FROM hf_payout_requests").get().s);
    expect(snap).toEqual({ accountLast4: "1234", ifsc: "HDFC0001", name: "dec(nm)" });
  });
  it("weekly limit", async () => {
    seedHost(); wallet.balance = 5000; call("c1", 20, 5000);
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "1"))).status).toBe(200);
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "2"))).status).toBe(200);
    expect((await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "3"))).error).toBe("weekly_limit");
  });
  it("wallet refusal cancels the row quietly (not shown to the host) and frees the pool", async () => {
    seedHost(); wallet.balance = 100; call("c1", 20, 5000); // calls say 5000 but the wallet only has 100
    const r = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k"));
    expect(r.status).toBe(402);
    const g = await jsonOf(await hit("GET", "/api/hosts/me/payouts"));
    expect(g.requests).toHaveLength(0); expect(g.withdrawable).toBe(100);
  });
});

describe("cancel", () => {
  it("releases the reservation; only while requested; idempotent", async () => {
    seedHost(); wallet.balance = 1000; call("c1", 20, 1000);
    const a = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k"));
    expect((await jsonOf(await hit("POST", `/api/hosts/me/payouts/${a.id}/cancel`))).status).toBe(200);
    expect(wallet.resv.size).toBe(0);
    expect((await jsonOf(await hit("POST", `/api/hosts/me/payouts/${a.id}/cancel`))).replay).toBe(true);
    const b = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k2"));
    currentUid = "admin1"; await hit("POST", `/api/admin/hf/payouts/${b.id}/approve`); currentUid = "host1";
    expect((await jsonOf(await hit("POST", `/api/hosts/me/payouts/${b.id}/cancel`))).error).toBe("not_cancellable");
  });
  it("another host cannot cancel it", async () => {
    seedHost(); wallet.balance = 1000; call("c1", 20, 1000);
    const a = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k"));
    currentUid = "someone";
    expect((await jsonOf(await hit("POST", `/api/hosts/me/payouts/${a.id}/cancel`))).status).toBe(404);
  });
});

describe("admin: approve / paid / reject", () => {
  async function open() {
    seedHost(); wallet.balance = 1000; call("c1", 20, 1000);
    const a = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k"));
    currentUid = "admin1";
    return a.id as string;
  }
  it("non-admin is refused", async () => {
    const id = await open(); currentUid = "host1";
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/approve`))).status).toBe(403);
  });
  it("paid needs approval, a valid UTR, and is idempotent", async () => {
    const id = await open();
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "412345678901" }))).error).toBe("invalid_state");
    await hit("POST", `/api/admin/hf/payouts/${id}/approve`);
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/approve`))).replay).toBe(true);
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "12" }))).error).toBe("invalid_utr");
    const p1 = await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "412345678901" }));
    expect(p1.status).toBe(200); expect(wallet.balance).toBe(400);
    const p2 = await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "412345678901" }));
    expect(p2.replay).toBe(true); expect(wallet.balance).toBe(400);
    expect(wallet.calls.filter((c) => c === "consume_reserved")).toHaveLength(1);
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "999999999999" }))).error).toBe("already_paid");
    const row = h.db.prepare("SELECT status, utr, admin_uid FROM hf_payout_requests").get();
    expect(row).toMatchObject({ status: "paid", utr: "412345678901", admin_uid: "admin1" });
    expect(h.audits.some((a) => a[2] === "hf_payout_paid")).toBe(true);
    // paid money no longer counts as withdrawable
    currentUid = "host1";
    expect((await jsonOf(await hit("GET", "/api/hosts/me/payouts"))).withdrawable).toBe(400);
  });
  it("a UTR cannot be reused on another payout", async () => {
    const id = await open();
    await hit("POST", `/api/admin/hf/payouts/${id}/approve`);
    await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "AAAAAA111111" });
    currentUid = "host1";
    const b = await jsonOf(await hit("POST", "/api/hosts/me/payouts", { amount: 500 }, "k9")); // only 400 left -> refused
    expect(b.status).toBe(402);
  });
  it("reject needs a reason, releases the money, is idempotent, and cannot follow paid", async () => {
    const id = await open();
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/reject`, { reason: "" }))).error).toBe("reason_required");
    const r1 = await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/reject`, { reason: "Name mismatch" }));
    expect(r1.status).toBe(200); expect(wallet.resv.size).toBe(0); expect(wallet.balance).toBe(1000);
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/reject`, { reason: "again" }))).replay).toBe(true);
    expect(wallet.calls.filter((c) => c === "release_reservation")).toHaveLength(1);
    expect((await jsonOf(await hit("POST", `/api/admin/hf/payouts/${id}/paid`, { utr: "412345678901" }))).error).toBe("invalid_state");
    currentUid = "host1";
    const g = await jsonOf(await hit("GET", "/api/hosts/me/payouts"));
    expect(g.requests[0]).toMatchObject({ status: "rejected", reason: "Name mismatch" });
    expect(g.withdrawable).toBe(1000);
  });
  it("destination shows the full account only while the bank still matches the snapshot, and is audited", async () => {
    const id = await open();
    const d = await jsonOf(await hit("GET", `/api/admin/hf/payouts/${id}/destination`));
    expect(d).toMatchObject({ account: "dec(acc)", ifsc: "HDFC0001", status: 200 });
    h.db.exec("UPDATE hf_payout SET account_last4='9999'");
    expect((await jsonOf(await hit("GET", `/api/admin/hf/payouts/${id}/destination`))).error).toBe("bank_changed");
    expect(h.audits.filter((a) => a[2] === "hf_payout_destination_viewed")).toHaveLength(2);
  });
  it("list returns open items with counts and hides masked-only fields correctly", async () => {
    await open();
    const l = await jsonOf(await hit("GET", "/api/admin/hf/payouts?status=requested"));
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ amount: 600, accountLast4: "1234", hostName: "Asha", withdrawableAtRequest: 1000 });
    expect(JSON.stringify(l)).not.toContain("dec(acc)");
    expect(l.counts.requested).toEqual({ n: 1, rupees: 600 });
  });
});
