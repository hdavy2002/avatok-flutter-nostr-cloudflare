// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-DAILY-FLOWS-1] The things a person does every day must be SAVED and SHOWN on the other end. Real route handlers on a real
// (in-memory) SQLite: rating -> admin approval -> public average, block -> My Fraands + calls, Notify me, support question, /report.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
const emails: any[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => (req.headers.get("x-test-uid") ? { uid: req.headers.get("x-test-uid") } : { status: 401, error: "unauthorized" }),
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../lib/email_outbox", () => ({ enqueueEmail: async (_e: any, m: any) => { emails.push(m); return { status: "queued" }; } }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async (_e: any, uid: string) => (uid === "u-nowa" ? null : "+919999999999") }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../lib/hf_push", () => ({ pushReviewRequest: async () => {} }));
vi.mock("./hf_hosts_public", () => ({
  SEL: "SELECT h.* FROM hf_hosts h",
  card: (_env: any, r: any) => ({ slug: r.slug, displayName: r.display_name, tagline: r.tagline, avatarUrl: null, status: r.presence === "online" || r.presence === "busy" ? r.presence : "offline" }),
}));

import { hfReviewsRoute, hostAggregates, hostReviews } from "../lib/hf_reviews";
import { hfNotifyRoute } from "../lib/hf_notify";
import { hfDashV3Route } from "./hf_dash_v3";
import { hfFavouritesRoute } from "./hf_favourites";
import { hfReportsRoute } from "./hf_reports";
import { hfDashSummaryRoute } from "./hf_dash_summary";
import { isBlockedEitherWay } from "../lib/hf_calls_store";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const fs = require_("node:fs");
let db: any, env: any, kv: Map<string, string>;
const mig = (f: string) => db.exec(fs.readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8"));

function makeEnv(withReports = true) {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, tagline TEXT, presence TEXT,
      women_lane INTEGER DEFAULT 0, lgbtq_lane INTEGER DEFAULT 0, lgbtq_public INTEGER DEFAULT 0);
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
    CREATE TABLE hf_incidents (id TEXT PRIMARY KEY, call_id TEXT, reporter_uid TEXT, kind TEXT, created_at INTEGER);
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, created_at INTEGER);
  `);
  mig("2026-10-09-hf-calls.sql");
  db.exec("ALTER TABLE hf_calls ADD COLUMN billable_seconds INTEGER");
  mig("2026-10-09-hf-reviews.sql");
  mig("hf_favourites.sql");
  mig("2026-10-16-hf-dash-v3.sql");
  mig("2026-10-16-hf-appt-reminders.sql");
  mig("2026-10-19-hf-prefs-reel-alerts.sql");
  if (withReports) mig("2026-10-23-hf-reports.sql");
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    ADMIN_UIDS: "admin1",
    DB_META: { prepare: (q: string) => stmt(q), batch: async (list: any[]) => { for (const s of list) await s.run(); return []; } },
    DB_WALLET: { prepare: (q: string) => stmt("SELECT 1") },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
  };
  const now = Date.now();
  db.exec(`INSERT INTO users VALUES ('cust1','Priya Sharma',1),('cust2','Rohan Gupta',1)`);
  db.exec(`INSERT INTO hf_hosts (uid,slug,status,display_name,tagline,presence) VALUES ('host1','humphrey-davy','live','Humphrey Davy','Founder','online')`);
  for (const [id, caller] of [["call1", "cust1"], ["call2", "cust2"]]) {
    db.prepare("INSERT INTO hf_calls (id,caller_uid,host_uid,rate_paise,status,created_at,connected_at,ended_at,billed_minutes) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, caller, "host1", 1000, "completed", now - 3600_000, now - 3600_000, now - 3000_000, 10);
  }
}
const req = (method: string, path: string, body?: unknown, uid?: string) =>
  new Request("https://x" + path, { method, headers: { "content-type": "application/json", ...(uid ? { "x-test-uid": uid, authorization: "Bearer t" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const reviews = async (method: string, path: string, body?: unknown, uid?: string) => { const r = await hfReviewsRoute(req(method, path, body, uid), env); return { status: r!.status, body: await r!.json() }; };
const dash = async (method: string, path: string, body?: unknown, uid = "cust1") => { const r = await hfDashV3Route(req(method, path, body, uid), env, path); return { status: r!.status, body: await r!.json() }; };
const favs = async (method: string, path = "/api/hf/favourites", uid = "cust1") => { const r = await hfFavouritesRoute(req(method, path, undefined, uid), env, path); return { status: r!.status, body: await r!.json() }; };
const notify = async (method: string, uid = "cust1") => { const r = await hfNotifyRoute(req(method, "/api/hf/hosts/humphrey-davy/notify", undefined, uid), env); return { status: r!.status, body: await r!.json() }; };
const report = async (body: unknown, uid?: string, method = "POST", path = "/api/hf/reports") => { const r = await hfReportsRoute(req(method, path, method === "GET" ? undefined : body, uid), env, path); return { status: r!.status, body: await r!.json() }; };

beforeEach(() => { makeEnv(); emails.length = 0; cfg = { hfCallsEnabled: true, hfFavouritesEnabled: true }; });

describe("rating -> review -> the influencer's public page", () => {
  it("a review is hidden until the team approves it, then moves the average and shows on the profile", async () => {
    expect((await hostAggregates(env, ["host1"])).get("host1")).toMatchObject({ rating: null, reviewCount: 0 });
    expect((await reviews("POST", "/api/hf/calls/call1/review", { stars: 5, text: "Lovely, patient conversation about my channel." }, "cust1")).status).toBe(200);
    expect((await reviews("POST", "/api/hf/calls/call2/review", { stars: 4 }, "cust2")).status).toBe(200);
    // pending reviews do not count
    expect((await hostAggregates(env, ["host1"])).get("host1")).toMatchObject({ rating: null, reviewCount: 0 });
    expect(await hostReviews(env, "host1")).toEqual([]);

    const list = await reviews("GET", "/api/admin/hf/reviews?status=pending", undefined, "admin1");
    expect(list.body.items).toHaveLength(2);
    expect((await reviews("POST", `/api/admin/hf/reviews/${list.body.items[0].id}`, { decision: "approve" }, "cust1")).status).toBe(403); // not an admin
    for (const it of list.body.items) expect((await reviews("POST", `/api/admin/hf/reviews/${it.id}`, { decision: "approve" }, "admin1")).status).toBe(200);

    const agg = (await hostAggregates(env, ["host1"])).get("host1")!;
    expect(agg.reviewCount).toBe(2);
    expect(agg.rating).toBe(4.5);
    expect(agg.ratingBreakdown).toMatchObject({ 5: 1, 4: 1 });
    const shown = await hostReviews(env, "host1");
    expect(shown.map((r) => r.firstName).sort()).toEqual(["Priya", "Rohan"]);
    expect(shown.find((r) => r.firstName === "Priya")).toMatchObject({ stars: 5, text: expect.stringContaining("Lovely") });
  });
  it("a rejected review never counts; one review per call; only the caller can review", async () => {
    await reviews("POST", "/api/hf/calls/call1/review", { stars: 1, text: "not a good one" }, "cust1");
    expect((await reviews("POST", "/api/hf/calls/call1/review", { stars: 5 }, "cust1")).status).toBe(409);
    expect((await reviews("POST", "/api/hf/calls/call2/review", { stars: 5 }, "cust1")).status).toBe(404);
    const id = (await reviews("GET", "/api/admin/hf/reviews", undefined, "admin1")).body.items[0].id;
    await reviews("POST", `/api/admin/hf/reviews/${id}`, { decision: "reject", reason: "abusive" }, "admin1");
    expect((await hostAggregates(env, ["host1"])).get("host1")).toMatchObject({ rating: null, reviewCount: 0 });
  });
});

describe("block -> Blocked list, My Fraands, and no calls", () => {
  it("blocking from a call removes the person from My Fraands and the pair can no longer call", async () => {
    expect((await favs("PUT", "/api/hf/favourites/humphrey-davy")).status).toBe(200);
    expect((await favs("GET")).body.items.map((i: any) => i.slug)).toEqual(["humphrey-davy"]);
    expect(await isBlockedEitherWay(env, "cust1", "host1")).toBe(false);

    expect((await dash("POST", "/api/hf/calls/call1/block", { reason: "rude" })).status).toBe(200);

    expect((await favs("GET")).body).toMatchObject({ items: [], count: 0 });
    expect((await dash("GET", "/api/hf/blocks")).body.items[0]).toMatchObject({ name: "Humphrey Davy", slug: "humphrey-davy" });
    expect(await isBlockedEitherWay(env, "cust1", "host1")).toBe(true);
    expect(await isBlockedEitherWay(env, "host1", "cust1")).toBe(true);

    // unblock lets them talk again
    const key = (await dash("GET", "/api/hf/blocks")).body.items[0].key;
    expect((await dash("DELETE", `/api/hf/blocks/${key}`)).status).toBe(200);
    expect(await isBlockedEitherWay(env, "cust1", "host1")).toBe(false);
  });
  it("a host who blocked me is not listed in my saved influencers either", async () => {
    await favs("PUT", "/api/hf/favourites/humphrey-davy");
    db.exec(`INSERT INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES ('host1','cust1','call1',1)`);
    expect((await favs("GET")).body.items).toEqual([]);
  });
});

describe("the influencer's side of hearts and Notify me", () => {
  it("shows how many people saved them and how many are waiting to be told", async () => {
    db.exec("CREATE TABLE IF NOT EXISTS hf_bookings (id TEXT PRIMARY KEY, host_uid TEXT, customer_uid TEXT, starts_at INTEGER, status TEXT, cancelled_at INTEGER, expected_host_net_paise INTEGER, settlement_status TEXT)");
    await favs("PUT", "/api/hf/favourites/humphrey-davy", "cust1");
    await favs("PUT", "/api/hf/favourites/humphrey-davy", "cust2");
    await notify("POST", "cust1");
    const sum = async (uid: string) => (await (await hfDashSummaryRoute(req("GET", "/api/hf/me/summary", undefined, uid), env))!.json());
    expect((await sum("host1")).fraands).toMatchObject({ hearts: 2, waiting: 1 });
    // a caller who blocked the influencer no longer counts as a fan
    db.exec("INSERT INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES ('cust2','host1','call2',1)");
    expect((await sum("host1")).fraands).toMatchObject({ hearts: 1, waiting: 1 });
    await notify("DELETE", "cust1");
    expect((await sum("host1")).fraands).toMatchObject({ waiting: 0 });
    // customers never see these numbers
    expect((await sum("cust1")).fraands).toMatchObject({ hearts: null, waiting: null });
  });
});

describe("Notify me", () => {
  it("is stored per person, shown back, and unsubscribes", async () => {
    expect((await notify("GET")).body).toEqual({ subscribed: false });
    expect((await notify("POST")).body).toEqual({ ok: true, subscribed: true });
    expect((await notify("GET")).body).toEqual({ subscribed: true });
    expect((await notify("GET", "cust2")).body).toEqual({ subscribed: false }); // someone else's switch is not mine
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_notify WHERE host_uid='host1'").get().n).toBe(1);
    expect((await notify("DELETE")).body).toEqual({ ok: true, subscribed: false });
    expect((await notify("GET")).body).toEqual({ subscribed: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_notify").get().n).toBe(0);
  });
  it("needs a verified WhatsApp number and cannot follow yourself", async () => {
    expect((await notify("POST", "u-nowa")).status).toBe(403);
    expect((await notify("POST", "host1")).status).toBe(409);
  });
});

describe("support question (Ask us)", () => {
  it("is stored, listed for the person, and listed for the team", async () => {
    const made = await dash("POST", "/api/hf/support/tickets", { topic: "wallet", message: "My top-up did not show up in the wallet." });
    expect(made.status).toBe(200);
    expect((await dash("GET", "/api/hf/support/tickets")).body.items.map((t: any) => t.id)).toEqual([made.body.id]);
    expect((await dash("GET", "/api/hf/support/tickets", undefined, "cust2")).body.items).toEqual([]);
    expect(emails[0].subject).toContain(made.body.id);
    expect((await report(undefined, "cust1", "GET", "/api/admin/hf/support-tickets")).status).toBe(403);
    const admin = await report(undefined, "admin1", "GET", "/api/admin/hf/support-tickets");
    expect(admin.body.items[0]).toMatchObject({ id: made.body.id, uid: "cust1", topic: "wallet", status: "open" });
    expect((await report(undefined, undefined, "GET", "/api/admin/hf/support-tickets")).status).toBe(401);
  });
});

describe("/report (Report a person)", () => {
  const good = { contact: "priya@example.com", profile: "Some Person", call: "call1", details: "They asked for my number and were abusive." };
  it("is stored (with the account when signed in), emailed to the grievance inbox and listed for the team", async () => {
    const r = await report(good, "cust1");
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^HF-R-[0-9A-F]{8}$/);
    expect(db.prepare("SELECT uid, profile, call_ref, status FROM hf_reports WHERE id=?").get(r.body.id)).toMatchObject({ uid: "cust1", profile: "Some Person", call_ref: "call1", status: "open" });
    expect(emails[0].subject).toContain(r.body.id);
    const anon = await report({ ...good, details: "Another report, signed out." });
    expect(anon.status).toBe(200);
    expect(db.prepare("SELECT uid FROM hf_reports WHERE id=?").get(anon.body.id).uid).toBeNull();
    expect((await report(undefined, "cust1", "GET", "/api/admin/hf/reports")).status).toBe(403);
    expect((await report(undefined, "admin1", "GET", "/api/admin/hf/reports")).body.items).toHaveLength(2);
  });
  it("rejects incomplete reports and is rate limited", async () => {
    for (const bad of [{ ...good, contact: "" }, { ...good, profile: "" }, { ...good, call: "" }, { ...good, details: "short" }]) expect((await report(bad)).status).toBe(400);
    for (let i = 0; i < 5; i++) await report(good);
    expect((await report(good)).status).toBe(429);
  });
  it("answers 503 not_ready (so the page falls back to the email draft) until the table exists", async () => {
    makeEnv(false);
    const r = await report(good);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("not_ready");
  });
});
