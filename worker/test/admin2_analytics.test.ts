// [ADMIN2-ANALYTICS 2026-09-26] GET /api/admin/v2/analytics through the real admin2Route
// dispatcher against real SQLite (node:sqlite) with the real hdfc/refunds/contact migrations.
// Auth, telemetry and the Clerk email lookup are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "admin1" as string | null, exceptions: 0 }));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  trackUser: async () => {},
  trackException: async () => { H.exceptions++; },
}));
vi.mock("../src/lib/identity", () => ({ emailFor: async (_env: unknown, uid: string) => `${uid}@example.com` }));

// admin2 first: it is the entry that imports admin2_analytics.
import { admin2Route, DAY_MS } from "../src/routes/admin2";
import { analyticsWindow, parseIstDay, dayKey, istDayIndex, ANALYTICS_MAX_DAYS } from "../src/routes/admin2_analytics";

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

// 2026-09-26 11:30 IST (06:00 UTC). The IST day starts at 2026-09-25 18:30 UTC.
const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
const TODAY = Date.UTC(2026, 8, 25, 18, 30, 0);
const H1 = 3_600_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (id TEXT PRIMARY KEY, creator_id TEXT, kind TEXT, title TEXT, description TEXT, category TEXT,
      price INTEGER, free_entry INTEGER DEFAULT 0, cover_media TEXT, attrs TEXT, starts_at INTEGER, duration_min INTEGER,
      capacity INTEGER, status TEXT, expires_at INTEGER, is_example INTEGER DEFAULT 0);
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE orders (id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, creator_id TEXT, amount INTEGER, promo_id TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, kind TEXT);
    CREATE TABLE commercial_policy_snapshots (order_id TEXT PRIMARY KEY, gross_amount INTEGER, gst_amount INTEGER);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, first_name TEXT, last_name TEXT, avatar_url TEXT,
      email_hash TEXT, phone_hash TEXT, private_number TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT,
      status TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER, verified_at INTEGER);
  `);
  db.exec(mig("contact_verification.sql"));
  db.exec(mig("2026-09-17-hdfc-sms-payments.sql"));
  db.exec(mig("2026-09-25-dash2-refunds.sql"));
  db.exec(`
    INSERT INTO listing_categories (id,label) VALUES ('puja','Puja'),('havan','Havan');
    INSERT INTO listings (id,kind,title,category,price,free_entry,starts_at,duration_min,capacity,status) VALUES
      ('Lpuja','live_event','Ganesh Puja','puja',501,0,${NOW + 3 * H1},60,50,'published'),
      ('Lhavan','live_event','Rudra Havan','havan',1100,0,${TODAY + 3 * DAY_MS + H1},90,NULL,'published'),
      ('Llive','live_event','Live Aarti','puja',0,1,${NOW - 10 * 60_000},60,NULL,'live'),
      ('Lold','live_event','Old Puja','puja',501,0,${TODAY - 10 * DAY_MS},60,NULL,'completed'),
      ('avatok-upi-smoke-2026','live_event','Smoke',NULL,1,0,${NOW + 5 * H1},60,NULL,'published');
    INSERT INTO users (uid,display_name,created_at,updated_at) VALUES
      ('alice','Alice',${NOW - H1},0), ('bob','Bob',${Math.floor((TODAY - 2 * DAY_MS) / 1000)},0),
      ('erin','Erin',${TODAY - 8 * DAY_MS},0), ('old','Old',${TODAY - 30 * DAY_MS},0);
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','Lpuja','alice',501,'held',${NOW - H1},'live_event'),
      ('o2','Lhavan','bob',1100,'held',${TODAY - 2 * DAY_MS + H1},'live_event'),
      ('o3','Lhavan','carol',1100,'refunded',${NOW - 2 * H1},'live_event'),
      ('o4','Llive','dev',0,'free',${NOW - 3 * H1},'live_event'),
      ('o5','Lold','erin',501,'released',${TODAY - 10 * DAY_MS},'live_event'),
      ('o6','Lpuja','alice',501,'held',${TODAY - DAY_MS + H1},'live_event'),
      ('o7','Lold','fay',501,'released',${TODAY - 9 * DAY_MS},'live_event'),
      ('osmoke','avatok-upi-smoke-2026','alice',1,'held',${NOW - H1},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o2',1100,198);
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','Lpuja','live_event',62700,'confirmed','UTR1','o1',${NOW},${NOW - H1 - 60_000},${NOW - H1}),
      ('i6','alice','Lpuja','live_event',62700,'confirmed','UTR6','o6',${NOW},${TODAY - DAY_MS + H1 - 60_000},${TODAY - DAY_MS + H1}),
      ('ip','hari','Lhavan','live_event',129800,'pending',NULL,NULL,${NOW + 10 * 60_000},${NOW - 60_000},${NOW - 60_000}),
      ('iq','ira','Lhavan','live_event',129800,'review_pending','UTRQ',NULL,${NOW - H1},${NOW - 2 * H1},${NOW - H1}),
      ('ismoke','alice','avatok-upi-smoke-2026','live_event',100,'payment_received',NULL,NULL,${NOW + H1},${NOW},${NOW});
    INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,requested_at,refunded_at) VALUES
      ('r1','i6','alice',62700,'Travelling','requested',${NOW - H1},NULL),
      ('r2','o7','fay',50100,NULL,'refunded',${NOW - 3 * DAY_MS},${NOW - DAY_MS});
  `);
  const env: any = { DB_META: d1(db), ADMIN_UIDS: "admin1" };
  return { db, env };
}

const call = async (env: any, path: string) => {
  const url = `https://api.test${path}`;
  const res = await admin2Route(new Request(url, { headers: { authorization: "Bearer t" } }), env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any };
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => { H.uid = "admin1"; H.exceptions = 0; vi.spyOn(Date, "now").mockReturnValue(NOW); });

