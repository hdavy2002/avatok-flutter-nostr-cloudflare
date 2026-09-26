// [ADMIN2-PEOPLE 2026-09-26] Admin 2 bookings / payments / customers, run through the real
// dispatcher (routes/admin2_people.ts) against real SQLite (node:sqlite) with the real
// migrations. Auth, telemetry and the Clerk email lookup are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "admin1" as string | null, exceptions: 0, emailCalls: 0 }));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  trackUser: async () => {},
  trackException: async () => { H.exceptions++; },
}));
vi.mock("../src/lib/identity", () => ({ emailFor: async (_env: unknown, uid: string) => { H.emailCalls++; return uid === "nomail" ? null : `${uid}@example.com`; } }));

import { admin2PeopleRoute } from "../src/routes/admin2_people";
import { admin2Route } from "../src/routes/admin2";
import { sha256Hex } from "../src/util";
import { classifyQuery, csvCell, csvFilename, csvIst, csvRupees, toCsv, phoneView } from "../src/lib/admin2_people_data";

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

const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
const H1 = 3_600_000;

async function setup() {
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
  for (const f of ["refunds", "user-profile-extras", "user-addresses", "user-vpas"]) db.exec(mig(`2026-09-25-dash2-${f}.sql`));
  const bobHash = await sha256Hex("+919812345678");
  const aliceEmail = await sha256Hex("alice@example.com");
  db.exec(`
    INSERT INTO listing_categories VALUES ('puja','Puja',1,1),('havan','Havan',2,1);
    INSERT INTO listings (id,kind,title,category,price,starts_at,duration_min,capacity,status) VALUES
      ('L1','live_event','Ganesh Puja','puja',501,${NOW + 72 * H1},60,100,'published'),
      ('L2','live_event','Rudra Havan, "special"','havan',1100,${Math.floor((NOW + 96 * H1) / 1000)},60,NULL,'published'),
      ('avatok-upi-smoke-2026','live_event','Smoke','puja',1,${NOW},10,NULL,'published'),
      ('G1','goods','Old goods listing','puja',50,NULL,NULL,NULL,'published');
    INSERT INTO users (uid,display_name,first_name,last_name,email_hash,phone_hash,private_number,created_at) VALUES
      ('alice','Alice Devi',NULL,NULL,'${aliceEmail}',NULL,NULL,${NOW - 900 * H1}),
      ('bob',NULL,'Bob','Kumar',NULL,'${bobHash}',NULL,${NOW - 800 * H1}),
      ('carol',NULL,NULL,NULL,NULL,NULL,'+919000011234',${NOW - 700 * H1}),
      ('dave','=cmd|calc',NULL,NULL,NULL,NULL,NULL,${NOW - 10 * H1}),
      ('nomail','Lurker',NULL,NULL,NULL,NULL,NULL,${NOW - 5 * H1});
    INSERT INTO phone_otp (uid,phone_hash,e164,status,created_at,verified_at) VALUES
      ('alice','h','+919876543210','verified',${NOW - 100 * H1},${NOW - 100 * H1}),
      ('alice','h2','+919999999999','sent',${NOW - 1 * H1},NULL);
    INSERT INTO contact_verification (uid,phone_verified,phone_hash,updated_at) VALUES ('alice',1,'h',${NOW});
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','L1','alice',501,'held',${NOW - 5 * H1},'live_event'),
      ('o2','L2','bob',1100,'held',${NOW - 4 * H1},'live_event'),
      ('o3','L2','carol',1100,'refunded',${NOW - 6 * H1},'live_event'),
      ('o4','L1','carol',0,'free',${NOW - 3 * H1},'live_event'),
      ('o5','avatok-upi-smoke-2026','alice',1,'held',${NOW - 2 * H1},'live_event'),
      ('o6','G1','bob',50,'held',${NOW - 7 * H1},'goods'),
      ('o7','L1','dave',501,'released',${NOW - 8 * H1},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o2',1100,198);
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','L1','live_event',62700,'confirmed','512345678901','o1',${NOW},${NOW - 5 * H1},${NOW - 5 * H1 + 1000}),
      ('i2','bob','L1','live_event',62700,'payment_received','UTR55501',NULL,${NOW + H1},${NOW - 1 * H1},${NOW - 1 * H1}),
      ('i3','bob','L1','live_event',62700,'expired',NULL,NULL,${NOW - H1},${NOW - 30 * H1},${NOW - 29 * H1});
    INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,refund_vpa,refund_utr,requested_at,refunded_at,admin_uid) VALUES
      ('r1','i1','alice',62700,'Travelling','requested','alice@okhdfc',NULL,${NOW - 2 * H1},NULL,NULL),
      ('r3','o3','carol',100000,'Changed plans','refunded','carol@ybl','UTR998877',${NOW - 5 * H1},${NOW - 4 * H1},'admin1');
    INSERT INTO user_profile_extras (uid,gotra,family_json,language,updated_at) VALUES ('alice','Kashyap','["Ravi"]','hi',${NOW});
    INSERT INTO user_addresses (uid,name,line1,city,state,pin,country,updated_at) VALUES ('alice','Alice Devi','12 MG Road','Dehradun','Uttarakhand','248001','India',${NOW});
    INSERT INTO user_vpas (id,uid,vpa,is_default,created_at) VALUES ('v1','alice','alice@okhdfc',1,${NOW});
  `);
  return { raw: db, env: { DB_META: d1(db), ADMIN_UIDS: "admin1" } as any };
}

