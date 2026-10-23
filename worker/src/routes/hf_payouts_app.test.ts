// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-10] Reels-app payouts adapter; same harness as hf_payouts.test.ts. Route-level: real SQL (in-memory SQLite behind a D1 shim) + a stateful fake WalletDO.
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
let cfgOn = true;
vi.mock("./config", () => ({ readConfig: async () => ({ hfPayoutsEnabled: cfgOn, hfPayoutMaxPerWeek: 2 }) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../lib/pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? (v.startsWith("enc:") ? v.slice(4) : `dec(${v})`) : null), encryptPii: async (_e: any, v: string) => `enc:${v}` }));
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
    CREATE TABLE hf_payout (uid TEXT PRIMARY KEY, upi_enc TEXT, upi_verified INTEGER DEFAULT 0, account_enc TEXT, account_last4 TEXT, ifsc TEXT, name_at_bank_enc TEXT, name_match INTEGER DEFAULT 0, updated_at INTEGER);
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
  h = makeEnv(); idem.clear(); currentUid = "host1"; cfgOn = true;
  wallet.balance = 0; wallet.held = 0; wallet.resv.clear(); wallet.ops.clear(); wallet.calls = [];
});


// Influencer from Channels: status 'approved', no bank, no KYC, maybe a UPI.
function seedInfluencer(opts: { kyc?: boolean; upi?: boolean; status?: string } = {}) {
  h.db.exec(`INSERT INTO hf_hosts VALUES ('host1','${opts.status ?? "approved"}','Asha','asha-abcd');`);
  if (opts.kyc) h.db.exec("INSERT INTO hf_kyc VALUES ('host1', 1)");
  if (opts.upi) h.db.exec("INSERT INTO hf_payout (uid, upi_enc) VALUES ('host1','enc:asha@okhdfc')");
}
const post = (amountPaise: unknown, key = "k1") => hit("POST", "/api/hf/payouts", { amountPaise }, key);

describe("PUT /api/hf/payouts/upi", () => {
  it("stores a valid VPA, validates format, leaves bank columns alone", async () => {
    seedInfluencer();
    expect((await jsonOf(await hit("PUT", "/api/hf/payouts/upi", { vpa: "nope" }))).error).toBe("invalid_upi");
    const r = await jsonOf(await hit("PUT", "/api/hf/payouts/upi", { vpa: " Asha@OkHDFC " }));
    expect(r).toMatchObject({ status: 200, ok: true, upi: { vpa: "asha@okhdfc", nameMatched: null } });
    expect(h.db.prepare("SELECT upi_enc, upi_verified FROM hf_payout WHERE uid='host1'").get()).toMatchObject({ upi_enc: "enc:asha@okhdfc", upi_verified: 0 });
  });
  it("changing the UPI clears the name check", async () => {
    seedInfluencer({ upi: true }); h.db.exec("UPDATE hf_payout SET upi_verified=1");
    await hit("PUT", "/api/hf/payouts/upi", { vpa: "new@ybl" });
    expect(h.db.prepare("SELECT upi_verified v FROM hf_payout").get().v).toBe(0);
  });
  it("[HF-WIRE-13] fans can save a UPI too", async () => {
    expect((await jsonOf(await hit("PUT", "/api/hf/payouts/upi", { vpa: "a1@ybl" }))).status).toBe(200);
  });
});

describe("GET /api/hf/payouts/summary", () => {
  it("kycStatus none / pending / verified, upi null when unset", async () => {
    seedInfluencer();
    let s = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(s).toMatchObject({ readyPaise: 0, onHoldPaise: 0, minPaise: 0, upi: null, kycStatus: "none", history: [] });
    h.db.exec("INSERT INTO hf_kyc VALUES ('host1', NULL)");
    expect((await jsonOf(await hit("GET", "/api/hf/payouts/summary"))).kycStatus).toBe("pending");
    h.db.exec("UPDATE hf_kyc SET verified_at=1");
    expect((await jsonOf(await hit("GET", "/api/hf/payouts/summary"))).kycStatus).toBe("verified");
  });
  it("ready and hold come from matured vs young calls, in paise", async () => {
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 2300; wallet.held = 300; call("old", 20, 2000); call("young", 2, 300);
    const s = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(s).toMatchObject({ readyPaise: 200000, onHoldPaise: 30000, upi: { vpa: "asha@okhdfc", nameMatched: null } });
  });
  it("history maps statuses: requested/approved -> checking, paid (with utr), rejected", async () => {
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 5000; call("old", 20, 5000);
    const a = await jsonOf(await post(50000, "a"));
    let s = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(s.history).toEqual([expect.objectContaining({ id: a.id, amountPaise: 50000, status: "checking" })]);
    currentUid = "admin1";
    await hit("POST", `/api/admin/hf/payouts/${a.id}/approve`);
    await hit("POST", `/api/admin/hf/payouts/${a.id}/paid`, { utr: "412345678901" });
    currentUid = "host1";
    s = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(s.history[0]).toMatchObject({ status: "paid", utr: "412345678901" });
    const b = await jsonOf(await post(50000, "b"));
    currentUid = "admin1"; await hit("POST", `/api/admin/hf/payouts/${b.id}/reject`, { reason: "UPI invalid" }); currentUid = "host1";
    s = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(s.history.map((x: any) => x.status).sort()).toEqual(["paid", "rejected"]);
  });
  it("[HF-WIRE-13] fans see the payout summary (nothing ready, no minimum); flag off is 404; own data only", async () => {
    const f = await jsonOf(await hit("GET", "/api/hf/payouts/summary"));
    expect(f).toMatchObject({ status: 200, readyPaise: 0, minPaise: 0, isInfluencer: false });
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 1000; call("old", 20, 1000);
    await post(50000);
    currentUid = "other"; h.db.exec("INSERT INTO hf_hosts VALUES ('other','approved','Ben','ben-abcd')");
    expect((await jsonOf(await hit("GET", "/api/hf/payouts/summary"))).history).toEqual([]);
    cfgOn = false;
    expect((await jsonOf(await hit("GET", "/api/hf/payouts/summary"))).status).toBe(404);
  });
});

