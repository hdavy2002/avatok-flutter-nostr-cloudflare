// [ADMIN2-API 2026-09-26] Admin 2 shell routes (whoami, overview) and the route table,
// run through the real admin2Route dispatcher against real SQLite (node:sqlite) with
// the real hdfc + refunds migrations. Auth, telemetry and the Clerk email lookup are mocked.
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

import { admin2Route, matchAdmin2, istDayStart, overviewWindows, DAY_MS, type Admin2RouteDef } from "../src/routes/admin2";

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
    async batch(stmts: any[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

// 2026-09-26 11:30 IST (06:00 UTC). IST day starts at 2026-09-25 18:30 UTC.
const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
const TODAY = Date.UTC(2026, 8, 25, 18, 30, 0);
const H1 = 3_600_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (id TEXT PRIMARY KEY, creator_id TEXT, kind TEXT, title TEXT, description TEXT, category TEXT,
      price INTEGER, free_entry INTEGER DEFAULT 0, cover_media TEXT, attrs TEXT, starts_at INTEGER, duration_min INTEGER,
      capacity INTEGER, status TEXT, expires_at INTEGER, is_example INTEGER DEFAULT 0);
    CREATE TABLE orders (id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, creator_id TEXT, amount INTEGER, promo_id TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, kind TEXT);
    CREATE TABLE commercial_policy_snapshots (order_id TEXT PRIMARY KEY, gross_amount INTEGER, gst_amount INTEGER);
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER, active INTEGER DEFAULT 1);
  `);
  db.exec(mig("2026-09-17-hdfc-sms-payments.sql"));
  db.exec(mig("2026-09-25-dash2-refunds.sql"));
  db.exec(`
    INSERT INTO listing_categories (id,label) VALUES ('puja','Puja'),('havan','Havan');
    INSERT INTO listings (id,kind,title,category,price,free_entry,starts_at,duration_min,capacity,status,is_example,cover_media) VALUES
      ('Llive','live_event','Live Aarti','puja',0,1,${NOW - 10 * 60_000},60,NULL,'live',0,NULL),
      ('Ltoday','live_event','Ganesh Puja','puja',501,0,${NOW + 3 * H1},60,50,'published',0,'[{"type":"image","url":"https://img/x.jpg"}]'),
      ('Ldone','live_event','Morning Havan','havan',1100,0,${Math.floor((TODAY + 2 * H1) / 1000)},60,NULL,'completed',0,NULL),
      ('Lweek','live_event','Rudra Havan','havan',1100,0,${TODAY + 6 * DAY_MS + H1},90,NULL,'published',0,NULL),
      ('Lfar','live_event','Diwali Puja','puja',2100,0,${TODAY + 8 * DAY_MS},60,NULL,'published',0,NULL),
      ('Ldraft','live_event','Draft Puja','puja',100,0,${NOW + 5 * H1},60,NULL,'draft',0,NULL),
      ('Lexample','live_event','Example','puja',100,0,${NOW + 5 * H1},60,NULL,'published',1,NULL),
      ('avatok-upi-smoke-2026','live_event','Smoke',NULL,1,0,${NOW + 5 * H1},60,NULL,'published',0,NULL),
      ('Lold','live_event','Old Puja','puja',501,0,${TODAY - 20 * DAY_MS},60,NULL,'completed',0,NULL);
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','Ltoday','alice',501,'held',${NOW - H1},'live_event'),
      ('o2','Lweek','bob',1100,'held',${TODAY - 2 * DAY_MS},'live_event'),
      ('o3','Lweek','carol',1100,'refunded',${NOW - 2 * H1},'live_event'),
      ('o4','Llive','dev',0,'free',${NOW - 3 * H1},'live_event'),
      ('o5','Lold','erin',501,'released',${TODAY - 20 * DAY_MS},'live_event'),
      ('o6','Lold','fay',501,'released',${TODAY - 40 * DAY_MS},'live_event'),
      ('o7','Ltoday','gia',501,'held',${TODAY - 3 * DAY_MS},'live_event'),
      ('osmoke','avatok-upi-smoke-2026','alice',1,'held',${NOW - H1},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o2',1100,198);
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','Ltoday','live_event',62700,'confirmed','512345678901','o1',${NOW},${NOW - H1 - 60_000},${NOW - H1}),
      ('i7','gia','Ltoday','live_event',62700,'confirmed','512345678907','o7',${NOW},${TODAY - 3 * DAY_MS},${TODAY - 3 * DAY_MS}),
      ('ip1','hari','Lweek','live_event',129800,'pending',NULL,NULL,${NOW + 10 * 60_000},${NOW - 60_000},${NOW - 60_000}),
      ('ip2','ira','Lweek','live_event',129800,'review_pending','UTR1',NULL,${NOW - H1},${NOW - 2 * H1},${NOW - H1}),
      ('ip3','jay','Lweek','live_event',129800,'pending',NULL,NULL,${NOW - 60_000},${NOW - H1},${NOW - H1}),
      ('ip4','kim','Lweek','live_event',129800,'expired',NULL,NULL,${NOW - H1},${NOW - 2 * H1},${NOW - H1}),
      ('ismoke','alice','avatok-upi-smoke-2026','live_event',100,'payment_received',NULL,NULL,${NOW + H1},${NOW},${NOW});
    INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,requested_at) VALUES
      ('r1','i7','gia',62700,'Travelling','requested',${NOW - H1}),
      ('r2','o5','erin',59118,NULL,'refunded',${NOW - 5 * DAY_MS}),
      ('r3','o2','bob',129800,NULL,'rejected',${NOW - DAY_MS});
  `);
  const env: any = { DB_META: d1(db), ADMIN_UIDS: "admin1,admin2" };
  return { db, env };
}

const call = async (env: any, method: string, path: string) => {
  const url = `https://api.test${path}`;
  const res = await admin2Route(new Request(url, { method, headers: { authorization: "Bearer t" } }), env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any };
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => { H.uid = "admin1"; H.exceptions = 0; vi.spyOn(Date, "now").mockReturnValue(NOW); });

