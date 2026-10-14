// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-DASH-SUMMARY-1] GET /api/hf/me/summary: auth, role, independent parts, privacy, own-uid scoping.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let authFail: { status: number; error: string } | null = null;
const reported: any[] = [];
vi.mock("./config", () => ({ readConfig: async () => ({}) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async (_e: any, _err: any, ctx: any) => { reported.push(ctx); } }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));

import { hfDashSummaryRoute } from "./hf_dash_summary";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const DAY = 86_400_000;
const istStart = () => Math.floor((Date.now() + 19_800_000) / DAY) * DAY - 19_800_000;

function makeEnv(withFav: boolean) {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, status TEXT, created_at INTEGER, connected_at INTEGER, ended_at INTEGER,
      billed_minutes INTEGER DEFAULT 0, charged_paise INTEGER DEFAULT 0, host_earning_paise INTEGER DEFAULT 0);
    CREATE TABLE hf_bookings (id TEXT PRIMARY KEY, host_uid TEXT, customer_uid TEXT, starts_at INTEGER, status TEXT, cancelled_at INTEGER,
      expected_host_net_paise INTEGER DEFAULT 0, settlement_status TEXT DEFAULT 'held');
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, e164 TEXT);
  `);
  if (withFav) db.exec("CREATE TABLE hf_favourites (uid TEXT, host_uid TEXT, created_at INTEGER, PRIMARY KEY(uid,host_uid))");
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) } };
}
const get = (uid = "u1", method = "GET") => hfDashSummaryRoute(new Request("https://x/api/hf/me/summary", { method, headers: { "x-test-uid": uid } }), env);
const call = (id: string, caller: string, host: string, status: string, at: number, mins = 1, paise = 500) =>
  db.prepare("INSERT INTO hf_calls (id,caller_uid,host_uid,status,created_at,connected_at,ended_at,billed_minutes,charged_paise) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, caller, host, status, at, at + 1000, at + 61_000, mins, paise);

beforeEach(() => { makeEnv(true); authFail = null; reported.length = 0; });

describe("GET /api/hf/me/summary", () => {
  it("401 when signed out", async () => {
    authFail = { status: 401, error: "no_session" };
    expect((await get()).status).toBe(401);
  });

  it("customer: made calls, saved fraands, no host-only numbers, no-store", async () => {
    db.prepare("INSERT INTO hf_hosts VALUES ('h1','maya','live','Maya')").run();
    const t = istStart() + 1000;
    call("c1", "u1", "h1", "completed", t);
    call("c2", "u1", "h1", "no_answer", t + 10, 0, 0);
    db.prepare("INSERT INTO hf_favourites VALUES ('u1','h1',1),('u2','h1',1)").run();
    const r = await get("u1");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, role: "customer", callsToday: { made: 1, received: 0 }, appointmentsToday: 0, expectedHostNetPaise: null, fraands: { saved: 1, newThisWeek: null } });
    expect(b.recentMade.map((x: any) => x.id)).toEqual(["c2", "c1"]);
    expect(b.recentMade[1]).toMatchObject({ otherHandle: "Maya", status: "completed", amountPaise: 500, seconds: 60 });
    expect(b.recentMade[0].amountPaise).toBeNull();
  });

  it("live host: role host, received calls, expected earnings, first-time callers this week", async () => {
    db.prepare("INSERT INTO hf_hosts VALUES ('h1','maya','live','Maya')").run();
    const t = istStart() + 1000;
    call("a", "u2", "h1", "completed", t);              // new caller today
    call("b", "u3", "h1", "completed", t - 20 * DAY);   // old caller...
    call("c", "u3", "h1", "completed", t);              // ...calling again: not new
    call("d", "u4", "h1", "completed", t - 3 * DAY);    // new, earlier this week
    db.prepare("INSERT INTO hf_bookings (id,host_uid,customer_uid,starts_at,status,expected_host_net_paise) VALUES ('b1','h1','u2',?,'confirmed',900)").run(Date.now() + DAY);
    db.prepare("INSERT INTO hf_bookings (id,host_uid,customer_uid,starts_at,status,expected_host_net_paise) VALUES ('b2','h1','u2',?,'cancelled',700)").run(Date.now() + DAY);
    const b = await (await get("h1")).json();
    expect(b).toMatchObject({ role: "host", callsToday: { received: 2, made: 0 }, expectedHostNetPaise: 900, fraands: { newThisWeek: 2 } });
  });

  it("a host who is not live yet is a customer", async () => {
    db.prepare("INSERT INTO hf_hosts VALUES ('h2','x','pending_review','X')").run();
    const b = await (await get("h2")).json();
    expect(b.role).toBe("customer");
    expect(b.expectedHostNetPaise).toBeNull();
  });

  it("appointments today count confirmed bookings for either side, not cancelled or other days", async () => {
    const t = istStart() + 3_600_000;
    const ins = db.prepare("INSERT INTO hf_bookings (id,host_uid,customer_uid,starts_at,status,cancelled_at) VALUES (?,?,?,?,?,?)");
    ins.run("1", "h1", "u1", t, "confirmed", null);
    ins.run("2", "u1", "u9", t, "confirmed", null);
    ins.run("3", "h1", "u1", t, "cancelled", t);
    ins.run("4", "h1", "u1", t + DAY, "confirmed", null);
    ins.run("5", "h1", "u8", t, "confirmed", null);
    expect((await (await get("u1")).json()).appointmentsToday).toBe(2);
  });

  it("a missing hf_favourites table nulls only that part and reports it", async () => {
    makeEnv(false);
    const r = await get("u1");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.fraands.saved).toBeNull();
    expect(b.callsToday.made).toBe(0);
    expect(reported.some((c) => c.extra?.area === "hf_dash_summary" && c.extra?.part === "fraands_saved")).toBe(true);
  });

  it("recentMade never carries a phone, email or uid", async () => {
    db.prepare("INSERT INTO hf_hosts VALUES ('h1','maya','live','Maya')").run();
    db.prepare("INSERT INTO users VALUES ('h1','Maya Real','+919876543210')").run();
    call("c1", "u1", "h1", "completed", Date.now() - 1000);
    const text = JSON.stringify(await (await get("u1")).json());
    expect(text).not.toMatch(/9876|e164|@|"h1"|caller_uid|host_uid|phone/i);
  });

  it("counts are scoped to the signed-in uid", async () => {
    db.prepare("INSERT INTO hf_hosts VALUES ('h1','maya','live','Maya')").run();
    const t = istStart() + 1000;
    call("c1", "u2", "h1", "completed", t);
    db.prepare("INSERT INTO hf_favourites VALUES ('u2','h1',1)").run();
    const b = await (await get("u1")).json();
    expect(b.callsToday).toEqual({ made: 0, received: 0 });
    expect(b.fraands.saved).toBe(0);
    expect(b.recentMade).toEqual([]);
  });
});