describe("POST /api/hf/payouts", () => {
  it("needs an Idempotency-Key", async () => {
    seedInfluencer({ upi: true, kyc: true });
    expect((await jsonOf(await hit("POST", "/api/hf/payouts", { amountPaise: 60000 }))).status).toBe(400);
  });
  it("[HF-WIRE-13] a fan is no longer refused as 'influencers only': without a UPI it asks for one, and nothing is created", async () => {
    const r = await jsonOf(await post(60000));
    expect(r).toMatchObject({ status: 409, error: "upi_required" });
    expect(h.db.prepare("SELECT COUNT(*) n FROM hf_payout_requests").get().n).toBe(0);
  });
  it("flag off -> 404 not_enabled", async () => {
    seedInfluencer({ upi: true, kyc: true }); cfgOn = false;
    expect((await jsonOf(await post(60000))).error).toBe("not_enabled");
  });
  it("[HF-WIRE-18] no minimum (HF-REEL-38): any whole rupee above 0, and at most what is ready", async () => {
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 1500; call("old", 20, 1500);
    expect((await jsonOf(await post(50050, "a"))).error).toBe("invalid_amount"); // not whole rupees
    expect((await jsonOf(await post(0, "b0"))).error).toBe("invalid_amount"); // zero is never a withdrawal
    expect((await jsonOf(await post(100, "b"))).status).toBe(200); // Rs 1 is fine
    expect((await jsonOf(await post("abc", "c"))).error).toBe("invalid_amount");
    expect((await jsonOf(await post(150100, "d"))).error).toBe("insufficient_withdrawable");
    expect((await jsonOf(await post(150000, "e"))).error).toBe("insufficient_withdrawable"); // Rs 1 is already requested
  });
  it("needs a UPI (409 upi_required) before anything else is created", async () => {
    seedInfluencer({ kyc: true }); wallet.balance = 1000; call("old", 20, 1000);
    expect((await jsonOf(await post(60000))).error).toBe("upi_required");
    expect(wallet.resv.size).toBe(0);
  });
  it("first payout needs KYC: 409 kyc_required with a nextStep the app can open", async () => {
    seedInfluencer({ upi: true }); wallet.balance = 1000; call("old", 20, 1000);
    const r = await jsonOf(await post(60000));
    expect(r).toMatchObject({ status: 409, error: "kyc_required", message: "We check your ID once, before your first withdrawal." });
    expect(r.nextStep.type).toBe("kyc"); expect(r.nextStep.url).toMatch(/^https:\/\/.+\/verify\/id\?next=%2Fdashboard%2Fwallet$/);
    expect(h.db.prepare("SELECT COUNT(*) n FROM hf_payout_requests").get().n).toBe(0);
  });
  it("KYC is asked only at the first payout: once verified (or once paid) later requests do not ask again", async () => {
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 3000; call("old", 20, 3000);
    const a = await jsonOf(await post(50000, "a"));
    expect(a.status).toBe(200);
    currentUid = "admin1"; await hit("POST", `/api/admin/hf/payouts/${a.id}/approve`); await hit("POST", `/api/admin/hf/payouts/${a.id}/paid`, { utr: "412345678901" });
    currentUid = "host1";
    h.db.exec("DELETE FROM hf_kyc"); // even without a kyc row, a host who was already paid is not asked again
    expect((await jsonOf(await post(50000, "b"))).status).toBe(200);
  });
  it("creates a request in the admin queue with the UPI destination, reserves money, and replays by key", async () => {
    seedInfluencer({ upi: true, kyc: true }); wallet.balance = 1500; call("old", 20, 1500);
    const a = await jsonOf(await post(60000, "k1"));
    expect(a).toMatchObject({ status: 200, ok: true });
    expect(wallet.resv.get(`hfpayout:${a.id}`)).toBe(600);
    const again = await jsonOf(await post(60000, "k1"));
    expect(again.id).toBe(a.id);
    expect(h.db.prepare("SELECT COUNT(*) n FROM hf_payout_requests").get().n).toBe(1);
    currentUid = "admin1";
    const l = await jsonOf(await hit("GET", "/api/admin/hf/payouts?status=requested"));
    expect(l.items[0]).toMatchObject({ amount: 600, hostName: "Asha" });
    const d = await jsonOf(await hit("GET", `/api/admin/hf/payouts/${a.id}/destination`));
    expect(d).toMatchObject({ status: 200, upi: "asha@okhdfc" });
  });
});