describe("IST windows", () => {
  it("starts the day at 00:00 IST", () => {
    expect(istDayStart(NOW)).toBe(TODAY);
    // 23:59 IST is still the same day; 00:00 IST is the next.
    expect(istDayStart(TODAY + DAY_MS - 1)).toBe(TODAY);
    expect(istDayStart(TODAY + DAY_MS)).toBe(TODAY + DAY_MS);
    const w = overviewWindows(NOW);
    expect(w.weekEnd - w.todayStart).toBe(7 * DAY_MS);
    expect(w.todayStart - w.last7Start).toBe(6 * DAY_MS);
    expect(w.todayStart - w.last30Start).toBe(29 * DAY_MS);
  });
});

describe("GET /api/admin/whoami", () => {
  it("answers an admin with uid and email", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/admin/whoami");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ admin: true, uid: "admin1", email: "admin1@example.com" });
  });
  it("403 admin_only for a signed-in non-admin", async () => {
    const { env } = setup();
    H.uid = "alice";
    const r = await call(env, "GET", "/api/admin/whoami");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("admin_only");
  });
  it("401 when signed out", async () => {
    const { env } = setup();
    H.uid = null;
    const r = await call(env, "GET", "/api/admin/whoami");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });
});

describe("GET /api/admin/v2/overview", () => {
  it("is admin-only", async () => {
    const { env } = setup();
    H.uid = "bob";
    expect((await call(env, "GET", "/api/admin/v2/overview")).status).toBe(403);
  });

  it("counts events, bookings, revenue (paise), refunds and pending payments admin-wide", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/admin/v2/overview");
    expect(r.status).toBe(200);
    expect(r.body.kpis).toEqual({
      // today: Llive, Ltoday, Ldone (seconds-stored); 7d adds Lweek. Not draft/example/smoke/far.
      events_today: 3, events_7d: 4,
      // today: o1 + o4 (free). 7d adds o2 + o7. o3 refunded and the smoke order never count.
      bookings_today: 2, bookings_7d: 4,
      // today: i1 62700. 7d: + o2 snapshot (1100+198)*100 + i7 62700 (refund only REQUESTED).
      // 30d: + o5 is refunded (refunds row) → excluded; o6 is older than 30 days.
      revenue_today_paise: 62700, revenue_7d_paise: 62700 + 129800 + 62700, revenue_30d_paise: 62700 + 129800 + 62700,
      open_refunds: 1, open_refunds_paise: 62700,
      // ip1 pending in window, ip2 under review. ip3 expired window, ip4 expired, smoke ignored.
      pending_payments: 2, pending_payments_paise: 259600, pending_review: 1,
    });
    expect(Number.isInteger(r.body.kpis.revenue_7d_paise)).toBe(true);
    expect(r.body.windows.today_start).toBe(TODAY);
  });

  it("lists LIVE first, then the soonest upcoming, with booked seats and paise prices", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/admin/v2/overview");
    expect(r.body.next_events.map((e: any) => e.id)).toEqual(["Llive", "Ltoday", "Lweek", "Lfar"]);
    expect(r.body.next_events[0]).toMatchObject({ live: true, status: "live", price_paise: 0, booked: 1 });
    expect(r.body.next_events[1]).toMatchObject({
      live: false, title: "Ganesh Puja", category_label: "Puja", price_paise: 50100, capacity: 50, booked: 2,
      starts_at: NOW + 3 * H1, image_url: "https://img/x.jpg", admin_url: "/admin/events/Ltoday", public_url: "/book/Ltoday",
    });
    // o3 is refunded → Lweek has one booked seat.
    expect(r.body.next_events[2]).toMatchObject({ booked: 1, duration_min: 90 });
  });

  it("an empty database answers zeros, not nulls", async () => {
    const { db, env } = setup();
    db.exec("DELETE FROM listings; DELETE FROM orders; DELETE FROM hdfc_sms_payment_intents; DELETE FROM refunds;");
    const r = await call(env, "GET", "/api/admin/v2/overview");
    expect(r.status).toBe(200);
    expect(Object.values(r.body.kpis).every((v) => v === 0)).toBe(true);
    expect(r.body.next_events).toEqual([]);
  });

  it("a failing query is a tracked 500, not a crash", async () => {
    const { env } = setup();
    env.DB_META = { prepare() { throw new Error("D1 down"); } };
    const r = await call(env, "GET", "/api/admin/v2/overview");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("internal");
    expect(H.exceptions).toBe(1);
  });
});

