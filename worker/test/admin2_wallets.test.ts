// [AUMFE-WALLET-ADMIN-1] Admin 2 Wallets: list (GROUP BY over the wallet_transactions mirror),
// detail (live balance from the DO) and the admin adjust, through the real Admin 2 dispatcher
// against real SQLite (node:sqlite). Auth, telemetry and the WalletDO (walletOp) are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({
  uid: "admin1" as string | null,
  events: [] as Array<{ event: string; props: any }>,
  ops: [] as any[],
  live: { balance: 500, held: 0, free: 0, bonus: 0, spendable: 500 } as any,
  applied: new Set<string>(),
  doStatus: 200, balStatus: 200,
}));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  track: async (_env: unknown, _uid: string, event: string, _app: string, props: any) => { H.events.push({ event, props }); },
  trackUser: async () => {},
  trackException: async () => {},
}));
vi.mock("../src/lib/identity", () => ({ emailFor: async (_env: unknown, uid: string) => `${uid}@example.com` }));
vi.mock("../src/routes/wallet", () => ({
  walletOp: async (_env: unknown, _uid: string, op: any) => {
    H.ops.push(op);
    if (op.op === "balance") return H.balStatus !== 200 ? { status: H.balStatus, body: {} } : { status: 200, body: { ...H.live } };
    if (op.op === "op_result") return { status: 200, body: { found: H.applied.has(op.op_id) } };
    if (H.doStatus !== 200) return { status: H.doStatus, body: { error: "boom" } };
    if (H.applied.has(op.op_id)) return { status: 200, body: { ok: true, duplicate: true, ...H.live } };
    H.applied.add(op.op_id);
    const delta = op.op === "credit" ? op.amount : -op.amount;
    H.live = { ...H.live, balance: H.live.balance + delta, spendable: H.live.spendable + delta };
    return { status: 200, body: { ok: true, ...H.live } };
  },
}));

import { admin2Route } from "../src/routes/admin2";
import { buildWalletsQuery, parseWalletFilters, parseWalletSort, MAX_ADJUST_TOKENS } from "../src/routes/admin2_wallets";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
const mig = (f: string) => readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8");

function d1(db: any): any {
  return {
    prepare(sql: string) {
      let named = "", next = 1; const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1; while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) { const n = Number(sql.slice(i + 1, j)); named += `$p${n}`; used.add(n); next = Math.max(next, n + 1); i = j - 1; }
        else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      const w = {
        bind(...values: unknown[]) { params = {}; for (const n of used) params[`p${n}`] = values[n - 1] === undefined ? null : values[n - 1]; return w; },
        async run() { const r = db.prepare(named).run(params); return { meta: { changes: Number(r.changes ?? 0) } }; },
        async first<T = any>(): Promise<T | null> { return (db.prepare(named).get(params) as T | undefined) ?? null; },
        async all<T = any>(): Promise<{ results: T[] }> { return { results: db.prepare(named).all(params) as T[] }; },
      };
      return w;
    },
  };
}

const NOW = Date.UTC(2026, 9, 1, 6, 0, 0);
const H1 = 3_600_000;