describe("analytics window", () => {
  it("presets end today (IST) and the previous period is the same length right before", () => {
    const w = analyticsWindow(new URLSearchParams("range=7d"), NOW) as any;
    expect(w).toMatchObject({ preset: "7d", days: 7, from: TODAY - 6 * DAY_MS, to: TODAY + DAY_MS, prevFrom: TODAY - 13 * DAY_MS, prevTo: TODAY - 6 * DAY_MS });
    expect(w).toMatchObject({ fromDay: "2026-09-20", toDay: "2026-09-26", prevFromDay: "2026-09-13", prevToDay: "2026-09-19" });
    expect((analyticsWindow(new URLSearchParams("range=today"), NOW) as any).fromDay).toBe("2026-09-26");
    expect((analyticsWindow(new URLSearchParams(""), NOW) as any).days).toBe(30);
  });
  it("custom from/to are inclusive IST days", () => {
    const w = analyticsWindow(new URLSearchParams("from=2026-09-01&to=2026-09-10&tz=Asia/Kolkata"), NOW) as any;
    expect(w).toMatchObject({ preset: "custom", days: 10, from: Date.UTC(2026, 7, 31, 18, 30), prevToDay: "2026-08-31", prevFromDay: "2026-08-22" });
  });
  it("rejects bad input", () => {
    for (const q of ["from=2026-02-31&to=2026-03-01", "from=2026-09-10&to=2026-09-01", "range=1y", "tz=UTC",
      `from=2024-01-01&to=2026-01-01`]) {
      expect(analyticsWindow(new URLSearchParams(q), NOW)).toHaveProperty("error");
    }
    expect(parseIstDay("2026-9-1")).toBeNull();
    expect(dayKey(istDayIndex(TODAY))).toBe("2026-09-26");
    expect(ANALYTICS_MAX_DAYS).toBe(366);
  });
});