describe("route table", () => {
  const h = async () => new Response("ok");
  const table: Admin2RouteDef[] = [
    { method: "GET", path: "/api/admin/v2/things", handler: h },
    { method: "GET", path: /^\/api\/admin\/v2\/things\/([^/]+)$/, handler: h },
    { method: "PUT", path: /^\/api\/admin\/v2\/things\/([^/]+)$/, handler: h },
  ];
  it("matches exact paths and decodes regex params", () => {
    expect(matchAdmin2("GET", "/api/admin/v2/things", table)).toMatchObject({ params: [] });
    expect(matchAdmin2("PUT", "/api/admin/v2/things/a%20b", table)).toMatchObject({ params: ["a b"], route: { method: "PUT" } });
  });
  it("405 on a known path with the wrong method, null on an unknown path", async () => {
    expect(matchAdmin2("DELETE", "/api/admin/v2/things/x", table)).toEqual({ methodNotAllowed: true });
    expect(matchAdmin2("GET", "/api/admin/v2/nothing", table)).toBeNull();
    const { env } = setup();
    expect((await call(env, "POST", "/api/admin/v2/overview")).status).toBe(405);
    expect((await call(env, "GET", "/api/admin/v2/unknown")).status).toBe(0);
  });
  it("never matches a regex on a partial path", () => {
    expect(matchAdmin2("GET", "/api/admin/v2/things/x/extra", table)).toBeNull();
  });
});
