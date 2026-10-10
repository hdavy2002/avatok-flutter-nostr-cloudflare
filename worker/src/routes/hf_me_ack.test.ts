// @ts-nocheck -- test helper db is node:sqlite behind a D1 shim
// [HF-NATIVE-S4] POST /api/hf/me/ack against the REAL migration files (hf_user_ack + hf_age_confirm), GET /api/hf/me round trip, purge.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "../lib/hf_token_d1_shim";
import { purgeHfUser, hfPurgeTables } from "../lib/hf_purge";

let authFail: { status: number; error: string } | null = null;
let batchFail = false;
vi.mock("./config", () => ({ readConfig: async () => ({}) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));

import { hfMeRoute } from "./hf_me";

let db: any, env: any, kv: Map<string, string>;

beforeEach(() => {
  authFail = null; batchFail = false;
  db = makeDb(["2026-10-10-hf-auth-wa.sql", "2026-10-10-hf-user-ack.sql"]);
  // Tables GET /api/hf/me also reads (created by other migrations in production).
  db._raw.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, updated_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, status TEXT, verified_at INTEGER);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft');
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);
  kv = new Map();
  env = {
    DB_META: {
      prepare: db.prepare,
      batch: async (l: any[]) => { if (batchFail) throw new Error("d1 down"); return db.batch(l); },
    },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async () => {} },
  };
});