async function setup() {
  const meta = new DatabaseSync(":memory:");
  meta.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, first_name TEXT, last_name TEXT, avatar_url TEXT,
      email_hash TEXT, phone_hash TEXT, private_number TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT,
      status TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER, verified_at INTEGER);
    INSERT INTO users (uid,display_name,first_name,last_name,private_number,created_at) VALUES
      ('alice','Alice Devi',NULL,NULL,NULL,${NOW - 900 * H1}),
      ('bob',NULL,'Bob','Kumar',NULL,${NOW - 800 * H1}),
      ('carol','Carol',NULL,NULL,NULL,${NOW - 700 * H1}),
      ('dave','Dave',NULL,NULL,NULL,${NOW - 600 * H1}),
      ('admin1','Owner',NULL,NULL,NULL,${NOW - 1000 * H1});
    INSERT INTO phone_otp (uid,phone_hash,e164,status,created_at,verified_at) VALUES ('alice','h','+919876543210','verified',${NOW},${NOW});
  `);
  const wallet = new DatabaseSync(":memory:");
  wallet.exec(mig("wallet.sql"));
  wallet.exec(mig("wallet_ledger.sql"));
  const tx = (id: string, uid: string, type: string, amount: number, after: number | null, at: number, extra: { app?: string; cat?: string } = {}) =>
    wallet.prepare("INSERT INTO wallet_transactions (id,uid,type,amount,balance_after,app_name,category,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, uid, type, amount, after, extra.app ?? null, extra.cat ?? null, at);
  // alice: topped up 1000, spent 400 of it on a voice call, balance 600
  tx("a1", "alice", "topup", 1000, 1000, NOW - 50 * H1);
  tx("a2", "alice", "spend", -400, 600, NOW - 10 * H1, { app: "avabrain_voice", cat: "agent" });
  // bob: topped up 200, spent 200 on a non-voice feature, balance 0
  tx("b1", "bob", "topup", 200, 200, NOW - 40 * H1);
  tx("b2", "bob", "spend", -200, 0, NOW - 20 * H1, { app: "shop", cat: "market" });
  // carol: only bonus spend (never topped up), balance 50
  tx("c1", "carol", "spend", -50, 50, NOW - 5 * H1, { app: "ava", cat: "ava" });
  // dave: an admin credit only
  tx("d1", "dave", "refund", 300, 300, NOW - 2 * H1, { app: "admin" });
  return { meta, wallet, env: { DB_META: d1(meta), DB_WALLET: d1(wallet), ADMIN_UIDS: "admin1" } as any };
}

const call = async (env: any, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = `https://api.test${path}`;
  const req = new Request(url, {
    method, headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await admin2Route(req, env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any };
  return { status: res.status, body: await res.json().catch(() => null) as any };
};

beforeEach(() => {
  H.uid = "admin1"; H.events = []; H.ops = []; H.applied = new Set(); H.doStatus = 200; H.balStatus = 200;
  H.live = { balance: 500, held: 0, free: 0, bonus: 0, spendable: 500 };
});

describe("parse helpers + query", () => {
  it("keeps only known filters and sorts", () => {
    expect(parseWalletFilters("has_balance, nope ,topped_up,has_balance")).toEqual(["has_balance", "topped_up"]);
    expect(parseWalletSort("balance")).toBe("balance");
    expect(parseWalletSort("junk")).toBe("last_activity");
  });
  it("binds the uid list instead of inlining it", () => {
    const q = buildWalletsQuery({ uids: ["x'; DROP TABLE y;--"], filter: "has_balance" });
    expect(q.sql).not.toContain("DROP");
    expect(q.binds).toEqual(["x'; DROP TABLE y;--"]);
  });
});

describe("GET /api/admin/v2/wallets", () => {
  it("is admin-only", async () => {
    const { env } = await setup();
    H.uid = "alice";
    expect((await call(env, "GET", "/api/admin/v2/wallets")).status).toBe(403);
    H.uid = null;
    expect((await call(env, "GET", "/api/admin/v2/wallets")).status).toBe(401);
  });

  it("lists every wallet with topped-up, spent, balance and last activity", async () => {
    const { env } = await setup();
    const r = await call(env, "GET", "/api/admin/v2/wallets?sort=balance");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.uid, i]));
    expect(by.alice).toMatchObject({ name: "Alice Devi", email: "alice@example.com", balance_tokens: 600, topped_up_tokens: 1000, spent_tokens: 400, spent_voice_tokens: 400 });
    expect(by.alice.phone_masked).toMatch(/^\+91 98/);
    expect(by.bob).toMatchObject({ name: "Bob Kumar", balance_tokens: 0, topped_up_tokens: 200, spent_tokens: 200, spent_voice_tokens: 0 });
    expect(by.dave).toMatchObject({ topped_up_tokens: 0, spent_tokens: 0, balance_tokens: 300 }); // admin credit is neither
    expect(r.body.items[0].uid).toBe("alice"); // balance desc
    expect(r.body.totals).toMatchObject({ wallets: 4, topped_up_tokens: 1200 });
  });

  it("filters: has_balance, zero_balance, topped_up, spent_voice", async () => {
    const { env } = await setup();
    const uids = async (q: string) => (await call(env, "GET", `/api/admin/v2/wallets?${q}`)).body.items.map((i: any) => i.uid).sort();
    expect(await uids("filter=has_balance")).toEqual(["alice", "carol", "dave"]);
    expect(await uids("filter=zero_balance")).toEqual(["bob"]);
    expect(await uids("filter=topped_up")).toEqual(["alice", "bob"]);
    expect(await uids("filter=spent_voice")).toEqual(["alice"]);
    expect(await uids("filter=topped_up,has_balance")).toEqual(["alice"]);
    expect(await uids(`from=${NOW - 6 * H1}`)).toEqual(["carol", "dave"]);
    expect(await uids(`to=${NOW - 15 * H1}`)).toEqual(["bob"]); // last activity at or before 15h ago
  });

  it("finds a user by name, by uid and by email-less partial name; sorts by name", async () => {
    const { env } = await setup();
    const uids = async (q: string) => (await call(env, "GET", `/api/admin/v2/wallets?${q}`)).body.items.map((i: any) => i.uid);
    expect(await uids("q=alice")).toEqual(["alice"]);
    expect(await uids("q=Kumar")).toEqual(["bob"]);
    expect(await uids("q=carol")).toEqual(["carol"]);
    expect(await uids("q=nobody-at-all")).toEqual([]);
    expect(await uids("sort=name")).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("rejects a bad cursor", async () => {
    const { env } = await setup();
    const bad = await call(env, "GET", "/api/admin/v2/wallets?cursor=garbage");
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/admin/v2/wallets/:uid", () => {
  it("returns the LIVE balance from the DO, the statement and a profile link", async () => {
    const { env } = await setup();
    H.live = { balance: 777, held: 10, free: 5, bonus: 0, spendable: 782 };
    const r = await call(env, "GET", "/api/admin/v2/wallets/alice");
    expect(r.status).toBe(200);
    expect(r.body.live).toMatchObject({ balance_tokens: 777, held_tokens: 10, spendable_tokens: 782 });
    expect(r.body.statement.map((s: any) => s.id)).toEqual(["a2", "a1"]);
    expect(r.body.profile).toMatchObject({ name: "Alice Devi", profile_url: "/admin/users?user=alice" });
    expect(H.ops[0]).toMatchObject({ op: "balance", uid: "alice" });
  });
  it("502s rather than showing a stale number when the DO is unreachable", async () => {
    const { env } = await setup();
    H.balStatus = 500;
    const r = await call(env, "GET", "/api/admin/v2/wallets/alice");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("wallet_unavailable");
  });
});

describe("POST /api/admin/v2/wallets/:uid/adjust", () => {
  const KEY = { "idempotency-key": "key-0000-0001" };

  it("adds money through ledger.adjust, audits it and emits admin_wallet_adjusted", async () => {
    const { env, wallet } = await setup();
    const r = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: 250, reason: "Gateway refund fix" }, KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, amount_tokens: 250, balance_tokens: 750 });
    const op = H.ops.find((o) => o.op === "credit");
    expect(op).toMatchObject({ uid: "alice", amount: 250, op_id: "admwal:alice:key-0000-0001", ledger: { debit: "platform:fees", credit: "user:alice", type: "adjustment" } });
    const a = wallet.prepare("SELECT * FROM admin_audit").all();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ admin_id: "admin1", action: "wallet_adjust", target: "alice" });
    expect(H.events.find((e) => e.event === "admin_wallet_adjusted")?.props).toMatchObject({ admin_uid: "admin1", uid: "alice", amount: 250, reason: "Gateway refund fix" });
  });

  it("a replay with the same key changes nothing and audits once", async () => {
    const { env, wallet } = await setup();
    await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: 100, reason: "first attempt" }, KEY);
    const again = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: 100, reason: "first attempt" }, KEY);
    expect(again.body.duplicate).toBe(true);
    expect(H.live.balance).toBe(600);
    expect(wallet.prepare("SELECT COUNT(*) AS n FROM admin_audit").get().n).toBe(1);
  });

  it("deducts, but refuses to go below zero", async () => {
    const { env } = await setup();
    const ok = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: -200, reason: "Duplicate credit" }, KEY);
    expect(ok.status).toBe(200);
    expect(ok.body.balance_tokens).toBe(300);
    const spend = H.ops.find((o) => o.op === "spend");
    expect(spend).toMatchObject({ amount: 200, ledger: { debit: "user:alice", credit: "platform:fees", type: "adjustment" } });
    const over = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: -301, reason: "Too much taken" }, { "idempotency-key": "key-0000-0002" });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("insufficient_balance");
    expect(H.live.balance).toBe(300);
  });

  it("validates key, amount, size, reason and the user", async () => {
    const { env } = await setup();
    const p = "/api/admin/v2/wallets/alice/adjust";
    expect((await call(env, "POST", p, { amount_tokens: 5, reason: "valid reason" })).body.error).toBe("idempotency_key_required");
    expect((await call(env, "POST", p, { amount_tokens: 0, reason: "valid reason" }, KEY)).body.error).toBe("invalid_amount");
    expect((await call(env, "POST", p, { amount_tokens: 1.5, reason: "valid reason" }, KEY)).body.error).toBe("invalid_amount");
    expect((await call(env, "POST", p, { amount_tokens: "abc", reason: "valid reason" }, KEY)).body.error).toBe("invalid_amount");
    expect((await call(env, "POST", p, { amount_tokens: MAX_ADJUST_TOKENS + 1, reason: "valid reason" }, KEY)).body.error).toBe("amount_too_large");
    expect((await call(env, "POST", p, { amount_tokens: -(MAX_ADJUST_TOKENS + 1), reason: "valid reason" }, KEY)).body.error).toBe("amount_too_large");
    expect((await call(env, "POST", p, { amount_tokens: 5, reason: "abcd" }, KEY)).body.error).toBe("reason_required");
    expect((await call(env, "POST", "/api/admin/v2/wallets/ghost/adjust", { amount_tokens: 5, reason: "valid reason" }, KEY)).status).toBe(404);
    expect(H.ops.filter((o) => o.op === "credit" || o.op === "spend")).toHaveLength(0);
  });

  it("is admin-only", async () => {
    const { env } = await setup();
    H.uid = "alice";
    const r = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: 5, reason: "valid reason" }, KEY);
    expect(r.status).toBe(403);
    expect(H.ops).toHaveLength(0);
  });

  it("reports a failed wallet op without claiming success", async () => {
    const { env } = await setup();
    H.doStatus = 500;
    const r = await call(env, "POST", "/api/admin/v2/wallets/alice/adjust", { amount_tokens: 5, reason: "valid reason" }, KEY);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("adjust_failed");
  });
});