describe("GET /api/admin/v2/analytics", () => {
  it("is admin-only and validates the range", async () => {
    const { env } = setup();
    H.uid = "bob";
    expect((await call(env, "/api/admin/v2/analytics")).status).toBe(403);
    H.uid = "admin1";
    const bad = await call(env, "/api/admin/v2/analytics?from=2026-09-10&to=2026-09-01");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_range");
    expect((await call(env, "/api/admin/v2/analytics?tz=Europe/London")).body.error).toBe("bad_tz");
  });

  it("KPIs with previous period (paise)", async () => {
    const { env } = setup();
    const r = await call(env, "/api/admin/v2/analytics?range=7d&tz=Asia/Kolkata");
    expect(r.status).toBe(200);
    expect(r.body.range).toMatchObject({ preset: "7d", days: 7, from: "2026-09-20", to: "2026-09-26", prev_from: "2026-09-13" });
    const k = r.body.kpis;
    // cur: i1 62700 + o2 snapshot (1100+198)*100 + i6 62700 (refund only requested). o3 refunded, smoke never.
    // prev: o5 50100; o7 refunded (refunds row) is out.
    expect(k.revenue_paise).toEqual({ cur: 255200, prev: 50100 });
    expect(k.paid_bookings).toEqual({ cur: 3, prev: 1 });
    expect(k.unique_customers).toEqual({ cur: 2, prev: 1 });
    expect(k.aov_paise).toEqual({ cur: 85067, prev: 50100 });
    // alice (ms) + bob (seconds) now; erin before.
    expect(k.signups).toEqual({ cur: 2, prev: 1 });
    // r2 sent back yesterday.
    expect(k.refunds).toEqual({ count: { cur: 1, prev: 0 }, paise: { cur: 50100, prev: 0 } });
    // cur: o3 of 4 paid in the period; prev: o7 of 2.
    expect(k.refund_rate).toEqual({ cur: 0.25, prev: 0.5 });
    expect(k.seats).toEqual({ cur: 4, prev: 2 });
    expect(k.live_now).toBe(1);
    expect(k.upcoming_events).toEqual({ total: 2, next_7d: 2 });
    expect(k.pending_payments).toEqual({ count: 2, paise: 259600, review: 1 });
    expect(k.open_refunds).toEqual({ count: 1, paise: 62700 });
  });

  it("daily series line up with the previous period", async () => {
    const { env } = setup();
    const s = (await call(env, "/api/admin/v2/analytics?range=7d")).body.series;
    expect(s.days).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(s.revenue_paise).toEqual([0, 0, 0, 0, 129800, 62700, 62700]);
    // o5 on 2026-09-16 = index 3 of 13..19.
    expect(s.revenue_prev_paise).toEqual([0, 0, 0, 50100, 0, 0, 0]);
    expect(s.paid_bookings).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(s.seats).toEqual([0, 0, 0, 0, 1, 1, 2]);
    expect(s.free_seats).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(s.signups).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(s.refunds_paise[5]).toBe(50100);
    expect(s.upcoming).toHaveLength(14);
    expect(s.upcoming[0]).toEqual({ day: "2026-09-26", count: 2 });
    expect(s.upcoming[3]).toEqual({ day: "2026-09-29", count: 1 });
  });

  it("categories, top events and the UPI funnel", async () => {
    const { env } = setup();
    const b = (await call(env, "/api/admin/v2/analytics?range=7d")).body;
    expect(b.by_category).toEqual([
      { category: "havan", label: "Havan", revenue_paise: 129800, paid_bookings: 1 },
      { category: "puja", label: "Puja", revenue_paise: 125400, paid_bookings: 2 },
    ]);
    expect(b.top_events.map((e: any) => [e.id, e.revenue_paise, e.paid_bookings])).toEqual([["Lhavan", 129800, 1], ["Lpuja", 125400, 2]]);
    // alice|Lpuja (two intents, one step), hari pending, ira under review.
    expect(b.funnel).toEqual({ started: 3, sent: 2, confirmed: 1, kept: 1 });
  });

  it("lists: next events, latest payments, open refunds", async () => {
    const { env } = setup();
    const b = (await call(env, "/api/admin/v2/analytics?range=30d")).body;
    expect(b.next_events.map((e: any) => e.id)).toEqual(["Llive", "Lpuja", "Lhavan"]);
    expect(b.recent_payments.length).toBeLessThanOrEqual(10);
    const ats = b.recent_payments.map((p: any) => p.at);
    expect([...ats].sort((x: number, y: number) => y - x)).toEqual(ats);
    expect(b.recent_payments.some((p: any) => p.id === "osmoke")).toBe(false);
    expect(b.open_refunds).toEqual([
      { id: "r1", uid: "alice", customer: "Alice", event_title: "Ganesh Puja", amount_paise: 62700, requested_at: NOW - H1, reason: "Travelling" },
    ]);
  });

  it("an empty database answers zeros and null funnel", async () => {
    const { db, env } = setup();
    db.exec("DELETE FROM listings; DELETE FROM orders; DELETE FROM hdfc_sms_payment_intents; DELETE FROM refunds; DELETE FROM users;");
    const b = (await call(env, "/api/admin/v2/analytics?range=90d")).body;
    expect(b.kpis.revenue_paise).toEqual({ cur: 0, prev: 0 });
    expect(b.kpis.refund_rate).toEqual({ cur: null, prev: null });
    expect(b.series.revenue_paise).toHaveLength(90);
    expect(b.funnel).toBeNull();
    expect(b.by_category).toEqual([]);
    expect(b.next_events).toEqual([]);
  });

  it("a failing query is a tracked 500", async () => {
    const { env } = setup();
    env.DB_META = { prepare() { throw new Error("D1 down"); } };
    const r = await call(env, "/api/admin/v2/analytics");
    expect(r.status).toBe(500);
    expect(H.exceptions).toBe(1);
  });
});
