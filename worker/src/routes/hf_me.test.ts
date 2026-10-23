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

let emails: Record<string, string | null> = {};
let walletBody: { status: number; body: any } = { status: 200, body: { balance: 0 } };
let tokenAvail = 0;
vi.mock("../lib/identity", () => ({ emailFor: async (_e: any, uid: string) => emails[uid] ?? null }));
vi.mock("./wallet", () => ({ walletOp: async () => walletBody }));
vi.mock("../lib/hf_token_ledger", () => ({ balanceSummary: async () => ({ availablePaise: tokenAvail }) }));

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
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE);
    CREATE TABLE hf_phone_signup (uid TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE hf_registration_progress (uid TEXT PRIMARY KEY);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', presence TEXT NOT NULL DEFAULT 'offline');
    CREATE TABLE hf_user_prefs (uid TEXT PRIMARY KEY, notify_whatsapp INTEGER NOT NULL DEFAULT 1, appt_reminders INTEGER NOT NULL DEFAULT 1, reel_alerts INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
    CREATE TABLE hf_user_email (uid TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at INTEGER NOT NULL);
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

beforeEach(() => { makeEnv(); cfg = {}; authFail = null; emails = {}; walletBody = { status: 200, body: { balance: 0 } }; tokenAvail = 0; });

describe("GET /api/hf/me", () => {
  it('marks unfinished phone signups for completion on any device', async () => {
    db.prepare("INSERT INTO hf_phone_signup VALUES ('u1','done')").run();
    expect(await (await call(req('GET'))).json()).toMatchObject({ registrationRequired: true, registrationComplete: false });
    expect(await (await call(req('GET', undefined, 'u2'))).json()).toMatchObject({ registrationRequired: false });
    db.prepare("INSERT INTO hf_user_registration VALUES ('u1','maya')").run();
    expect(await (await call(req('GET'))).json()).toMatchObject({ registrationRequired: false, registrationComplete: true });
  });
  it("[HF-APP-PARITY-PROFILE] returns first/last name; registration row wins over users", async () => {
    db.exec("ALTER TABLE users ADD COLUMN first_name TEXT; ALTER TABLE users ADD COLUMN last_name TEXT; ALTER TABLE hf_user_registration ADD COLUMN first_name TEXT; ALTER TABLE hf_user_registration ADD COLUMN last_name TEXT;");
    db.prepare("INSERT INTO users (uid, display_name, first_name, last_name) VALUES ('u1','Asha','Asha','Rao')").run();
    expect(await (await call(req("GET"))).json()).toMatchObject({ firstName: "Asha", lastName: "Rao" });
    db.prepare("INSERT INTO hf_user_registration (uid, username, first_name, last_name) VALUES ('u1','asha','Ashaa','Rao2')").run();
    expect(await (await call(req("GET"))).json()).toMatchObject({ firstName: "Ashaa", lastName: "Rao2", username: "asha" });
  });
  it("a brand-new caller: safe defaults, no host, nothing confirmed", async () => {
    db.prepare("INSERT INTO users (uid) VALUES ('u1')").run();
    const r = await call(req("GET"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      uid: "u1", displayName: null, username: null, firstName: null, lastName: null, registrationComplete: false, registrationRequired: false, phoneMasked: null, whatsappVerified: false, ackVersion: null, age18ConfirmedAt: null,
      isHost: false, host: null, lanes: { women: false, lgbtq: false }, closing: false, tokensMode: false,
      name: null, email: null, whatsapp: null, role: "fan", hostStatus: null, presence: null, walletPaise: 0,
      prefs: { notifyWhatsapp: true, apptReminders: true, reelAlerts: true },
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
    db.prepare("INSERT INTO hf_user_registration VALUES ('u1','meena')").run();
    db.prepare("INSERT INTO hf_hosts (uid, slug, status) VALUES ('u1','meena','live')").run();
    db.prepare("INSERT INTO hf_kyc VALUES ('u1','F',99)").run();
    db.prepare("INSERT INTO hf_lane_access VALUES ('u1','women',99,NULL)").run();
    db.prepare("INSERT INTO hf_exit_requests VALUES ('u1','waiting_hold')").run();
    cfg = { hfTokensEnabled: true };
    emails = { u1: "meena@example.com" };
    tokenAvail = 4250;
    db.prepare("UPDATE hf_hosts SET presence='online' WHERE uid='u1'").run();
    db.prepare("INSERT INTO hf_user_prefs (uid, notify_whatsapp, appt_reminders, updated_at) VALUES ('u1',0,1,5)").run();
    const b = await (await call(req("GET"))).json();
    expect(b).toEqual({
      uid: "u1", displayName: "Meena", username: "meena", firstName: null, lastName: null, registrationComplete: true, registrationRequired: false, phoneMasked: "******3210", whatsappVerified: true, ackVersion: "2026-10-10", age18ConfirmedAt: 1234,
      isHost: true, host: { status: "live", slug: "meena" }, lanes: { women: true, lgbtq: false }, closing: true, tokensMode: true,
      name: "Meena", email: "meena@example.com", whatsapp: "******3210", role: "host", hostStatus: "live", presence: "online", walletPaise: 4250,
      prefs: { notifyWhatsapp: false, apptReminders: true, reelAlerts: true },
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

describe("GET /api/hf/me reels-app fields [HF-WIRE-1B]", () => {
  it("old (rupee) wallet mode: walletPaise = rupees x 100; a failing wallet read is null, never a 500", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','A')").run();
    walletBody = { status: 200, body: { balance: 423 } };
    expect((await (await call(req("GET"))).json()).walletPaise).toBe(42300);
    walletBody = { status: 502, body: {} };
    const r = await call(req("GET"));
    expect(r.status).toBe(200);
    expect((await r.json()).walletPaise).toBeNull();
  });
  it("a draft host is still role fan, with hostStatus draft and presence offline", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','A')").run();
    db.prepare("INSERT INTO hf_hosts (uid, status) VALUES ('u1','draft')").run();
    expect(await (await call(req("GET"))).json()).toMatchObject({ role: "fan", hostStatus: "draft", presence: "offline" });
  });
  it("never returns another user's data (email, wallet, prefs, host, phone)", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','Mine'), ('u2','Other')").run();
    db.prepare("INSERT INTO contact_verification VALUES ('u2',1,'h2')").run();
    db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, status, verified_at) VALUES ('u2','h2','+919000011111','verified',5)").run();
    db.prepare("INSERT INTO hf_hosts (uid, slug, status, presence) VALUES ('u2','other','live','online')").run();
    db.prepare("INSERT INTO hf_user_prefs (uid, notify_whatsapp, appt_reminders, updated_at) VALUES ('u2',0,0,5)").run();
    emails = { u1: "mine@example.com", u2: "other@example.com" };
    const text = JSON.stringify(await (await call(req("GET"))).json());
    const b = JSON.parse(text);
    expect(b).toMatchObject({ uid: "u1", name: "Mine", email: "mine@example.com", whatsapp: null, role: "fan", hostStatus: null, presence: null, prefs: { notifyWhatsapp: true, apptReminders: true, reelAlerts: true } });
    for (const leak of ["other@example.com", "Other", "u2", "11111", "other\""]) expect(text).not.toContain(leak);
  });
  it("signed out is 401 with no body fields leaked", async () => {
    authFail = { status: 401, error: "unauthorized" };
    const r = await call(req("GET"));
    expect(r.status).toBe(401);
    expect(Object.keys(await r.json()).sort()).toEqual(["error", "message"]);
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

describe("PATCH /api/hf/me email [HF-WIRE-2]", () => {
  beforeEach(() => { db.prepare("INSERT INTO users (uid) VALUES ('u1'), ('u2')").run(); });
  it("flag off: email is 403 feature_off and nothing is stored; the name still works", async () => {
    const r = await call(req("PATCH", { email: "a@b.com" }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("feature_off");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_user_email").get().n).toBe(0);
    expect((await call(req("PATCH", { displayName: "Meena" }))).status).toBe(200);
  });
  it("flag on: stores a trimmed lower-case email, name and email together, GET returns it for me only", async () => {
    cfg = { hfFanSignupEnabled: true };
    const r = await call(req("PATCH", { displayName: "Meena", email: "  Meena@Example.COM " }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, displayName: "Meena", email: "meena@example.com" });
    expect((await (await call(req("GET"))).json()).email).toBe("meena@example.com");
    expect((await (await call(req("GET", undefined, "u2"))).json()).email).toBeNull();
    await call(req("PATCH", { email: "new@example.com" }));
    expect(db.prepare("SELECT email FROM hf_user_email WHERE uid='u1'").get().email).toBe("new@example.com");
  });
  it("a Clerk email wins over the typed one", async () => {
    cfg = { hfFanSignupEnabled: true };
    await call(req("PATCH", { email: "typed@example.com" }));
    emails = { u1: "clerk@example.com" };
    expect((await (await call(req("GET"))).json()).email).toBe("clerk@example.com");
  });
  it.each(["", "nope", "a@b", "a b@c.com", "a@@c.com", "a@c..com", 5, null])("rejects %p", async (v) => {
    cfg = { hfFanSignupEnabled: true };
    const r = await call(req("PATCH", { email: v }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_field", field: "email" });
  });
  it("signed out is 401", async () => {
    authFail = { status: 401, error: "unauthorized" };
    expect((await call(req("PATCH", { email: "a@b.com" }))).status).toBe(401);
  });
});