const post = (body: unknown, uid = "u1") =>
  new Request("https://x/api/hf/me/ack", { method: "POST", headers: { "content-type": "application/json", "x-test-uid": uid }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ack = (body: unknown, uid = "u1") => hfMeRoute(post(body, uid), env, "/api/hf/me/ack")!;
const getMe = (uid = "u1") => hfMeRoute(new Request("https://x/api/hf/me", { headers: { "x-test-uid": uid } }), env, "/api/hf/me")!;
const rows = (t: string) => db._raw.prepare(`SELECT * FROM ${t}`).all();

describe("POST /api/hf/me/ack", () => {
  it("stores the version and, with ack18, the 18+ confirmation; GET /api/hf/me then shows both", async () => {
    db._raw.exec("INSERT INTO users (uid) VALUES ('u1')");
    const r = await ack({ version: "2026-10-10", ack18: true });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, ackVersion: "2026-10-10" });
    expect(typeof b.age18ConfirmedAt).toBe("number");
    expect(rows("hf_user_ack")).toHaveLength(1);
    expect(rows("hf_age_confirm")).toMatchObject([{ uid: "u1", source: "app" }]);
    const me = await (await getMe()).json();
    expect(me).toMatchObject({ ackVersion: "2026-10-10", age18ConfirmedAt: b.age18ConfirmedAt });
  });

  it("ack18 false or missing stores only the version (no 18+ row)", async () => {
    expect((await ack({ version: "v1" })).status).toBe(200);
    expect((await ack({ version: "v2", ack18: false })).status).toBe(200);
    expect(rows("hf_user_ack")).toHaveLength(2);
    expect(rows("hf_age_confirm")).toHaveLength(0);
    expect((await (await ack({ version: "v3" })).json()).age18ConfirmedAt).toBeNull();
  });

  it("uses the client hint as the 18+ source when it is well formed", async () => {
    await ack({ version: "v1", ack18: true, client: "Android" });
    expect(rows("hf_age_confirm")[0].source).toBe("android");
  });

  it("is idempotent: the same version twice is one row; the first 18+ confirmation time wins", async () => {
    const first = await (await ack({ version: "v1", ack18: true })).json();
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await ack({ version: "v1", ack18: true })).json();
    expect(rows("hf_user_ack")).toHaveLength(1);
    expect(rows("hf_age_confirm")).toHaveLength(1);
    expect(second.age18ConfirmedAt).toBe(first.age18ConfirmedAt);
  });

  it("unifies with POST /api/hf/account/age-confirm: a row made there is kept, not overwritten", async () => {
    db._raw.exec("INSERT INTO hf_age_confirm VALUES ('u1', 111, 'web')");
    const b = await (await ack({ version: "v1", ack18: true })).json();
    expect(b.age18ConfirmedAt).toBe(111);
    expect(rows("hf_age_confirm")).toMatchObject([{ confirmed_at: 111, source: "web" }]);
  });

  it("a newer version becomes ackVersion", async () => {
    db._raw.exec("INSERT INTO users (uid) VALUES ('u1')");
    await ack({ version: "2026-10-01" });
    await new Promise((r) => setTimeout(r, 5));
    await ack({ version: "2026-11-01" });
    expect((await (await getMe()).json()).ackVersion).toBe("2026-11-01");
  });

  it.each([
    ["no version", {}], ["number version", { version: 1 }], ["empty version", { version: "" }], ["spaces", { version: "a b" }],
    ["too long", { version: "v".repeat(41) }], ["injection", { version: "x'; DROP TABLE hf_user_ack;--" }],
  ])("rejects %s with 400 invalid_field version", async (_l, body) => {
    const r = await ack(body);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_field", field: "version" });
    expect(rows("hf_user_ack")).toHaveLength(0);
  });

  it("rejects a non-boolean ack18 and a broken body, writing nothing", async () => {
    for (const v of ["yes", 1, null]) {
      const r = await ack({ version: "v1", ack18: v });
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ field: "ack18" });
    }
    expect((await ack("{nope")).status).toBe(400);
    expect(rows("hf_user_ack")).toHaveLength(0);
    expect(rows("hf_age_confirm")).toHaveLength(0);
  });

  it("not signed in is 401 and nothing is written; GET is 405", async () => {
    authFail = { status: 401, error: "unauthorized" };
    const r = await ack({ version: "v1", ack18: true });
    expect(r.status).toBe(401);
    expect(rows("hf_user_ack")).toHaveLength(0);
    authFail = null;
    expect((await hfMeRoute(new Request("https://x/api/hf/me/ack"), env, "/api/hf/me/ack"))!.status).toBe(405);
  });

  it("a database failure is a calm 503 and the batch leaves nothing half-written", async () => {
    batchFail = true;
    const r = await ack({ version: "v1", ack18: true });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "ack_failed" });
    expect(rows("hf_user_ack")).toHaveLength(0);
  });

  it("is rate limited (30 per hour)", async () => {
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await ack({ version: "v1" })).status;
    expect(last).toBe(429);
  });

  it("one user's ack never shows on another user", async () => {
    db._raw.exec("INSERT INTO users (uid) VALUES ('u1'), ('u2')");
    await ack({ version: "v1", ack18: true }, "u1");
    expect(await (await getMe("u2")).json()).toMatchObject({ ackVersion: null, age18ConfirmedAt: null });
  });
});

describe("purgeHfUser covers the new tables", () => {
  it("hf_user_ack and hf_age_confirm are in the full-account purge", () => {
    const t = hfPurgeTables("full").map((x) => x.table);
    expect(t).toEqual(expect.arrayContaining(["hf_user_ack", "hf_age_confirm"]));
    expect(hfPurgeTables("lane_caller").map((x) => x.table)).not.toContain("hf_user_ack");
  });
  it("deleting the account removes that user's ack and 18+ rows and nobody else's", async () => {
    await ack({ version: "v1", ack18: true }, "user_a1");
    await ack({ version: "v1", ack18: true }, "user_b2");
    const res = await purgeHfUser({ DB_META: env.DB_META } as any, "user_a1");
    expect(res.counts.hf_user_ack).toBe(1);
    expect(res.counts.hf_age_confirm).toBe(1);
    expect(rows("hf_user_ack")).toMatchObject([{ uid: "user_b2" }]);
    expect(rows("hf_age_confirm")).toMatchObject([{ uid: "user_b2" }]);
  });
});
