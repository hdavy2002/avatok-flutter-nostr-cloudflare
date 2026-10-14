// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-DASH-FRAANDS-1] saved hosts: flag, auth, idempotency, rules, lane visibility, limit.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));
vi.mock("./hf_hosts_public", () => ({
  SEL: "SELECT h.* FROM hf_hosts h",
  card: (_env: any, r: any) => ({ slug: r.slug, displayName: r.display_name, tagline: r.tagline, avatarUrl: r.photo ?? null, status: r.presence === "online" || r.presence === "busy" ? r.presence : "offline" }),
}));

import { hfFavouritesRoute, MAX_FAVOURITES } from "./hf_favourites";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, tagline TEXT, photo TEXT, presence TEXT,
      women_lane INTEGER DEFAULT 0, lgbtq_lane INTEGER DEFAULT 0, lgbtq_public INTEGER DEFAULT 0);
    CREATE TABLE hf_favourites (uid TEXT NOT NULL, host_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (uid, host_uid));
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
  `);
  db.exec(`INSERT INTO hf_hosts (uid,slug,status,display_name,tagline,presence) VALUES
    ('h1','maya-one','live','Maya','Calm listener','online'),
    ('h2','ravi-two','live','Ravi',NULL,'busy'),
    ('h3','draft-three','draft','Draft',NULL,'offline'),
    ('u1','self-host','live','Me',NULL,'offline')`);
  db.exec(`INSERT INTO hf_hosts (uid,slug,status,display_name,presence,women_lane) VALUES ('h4','women-four','live','Women Host','online',1)`);
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
  };
}

const call = (method: string, path = "/api/hf/favourites", uid = "u1") =>
  hfFavouritesRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid } }), env, path);
const rows = (uid = "u1") => db.prepare("SELECT host_uid FROM hf_favourites WHERE uid=?").all(uid).map((r: any) => r.host_uid);

beforeEach(() => { makeEnv(); cfg = { hfFavouritesEnabled: true }; authFail = null; });

describe("hf favourites", () => {
  it("is 404 not_enabled when the flag is off (before auth)", async () => {
    cfg = {};
    authFail = { status: 401, error: "auth" };
    for (const [m, p] of [["GET", "/api/hf/favourites"], ["PUT", "/api/hf/favourites/maya-one"], ["DELETE", "/api/hf/favourites/maya-one"]]) {
      const r = await call(m, p);
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe("not_enabled");
    }
  });

  it("is 401 when signed out", async () => {
    authFail = { status: 401, error: "auth: missing" };
    expect((await call("GET")).status).toBe(401);
    expect((await call("PUT", "/api/hf/favourites/maya-one")).status).toBe(401);
  });

  it("ignores other paths and rejects other methods", async () => {
    expect(await call("GET", "/api/hf/other")).toBeNull();
    expect((await call("POST")).status).toBe(405);
  });

  it("save and unsave are idempotent", async () => {
    let r = await call("PUT", "/api/hf/favourites/maya-one");
    expect(await r.json()).toEqual({ ok: true, saved: true, count: 1 });
    r = await call("PUT", "/api/hf/favourites/maya-one");
    expect(await r.json()).toEqual({ ok: true, saved: true, count: 1 });
    expect(await (await call("GET", "/api/hf/favourites/maya-one")).json()).toEqual({ ok: true, saved: true });
    r = await call("DELETE", "/api/hf/favourites/maya-one");
    expect(await r.json()).toEqual({ ok: true, saved: false, count: 0 });
    r = await call("DELETE", "/api/hf/favourites/maya-one");
    expect(await r.json()).toEqual({ ok: true, saved: false, count: 0 });
    expect(await (await call("GET", "/api/hf/favourites/maya-one")).json()).toEqual({ ok: true, saved: false });
  });

  it("cannot save yourself (400)", async () => {
    const r = await call("PUT", "/api/hf/favourites/self-host");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("cannot_save_self");
    expect(rows()).toEqual([]);
  });

  it("only live hosts can be saved (404)", async () => {
    expect((await call("PUT", "/api/hf/favourites/draft-three")).status).toBe(404);
    expect((await call("PUT", "/api/hf/favourites/nobody-here")).status).toBe(404);
    expect(rows()).toEqual([]);
  });

  it("a women-lane host is hidden from a caller without lane access", async () => {
    expect((await call("PUT", "/api/hf/favourites/women-four")).status).toBe(404);
    db.exec("INSERT INTO hf_favourites VALUES ('u1','h4',5)"); // saved earlier, access since lost
    const list = await (await call("GET")).json();
    expect(list.items).toEqual([]);
  });

  it("closing accounts cannot write but can read", async () => {
    db.exec("INSERT INTO hf_exit_requests VALUES ('u1','waiting_payouts')");
    const r = await call("PUT", "/api/hf/favourites/maya-one");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("account_closing");
    expect((await call("GET")).status).toBe(200);
  });

  it("list returns only my rows, only live hosts, newest first, no uid", async () => {
    db.exec(`INSERT INTO hf_favourites VALUES ('u1','h1',100),('u1','h2',200),('u1','h3',300),('u2','h1',50),('u2','h2',60)`);
    const r = await call("GET");
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.items.map((i: any) => i.slug)).toEqual(["ravi-two", "maya-one"]);
    expect(body.items[0]).toEqual({ slug: "ravi-two", displayName: "Ravi", photoUrl: null, headline: null, presence: "busy", savedAt: 200 });
    expect(body.items[1].headline).toBe("Calm listener");
    expect(JSON.stringify(body)).not.toMatch(/"h1"|"h2"|"u1"|uid/);
    const other = await (await call("GET", "/api/hf/favourites", "u2")).json();
    expect(other.items).toHaveLength(2);
    expect((await (await call("GET", "/api/hf/favourites", "u3")).json()).items).toEqual([]);
  });

  it("refuses the 501st save with 409 limit_reached, but re-saving an existing host still works", async () => {
    const ins = db.prepare("INSERT INTO hf_favourites VALUES ('u1', ?, 1)");
    for (let i = 0; i < MAX_FAVOURITES; i++) ins.run(i === 0 ? "h1" : `gone${i}`);
    const r = await call("PUT", "/api/hf/favourites/ravi-two");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("limit_reached");
    expect((await call("PUT", "/api/hf/favourites/maya-one")).status).toBe(200);
  });
});