const call = async (env: any, path: string) => {
  const url = `https://api.test${path}`;
  const req = new Request(url, { method: "GET", headers: { authorization: "Bearer t" } });
  const res = await admin2PeopleRoute(req, env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any, res: null as Response | null, text: "" };
  // ignoreBOM keeps the UTF-8 BOM the CSV starts with (Response.text() strips it).
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  let body: any = null; try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body, res, text };
};

beforeEach(() => { H.uid = "admin1"; H.exceptions = 0; H.emailCalls = 0; vi.spyOn(Date, "now").mockReturnValue(NOW); });

describe("admin guard and routing", () => {
  it("is admin-only on every route", async () => {
    const { env } = await setup();
    H.uid = "alice";
    for (const p of ["/api/admin/v2/bookings", "/api/admin/v2/payments", "/api/admin/v2/customers", "/api/admin/v2/customers/alice"]) {
      const r = await call(env, p);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("admin_only");
    }
    H.uid = null;
    expect((await call(env, "/api/admin/v2/bookings")).status).toBe(401);
  });
  it("is registered in the Admin 2 dispatcher", async () => {
    const { env } = await setup();
    const req = new Request("https://api.test/api/admin/v2/customers/alice", { headers: { authorization: "Bearer t" } });
    const res = await admin2Route(req, env, "/api/admin/v2/customers/alice");
    expect(res?.status).toBe(200);
    const b = await admin2Route(new Request("https://api.test/api/admin/v2/bookings", { headers: { authorization: "Bearer t" } }), env, "/api/admin/v2/bookings");
    expect(((await b!.json()) as any).items).toHaveLength(6);
  });
  it("ignores paths it does not own", async () => {
    const { env } = await setup();
    expect((await call(env, "/api/admin/v2/overview")).status).toBe(0);
    expect((await call(env, "/api/admin/v2/customers/a/b")).status).toBe(0);
  });
});

