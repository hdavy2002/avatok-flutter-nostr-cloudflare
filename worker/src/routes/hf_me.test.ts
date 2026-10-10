// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-NATIVE-S1] GET/PATCH /api/hf/me: shape, masking, auth failures, validation.
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

import { hfMeRoute, maskPhoneLast4, validateDisplayName } from "./hf_me";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, updated_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, status TEXT, verified_at INTEGER);
    CREATE TABLE hf_age_confirm (uid TEXT PRIMARY KEY, confirmed_at INTEGER NOT NULL, source TEXT NOT NULL);
    CREATE TABLE hf_user_ack (uid TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, version));
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft');
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);
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

const req = (method: string, body?: unknown, uid = "u1") =>
  new Request("https://x/api/hf/me", { method, headers: { "content-type": "application/json", "x-test-uid": uid }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = (r: Request) => hfMeRoute(r, env, "/api/hf/me");

beforeEach(() => { makeEnv(); cfg = {}; authFail = null; });

describe("GET /api/hf/me", () => {
  it("a brand-new caller: safe defaults, no host, nothing confirmed", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    const r = await call(req("GET"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      uid: "u1", displayName: null, phoneMasked: null, whatsappVerified: false, ackVersion: null, age18ConfirmedAt: null,
      isHost: false, host: null, lanes: { women: false, lgbtq: false }, closing: false, tokensMode: false,
    });
  });

  it("a fully set-up host: name, masked phone (last 4 only), ack, 18+, host, lanes, closing, token mode", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','Meena')").run();
    db.prepare("INSERT INTO contact_verification VALUES ('u1',1,'h1')").run();
    db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, status, verified_at) VALUES ('u1','h1','+919876543210','verified',5)").run();
    db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, status, verified_at) VALUES ('u1','h1','+919111111111','verified',2)").run(); // older, ignored
    db.prepare("INSERT INTO hf_age_confirm VALUES ('u1',1234,'android')").run();
    db.prepare("INSERT INTO hf_user_ack VALUES ('u1','2026-10-01',10)").run();
    db.prepare("INSERT INTO hf_user_ack VALUES ('u1','2026-10-10',20)").run();
    db.prepare("INSERT INTO hf_hosts (uid, slug, status) VALUES ('u1','meena','live')").run();
    db.prepare("INSERT INTO hf_kyc VALUES ('u1','F',99)").run();
    db.prepare("INSERT INTO hf_lane_access VALUES ('u1','women',99,NULL)").run();
    db.prepare("INSERT INTO hf_exit_requests VALUES ('u1','waiting_hold')").run();
    cfg = { hfTokensEnabled: true };
    const b = await (await call(req("GET"))).json();
    expect(b).toEqual({
      uid: "u1", displayName: "Meena", phoneMasked: "******3210", whatsappVerified: true, ackVersion: "2026-10-10", age18ConfirmedAt: 1234,
      isHost: true, host: { status: "live", slug: "meena" }, lanes: { women: true, lgbtq: false }, closing: true, tokensMode: true,
    });
    expect(JSON.stringify(b)).not.toContain("98765");
  });

  it("a draft host has host.status but a null slug; a missing hf_user_ack table does not break the answer", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','Ravi')").run();
    db.prepare("INSERT INTO hf_hosts (uid, status) VALUES ('u1','draft')").run();
    db.exec("DROP TABLE hf_user_ack");
    const b = await (await call(req("GET"))).json();
    expect(b).toMatchObject({ displayName: "Ravi", isHost: true, host: { status: "draft", slug: null }, ackVersion: null });
  });

  it("is private (no-store) and only answers for the signed-in user", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','A'), ('u2','Other')").run();
    const r = await call(req("GET", undefined, "u2"));
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect((await r.json()).uid).toBe("u2");
  });

  it("not signed in is 401; wrong method is 405; another path is not ours", async () => {
    authFail = { status: 401, error: "unauthorized" };
    const r = await call(req("GET"));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("unauthorized");
    authFail = null;
    expect((await call(req("DELETE"))).status).toBe(405);
    expect(await hfMeRoute(req("GET"), env, "/api/hf/meow")).toBeNull();
  });
});

describe("PATCH /api/hf/me", () => {
  it("saves a valid name (trimmed, spaces collapsed) and GET shows it", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    const r = await call(req("PATCH", { displayName: "  Meena   Kumari " }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, displayName: "Meena Kumari" });
    expect((await (await call(req("GET"))).json()).displayName).toBe("Meena Kumari");
  });

  it("accepts Devanagari and 2-char / 40-char names", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    for (const n of ["मीना", "Jo", "A".repeat(40)]) expect((await call(req("PATCH", { displayName: n }))).status).toBe(200);
  });

  it.each([
    ["too short", "A"], ["too long", "A".repeat(41)], ["empty", "   "], ["a number", "Meena 2"], ["devanagari digit", "मीना ४"],
    ["a phone number", "Call 98765 43210"], ["a handle", "meena@home"], ["a link", "meena.com"], ["markup", "<b>Meena</b>"], ["slash", "Me/ena"],
  ])("rejects %s with 400 invalid_field on displayName", async (_l, name) => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    const r = await call(req("PATCH", { displayName: name }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_field", field: "displayName" });
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBeNull();
  });

  it("rejects a missing / non-string name and a broken body", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    expect((await call(req("PATCH", {}))).status).toBe(400);
    expect((await call(req("PATCH", { displayName: 42 }))).status).toBe(400);
    const bad = new Request("https://x/api/hf/me", { method: "PATCH", headers: { "x-test-uid": "u1" }, body: "{nope" });
    expect((await call(bad)).status).toBe(400);
  });

  it("not signed in is 401 and nothing is written", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    authFail = { status: 401, error: "unauthorized" };
    expect((await call(req("PATCH", { displayName: "Meena" }))).status).toBe(401);
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBeNull();
  });

  it("no users row is 404 no_account", async () => {
    const r = await call(req("PATCH", { displayName: "Meena" }, "ghost"));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("no_account");
  });

  it("is rate limited (20 per hour)", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await call(req("PATCH", { displayName: "Meena" }))).status;
    expect(last).toBe(429);
  });
});

describe("helpers", () => {
  it("maskPhoneLast4 keeps four digits and nothing else", () => {
    expect(maskPhoneLast4("+919876543210")).toBe("******3210");
    expect(maskPhoneLast4("123")).toBeNull();
    expect(maskPhoneLast4(null)).toBeNull();
  });
  it("validateDisplayName returns the cleaned name", () => {
    expect(validateDisplayName(" Aarti  Sharma ")).toEqual({ ok: true, name: "Aarti Sharma" });
  });
});
