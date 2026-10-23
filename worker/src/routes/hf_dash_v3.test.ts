// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-DASH-V3-1] Insights, profile, prefs, blocks and support tickets for the new customer dashboard.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (u: any) => !!u?.error,
}));
let cfg: Record<string, unknown> = {};
vi.mock("./config", () => ({ readConfig: async () => cfg }));
const emails: any[] = [];
vi.mock("../lib/email_outbox", () => ({ enqueueEmail: async (_e: any, m: any) => { emails.push(m); return { status: "queued" }; } }));

import { hfDashV3Route, streakFrom, istDay, istMonthStart, validateProfile, notifyWhatsappOn } from "./hf_dash_v3";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>;
const DAY = 86_400_000;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, first_name TEXT, last_name TEXT, updated_at INTEGER, created_at INTEGER);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'live');
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, status TEXT, created_at INTEGER, connected_at INTEGER, ended_at INTEGER,
      billed_minutes INTEGER DEFAULT 0, billable_seconds INTEGER, charged_paise INTEGER DEFAULT 0, consumed_value_paise INTEGER);
    CREATE TABLE hf_reviews (id TEXT PRIMARY KEY, call_id TEXT UNIQUE);
    CREATE TABLE hf_blocks (blocker_uid TEXT, blocked_uid TEXT, call_id TEXT, created_at INTEGER, PRIMARY KEY (blocker_uid, blocked_uid));
    CREATE TABLE hf_incidents (id TEXT PRIMARY KEY, call_id TEXT, reporter_uid TEXT, kind TEXT, created_at INTEGER);
    CREATE TABLE hf_notify (caller_uid TEXT, host_uid TEXT, created_at INTEGER, notified_at INTEGER);
    CREATE TABLE hf_favourites (uid TEXT NOT NULL, host_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (uid, host_uid));
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, created_at INTEGER);
  `);
  db.exec(require_("node:fs").readFileSync(new URL("../../migrations/2026-10-16-hf-dash-v3.sql", import.meta.url), "utf8"));
  db.exec(require_("node:fs").readFileSync(new URL("../../migrations/2026-10-16-hf-appt-reminders.sql", import.meta.url), "utf8"));
  db.exec(require_("node:fs").readFileSync(new URL("../../migrations/2026-10-19-hf-prefs-reel-alerts.sql", import.meta.url), "utf8"));
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q), batch: async (list: any[]) => { for (const s of list) await s.run(); return []; } },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
    RATE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
  };
}
const req = (method: string, path: string, body?: unknown, uid = "u1") =>
  new Request("https://x" + path, { method, headers: { "content-type": "application/json", "x-test-uid": uid }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (method: string, path: string, body?: unknown, uid = "u1") => { const r = await hfDashV3Route(req(method, path, body, uid), env, path); return { status: r!.status, body: await r!.json() }; };

beforeEach(() => { makeEnv(); emails.length = 0; cfg = {}; });

describe("pure helpers", () => {
  it("streak counts back from today, or from yesterday when today has no call yet", () => {
    expect(streakFrom([10, 9, 8, 6], 10)).toBe(3);
    expect(streakFrom([9, 8], 10)).toBe(2);
    expect(streakFrom([7], 10)).toBe(0);
  });
  it("IST day and month boundaries", () => {
    const t = Date.UTC(2026, 9, 15, 20, 0); // 16 Oct 01:30 IST
    expect(new Date(istDay(t) * DAY).toISOString().slice(0, 10)).toBe("2026-10-16");
    expect(istMonthStart(t)).toBe(Date.UTC(2026, 9, 1) - 19_800_000);
    expect(istMonthStart(t, -1)).toBe(Date.UTC(2026, 8, 1) - 19_800_000);
  });
  it("profile validation", () => {
    expect(validateProfile({ firstName: "Davy", languages: ["Hindi", "English"], talkAbout: "Cricket and music" })).toMatchObject({ ok: true });
    expect(validateProfile({ languages: ["Klingon"] })).toMatchObject({ ok: false, field: "languages" });
    expect(validateProfile({ talkAbout: "call me on 9876543210" })).toMatchObject({ ok: false, field: "talkAbout" });
    expect(validateProfile({ firstName: "R2D2" })).toMatchObject({ ok: false, field: "firstName" });
  });
});

describe("GET /api/hf/me/insights", () => {
  it("adds up only my completed calls and lists calls still waiting for a rating", async () => {
    const now = Date.now();
    db.exec(`INSERT INTO hf_hosts VALUES ('h1','riya','Riya','live'),('h2','arjun','Arjun','live')`);
    db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("c1", "u1", "h1", "completed", now - 3600_000, now - 3600_000, now - 3000_000, 10, 600, 2394, null);
    db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("c2", "u1", "h2", "completed", now - 2 * DAY, now - 2 * DAY, now - 2 * DAY + 60_000, 1, 60, 399, null);
    db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("c3", "u1", "h2", "no_answer", now - 1000, null, null, 0, 0, 0, null);
    db.prepare("INSERT INTO hf_calls VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("c4", "u2", "h1", "completed", now - 1000, now - 1000, now, 5, 300, 1197, null);
    db.exec(`INSERT INTO hf_reviews VALUES ('r1','c2')`);
    const r = await call("GET", "/api/hf/me/insights");
    expect(r.status).toBe(200);
    expect(r.body.talkDaily).toHaveLength(14);
    expect(r.body.talkDaily.reduce((s: number, d: any) => s + d.seconds, 0)).toBe(660);
    expect(r.body.topFraands[0]).toMatchObject({ slug: "riya", seconds: 600 });
    expect(r.body.talkedTo).toBe(2);
    expect(r.body.pendingReviews.map((p: any) => p.callId)).toEqual(["c1"]);
    expect(r.body.blockedCount).toBe(0);
  });
});

describe("profile, prefs, blocks, tickets", () => {
  it("saves profile extras and names", async () => {
    db.exec(`INSERT INTO users (uid, created_at) VALUES ('u1', 1)`);
    db.exec(`INSERT INTO hf_user_registration VALUES ('u1','Old','Name','davy',1)`);
    const r = await call("PUT", "/api/hf/me/profile", { firstName: "Davy", city: "Mumbai", languages: ["Hindi"], talkAbout: "Startups" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ firstName: "Davy", lastName: "Name", username: "davy", city: "Mumbai", languages: ["Hindi"], talkAbout: "Startups" });
    expect((await call("PUT", "/api/hf/me/profile", { talkAbout: "wa.me/919876543210" })).status).toBe(400);
  });
  it("[HF-FIX-PROFILE-NAME-1] names persist for a user with NO registration row, and GET returns them", async () => {
    db.exec(`INSERT INTO users (uid, display_name, created_at) VALUES ('u1', NULL, 1)`);
    const r = await call("PUT", "/api/hf/me/profile", { firstName: "Davy", lastName: "Kumar" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ firstName: "Davy", lastName: "Kumar" });
    expect((await call("GET", "/api/hf/me/profile")).body).toMatchObject({ firstName: "Davy", lastName: "Kumar" });
    expect(db.prepare("SELECT first_name, last_name FROM users WHERE uid='u1'").get()).toMatchObject({ first_name: "Davy", last_name: "Kumar" });
    // partial update keeps the other name
    expect((await call("PUT", "/api/hf/me/profile", { lastName: "Singh" })).body).toMatchObject({ firstName: "Davy", lastName: "Singh" });
  });
  it("[HF-FIX-PROFILE-NAME-1] with a registration row both stay in step; unknown user is a 404, never a silent 200", async () => {
    db.exec(`INSERT INTO users (uid, created_at) VALUES ('u1', 1)`);
    db.exec(`INSERT INTO hf_user_registration VALUES ('u1','Old','Name','davy',1)`);
    expect((await call("PUT", "/api/hf/me/profile", { firstName: "New" })).body).toMatchObject({ firstName: "New", lastName: "Name" });
    expect(db.prepare("SELECT first_name FROM hf_user_registration WHERE uid='u1'").get()).toMatchObject({ first_name: "New" });
    const ghost = await call("PUT", "/api/hf/me/profile", { firstName: "Zed" }, "ghost");
    expect(ghost.status).toBe(404);
  });
  it("notify preference defaults on and can be paused", async () => {
    expect(await notifyWhatsappOn(env, "u1")).toBe(true);
    expect((await call("PUT", "/api/hf/me/prefs", { notifyWhatsapp: false })).body).toEqual({ ok: true, notifyWhatsapp: false, apptReminders: true, reelAlerts: true });
    expect(await notifyWhatsappOn(env, "u1")).toBe(false);
    expect((await call("PUT", "/api/hf/me/prefs", { apptReminders: false })).body).toEqual({ ok: true, notifyWhatsapp: false, apptReminders: false, reelAlerts: true });
    expect((await call("GET", "/api/hf/me/prefs")).body).toEqual({ ok: true, notifyWhatsapp: false, apptReminders: false, reelAlerts: true });
    expect((await call("PUT", "/api/hf/me/prefs", { apptReminders: "no" })).status).toBe(400);
  });
  it("[HF-WIRE-2] PATCH prefs and reelAlerts: flag off is 403, flag on works, own row only", async () => {
    expect((await call("PATCH", "/api/hf/me/prefs", { notifyWhatsapp: false })).status).toBe(403);
    expect((await call("PUT", "/api/hf/me/prefs", { reelAlerts: false })).status).toBe(403);
    cfg = { hfFanSignupEnabled: true };
    expect((await call("PATCH", "/api/hf/me/prefs", { reelAlerts: false })).body).toEqual({ ok: true, notifyWhatsapp: true, apptReminders: true, reelAlerts: false });
    expect((await call("GET", "/api/hf/me/prefs")).body.reelAlerts).toBe(false);
    expect((await call("GET", "/api/hf/me/prefs", undefined, "u2")).body.reelAlerts).toBe(true);
    expect((await call("PATCH", "/api/hf/me/prefs", { reelAlerts: "x" })).status).toBe(400);
    expect((await call("PATCH", "/api/hf/me/prefs", {})).status).toBe(400);
  });
  it("blocks the other person of my call only, lists and unblocks", async () => {
    db.exec(`INSERT INTO hf_hosts VALUES ('h1','riya','Riya','live')`);
    db.exec(`INSERT INTO hf_calls (id,caller_uid,host_uid,status,created_at) VALUES ('call_1','u1','h1','completed',1)`);
    db.exec(`INSERT INTO hf_notify VALUES ('u1','h1',1,NULL)`);
    expect((await call("POST", "/api/hf/calls/call_1/block", { reason: "rude" }, "u9")).status).toBe(404);
    expect((await call("POST", "/api/hf/calls/call_1/block", { reason: "rude" })).status).toBe(200);
    expect(db.prepare("SELECT kind FROM hf_incidents").get().kind).toBe("dash_report:rude");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_notify").get().n).toBe(0);
    const list = await call("GET", "/api/hf/blocks");
    expect(list.body.items[0]).toMatchObject({ name: "Riya", slug: "riya" });
    expect(list.body.items[0].blocked).toBeUndefined();
    expect((await call("DELETE", `/api/hf/blocks/${list.body.items[0].key}`)).status).toBe(200);
    expect((await call("GET", "/api/hf/blocks")).body.items).toEqual([]);
  });
  it("[HF-BLOCK-PROFILE-1] blocks from a profile slug, idempotent, same effects and unblock", async () => {
    db.exec(`INSERT INTO hf_hosts VALUES ('h1','riya','Riya','live'), ('u1','me','Me','live')`);
    db.exec(`INSERT INTO hf_notify VALUES ('u1','h1',1,NULL)`);
    db.exec(`INSERT INTO hf_favourites VALUES ('u1','h1',1)`);
    expect((await call("POST", "/api/hf/blocks", {})).status).toBe(400);
    expect((await call("POST", "/api/hf/blocks", { slug: "nobody" })).status).toBe(404);
    expect((await call("POST", "/api/hf/blocks", { slug: "me" })).status).toBe(400);
    const a = await call("POST", "/api/hf/blocks", { slug: "Riya", reason: "rude" });
    expect(a.status).toBe(200);
    expect(a.body.key).toMatch(/^[a-f0-9]{20}$/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_notify").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_favourites").get().n).toBe(0);
    const b = await call("POST", "/api/hf/blocks", { slug: "riya" });
    expect(b.body.key).toBe(a.body.key);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_blocks").get().n).toBe(1);
    const list = await call("GET", "/api/hf/blocks");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ key: a.body.key, name: "Riya", slug: "riya" });
    expect((await call("DELETE", `/api/hf/blocks/${a.body.key}`)).status).toBe(200);
    expect((await call("GET", "/api/hf/blocks")).body.items).toEqual([]);
  });
  it("support ticket is stored and emailed", async () => {
    expect((await call("POST", "/api/hf/support/tickets", { topic: "wallet", message: "short" })).status).toBe(400);
    const r = await call("POST", "/api/hf/support/tickets", { topic: "wallet", message: "My top-up did not show up in the wallet." });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^HF-T-[A-F0-9]{8}$/);
    expect(emails).toHaveLength(1);
    expect((await call("GET", "/api/hf/support/tickets")).body.items[0]).toMatchObject({ id: r.body.id, topic: "wallet", status: "open" });
  });
});