describe("GET /api/admin/v2/bookings", () => {
  it("lists every seat: paid, free, pending and refunded; not expired intents, the smoke listing or non-events", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings");
    expect(r.status).toBe(200);
    // newest first by booked_at
    expect(r.body.items.map((i: any) => i.id)).toEqual(["i2", "o4", "o2", "i1", "o3", "o7"]);
    const byId = Object.fromEntries(r.body.items.map((i: any) => [i.id, i]));
    expect(byId.i1).toMatchObject({ order_id: "o1", status: "refund_requested", amount_paise: 62700, utr: "512345678901",
      event_title: "Ganesh Puja", customer: { uid: "alice", name: "Alice Devi", email: "alice@example.com", phone_masked: "+91 98•••••210", phone_hash_only: false } });
    expect(byId.o2).toMatchObject({ status: "paid", amount_paise: 129800, customer: { name: "Bob Kumar", phone_masked: null, phone_hash_only: true } });
    expect(byId.o4).toMatchObject({ status: "free", amount_paise: 0, customer: { phone_masked: "+91 90•••••234" } });
    expect(byId.i2).toMatchObject({ status: "pending", order_id: null, intent_status: "payment_received", utr: "UTR55501" });
    expect(byId.o3).toMatchObject({ status: "refunded" });
    // seconds-stored starts_at normalised to ms
    expect(byId.o2.event_starts_at).toBe(Math.floor((NOW + 96 * H1) / 1000) * 1000);
    expect(r.body.totals).toMatchObject({ bookings: 6, seats: 4, paid_seats: 3, free_seats: 1, pending: 1, refunded: 1,
      revenue_paise: 62700 + 129800 + 50100, pending_paise: 62700 });
  });
  it("?event= adds the event header and totals for that event", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings?event=L1");
    expect(r.body.items.map((i: any) => i.id).sort()).toEqual(["i1", "i2", "o4", "o7"]);
    expect(r.body.event).toMatchObject({ id: "L1", title: "Ganesh Puja", capacity: 100, price_paise: 50100, starts_at: NOW + 72 * H1 });
    expect(r.body.totals).toMatchObject({ seats: 3, pending: 1, revenue_paise: 62700 + 50100 });
  });
  it("filters by status and booked-at range", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings?status=paid,free");
    expect(r.body.items.map((i: any) => i.id)).toEqual(["o4", "o2", "o7"]);
    expect((await call(env, "/api/admin/v2/bookings?uid=carol")).body.items.map((i: any) => i.id)).toEqual(["o4", "o3"]);
    const t = await call(env, `/api/admin/v2/bookings?from=${NOW - 4.5 * H1}&to=${NOW - 2 * H1}`);
    expect(t.body.items.map((i: any) => i.id)).toEqual(["o4", "o2"]);
  });
  it("searches name, phone last-4, exact email (hash), full phone (hash-only account), UTR and ids", async () => {
    const { env } = await setup();
    const ids = async (q: string) => (await call(env, `/api/admin/v2/bookings?q=${encodeURIComponent(q)}`)).body.items.map((i: any) => i.id).sort();
    expect(await ids("alice dev")).toEqual(["i1"]);
    expect(await ids("3210")).toEqual(["i1"]);
    // last-4 of carol's readable number, plus i1 whose UTR 512345678901 contains "1234"
    expect(await ids("1234")).toEqual(["i1", "o3", "o4"]);
    expect(await ids("ALICE@example.com")).toEqual(["i1"]);
    expect(await ids("alice@exam")).toEqual([]); // partial emails cannot match a hash
    expect(await ids("98123 45678")).toEqual(["i2", "o2"]);
    expect(await ids("555")).toEqual(["i2"]);
    expect(await ids("o7")).toEqual(["o7"]);
    expect(await ids("%")).toEqual([]);
  });
  it("rejects a bad cursor", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings?cursor=nope!");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_cursor");
  });
  it("exports RFC 4180 CSV with plain rupees, IST times and a sensible filename", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings?format=csv&event=L2");
    expect(r.status).toBe(200);
    expect(r.res!.headers.get("content-type")).toMatch(/^text\/csv; charset=utf-8/);
    expect(r.res!.headers.get("content-disposition")).toBe('attachment; filename="saathum-bookings-2026-09-26-event-L2.csv"');
    expect(r.res!.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.text.startsWith("﻿Booking ID,Order ID,Booked at (IST)")).toBe(true);
    expect(r.text.endsWith("\r\n")).toBe(true);
    const lines = r.text.slice(1).split("\r\n");
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty
    expect(lines[1]).toBe(`o2,o2,${csvIst(NOW - 4 * H1)},paid,"Rudra Havan, ""special""",L2,${csvIst(Math.floor((NOW + 96 * H1) / 1000) * 1000)},Bob Kumar,bob@example.com,on file (hash only),1298.00,,bob`);
    expect(lines[2]).toContain(",refunded,");
    expect(r.res!.headers.get("x-export-rows")).toBe("2");
  });
  it("neutralises spreadsheet formulas in exported text", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/bookings?format=csv&q=o7");
    expect(r.text).toContain(",'=cmd|calc,");
  });
});

describe("GET /api/admin/v2/payments", () => {
  it("lists money lines admin-wide with totals for the filtered set", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/payments");
    expect(r.status).toBe(200);
    // free seat o4, expired i3 and smoke o5 are not payments; the goods order o6 is.
    expect(r.body.items.map((i: any) => i.id).sort()).toEqual(["i1", "i2", "o2", "o3", "o6", "o7"]);
    const i1 = r.body.items.find((i: any) => i.id === "i1");
    expect(i1).toMatchObject({ status: "refund_requested", paid_at: NOW - 5 * H1 + 1000, refund: { status: "requested" },
      customer: { email: "alice@example.com", phone_masked: "+91 98•••••210" } });
    const o3 = r.body.items.find((i: any) => i.id === "o3");
    expect(o3).toMatchObject({ status: "refunded", amount_paise: 110000, refund: { status: "refunded", amount_paise: 100000 } });
    expect(r.body.totals).toMatchObject({
      count: 6, pending_count: 1, refunded_count: 1, paid_count: 4,
      collected_paise: 62700 + 129800 + 5000 + 50100, pending_paise: 62700, refund_requested_paise: 62700, refunded_paise: 100000,
    });
    expect(r.body.categories).toEqual([{ id: "puja", label: "Puja" }, { id: "havan", label: "Havan" }]);
  });
  it("filters by status, category, amount range and paid range; totals follow the filter", async () => {
    const { env } = await setup();
    const a = await call(env, "/api/admin/v2/payments?status=paid&cat=puja&min=500&max=502");
    expect(a.body.items.map((i: any) => i.id)).toEqual(["o7"]);
    expect(a.body.totals).toMatchObject({ count: 1, collected_paise: 50100 });
    const b = await call(env, `/api/admin/v2/payments?paid_from=${NOW - 4.5 * H1}&paid_to=${NOW}`);
    expect(b.body.items.map((i: any) => i.id)).toEqual(["i2", "o2"]);
  });
  it("keyset pagination walks every line exactly once", async () => {
    const { raw, env } = await setup();
    const stmt = raw.prepare("INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES (?,?,?,?,?,?,?)");
    for (let i = 0; i < 120; i++) stmt.run(`bulk${String(i).padStart(3, "0")}`, "L1", "carol", 501, "held", NOW - 50 * H1 - (i % 7) * 1000, "live_event");
    const seen: string[] = [];
    let cursor: string | undefined; let pages = 0;
    do {
      const r = await call(env, `/api/admin/v2/payments${cursor ? `?cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      if (pages === 0) expect(r.body.totals.count).toBe(126); else expect(r.body.totals).toBeUndefined();
      seen.push(...r.body.items.map((i: any) => i.id));
      cursor = r.body.next_cursor; pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(126);
    expect(new Set(seen).size).toBe(126);
  });
  it("exports CSV with plain rupees and a refunded column", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/payments?format=csv&status=refunded");
    expect(r.res!.headers.get("content-disposition")).toBe('attachment; filename="saathum-payments-2026-09-26.csv"');
    const lines = r.text.slice(1).split("\r\n");
    expect(lines[0]).toBe("Payment ID,Order ID,Paid at (IST),Status,Amount (INR),Refunded (INR),UTR,Event,Event ID,Category,Event starts (IST),Customer,Email,Phone (masked),Customer ID");
    expect(lines[1].split(",").slice(0, 6)).toEqual(["o3", "o3", csvIst(NOW - 6 * H1), "refunded", "1100.00", "1000.00"]);
  });
});

describe("customers", () => {
  it("lists booked customers (most recent activity first) and searches every account", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/customers");
    expect(r.body.items.map((i: any) => i.uid)).toEqual(["bob", "carol", "alice", "dave"]);
    const bob = r.body.items[0];
    expect(bob).toMatchObject({ name: "Bob Kumar", email: "bob@example.com", phone_masked: null, phone_hash_only: true, bookings: 2, paid_paise: 129800 });
    expect(r.body.search).toBeNull();
    const s = await call(env, "/api/admin/v2/customers?q=lurk");
    expect(s.body.items.map((i: any) => i.uid)).toEqual(["nomail"]);
    expect(s.body.items[0]).toMatchObject({ email: null, bookings: 0 });
    expect((await call(env, "/api/admin/v2/customers?q=1234")).body.items.map((i: any) => i.uid)).toEqual(["carol"]);
    expect((await call(env, "/api/admin/v2/customers?q=%2B91%2098123%2045678")).body.items.map((i: any) => i.uid)).toEqual(["bob"]);
    expect((await call(env, "/api/admin/v2/customers?q=alice%40example.com")).body.items.map((i: any) => i.uid)).toEqual(["alice"]);
    expect((await call(env, "/api/admin/v2/customers?q=alice%40example.com")).body.search).toMatchObject({ kind: "email", email_exact_only: true });
  });
  it("returns the profile with bookings, payments and refunds", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/customers/alice");
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({
      uid: "alice", name: "Alice Devi", email: "alice@example.com", gotra: "Kashyap", language: "hi", family: ["Ravi"],
      phone: { masked: "+91 98•••••210", verified: true, hash_only: false },
      vpas: [{ id: "v1", vpa: "alice@okhdfc", is_default: true }],
      address: { line1: "12 MG Road", city: "Dehradun", pin: "248001" },
    });
    expect(r.body.bookings.map((b: any) => b.id)).toEqual(["i1"]);
    expect(r.body.payments.map((p: any) => p.id)).toEqual(["i1"]);
    expect(r.body.payment_totals).toMatchObject({ count: 1, refund_requested_paise: 62700 });
    expect(r.body.refunds).toMatchObject([{ refund_id: "r1", status: "requested", amount_paise: 62700, payer_utr: "512345678901" }]);
    const bob = await call(env, "/api/admin/v2/customers/bob");
    expect(bob.body.profile.phone).toEqual({ masked: null, verified: false, hash_only: true });
    expect(bob.body.bookings.map((b: any) => b.id)).toEqual(["i2", "o2"]);
  });
  it("404s an unknown customer", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/admin/v2/customers/ghost");
    expect(r.status).toBe(404);
  });
});

describe("pure helpers", () => {
  it("csvCell follows RFC 4180 and blocks formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+91 98•••••210")).toBe("'+91 98•••••210");
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('﻿a,b\r\n1,"x,y"\r\n');
  });
  it("csvRupees is plain rupees with two decimals", () => {
    expect(csvRupees(62700)).toBe("627.00");
    expect(csvRupees(129850)).toBe("1298.50");
    expect(csvRupees(5)).toBe("0.05");
    expect(csvRupees(0)).toBe("0.00");
    expect(csvRupees(null)).toBe("");
  });
  it("csvIst and csvFilename", () => {
    expect(csvIst(Date.UTC(2026, 8, 26, 12, 0))).toBe("2026-09-26 17:30");
    expect(csvIst(null)).toBe("");
    expect(csvFilename("payments", Date.UTC(2026, 8, 26, 20, 0), "event-L 1/../x")).toBe("saathum-payments-2026-09-27-event-L-1-x.csv");
  });
  it("classifyQuery and phoneView", () => {
    expect(classifyQuery(" a@b.co ").kind).toBe("email");
    expect(classifyQuery("1234").kind).toBe("last4");
    expect(classifyQuery("+91 98123-45678").kind).toBe("phone");
    expect(classifyQuery("Ganesh").kind).toBe("text");
    expect(classifyQuery("").kind).toBe("empty");
    expect(phoneView({ phone_e164: null, phone_hash: "h" })).toEqual({ masked: null, hash_only: true });
    expect(phoneView({ phone_e164: null, phone_hash: null })).toEqual({ masked: null, hash_only: false });
  });
});
