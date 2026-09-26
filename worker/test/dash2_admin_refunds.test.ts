// [DASH2-ADMIN-REFUNDS 2026-09-26] The admin refunds queue and the reject action,
// run through the real Dashboard 2 dispatcher against real SQLite (node:sqlite) with
// the real 2026-09-25 migrations. Auth, telemetry and the Clerk email lookup are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "admin1", events: [] as Array<{ uid: string; event: string; props: any }>, exceptions: 0 }));
vi.mock("../src/authz", () => ({
  requireUser: async () => (H.uid ? { uid: H.uid } : { error: "unauthorized", status: 401 }),
  isFail: (v: any) => Boolean(v?.error),
}));
vi.mock("../src/hooks", () => ({
  trackUser: async (_env: unknown, uid: string, _email: unknown, event: string, _app: string, props: any) => { H.events.push({ uid, event, props }); },
  trackException: async () => { H.exceptions++; },
}));
vi.mock("../src/lib/identity", () => ({ emailFor: async (_env: unknown, uid: string) => `${uid}@example.com` }));

import { meDashboardRoute } from "../src/routes/me_dashboard";
import { buildAdminRefundsQuery, decodeRefundCursor, encodeRefundCursor, parseRefundStatus } from "../src/lib/admin_refunds_data";

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

const NOW = Date.UTC(2026, 8, 26, 6, 0, 0);
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
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, first_name TEXT, last_name TEXT, email_hash TEXT);
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER, active INTEGER DEFAULT 1);
  `);
  db.exec(mig("2026-09-17-hdfc-sms-payments.sql"));
  db.exec(mig("2026-09-25-dash2-refunds.sql"));
  db.exec(`
    INSERT INTO listings (id,kind,title,category,price,starts_at,duration_min,status) VALUES
      ('L1','live_event','Ganesh Puja','puja',501,${NOW + 72 * H1},60,'published'),
      ('L2','live_event','Rudra Havan','havan',1100,${Math.floor((NOW + 96 * H1) / 1000)},60,'published');
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','L1','alice',501,'held',${NOW - 5 * H1},'live_event'),
      ('o2','L2','bob',1100,'held',${NOW - 4 * H1},'live_event'),
      ('o3','L2','carol',1100,'held',${NOW - 4 * H1},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o2',1100,198);
    INSERT INTO users (uid,display_name,first_name,last_name,email_hash) VALUES
      ('alice','Alice Devi',NULL,NULL,'hash-alice'),('bob',NULL,'Bob','Kumar',NULL),('carol',NULL,NULL,NULL,NULL);
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','L1','live_event',62700,'confirmed','512345678901','o1',${NOW},${NOW - 5 * H1},${NOW - 5 * H1 + 1000});
    INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,refund_vpa,refund_utr,requested_at,refunded_at,admin_uid) VALUES
      ('r1','i1','alice',62700,'Travelling','requested','alice@okhdfc',NULL,${NOW - 2 * H1},NULL,NULL),
      ('r2','o2','bob',129800,NULL,'requested',NULL,NULL,${NOW - 3 * H1},NULL,NULL),
      ('r3','o3','carol',110000,'Changed plans','refunded','carol@ybl','UTR998877',${NOW - 9 * H1},${NOW - 8 * H1},'admin1'),
      ('r4','o3','carol',110000,'First try','rejected',NULL,NULL,${NOW - 20 * H1},NULL,'admin1');
  `);
  const wallet = new DatabaseSync(":memory:");
  wallet.exec("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, meta TEXT, created_at INTEGER NOT NULL)");
  const env: any = { DB_META: d1(db), DB_WALLET: d1(wallet), ADMIN_UIDS: "admin1" };
  return { raw: db, wallet, env };
}

const call = async (env: any, method: string, path: string, body?: unknown) => {
  const url = `https://api.test${path}`;
  const req = new Request(url, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await meDashboardRoute(req, env, new URL(url).pathname);
  if (!res) return { status: 0, body: null as any };
  return { status: res.status, body: await res.json() as any };
};

beforeEach(() => { H.uid = "admin1"; H.events = []; H.exceptions = 0; vi.spyOn(Date, "now").mockReturnValue(NOW); });

describe("GET /api/admin/refunds", () => {
  it("is admin-only", async () => {
    const { env } = setup();
    H.uid = "alice";
    const r = await call(env, "GET", "/api/admin/refunds/");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("admin_only");
  });
  it("defaults to requested, oldest first, with customer, event, amount paid and payer UTR", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/admin/refunds/");
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.refund_id)).toEqual(["r2", "r1"]);
    const r1 = r.body.items[1];
    expect(r1).toMatchObject({
      payment_id: "i1", order_id: "o1", amount_paise: 62700, payer_utr: "512345678901", reason: "Travelling",
      status: "requested", event_title: "Ganesh Puja", event_starts_at: NOW + 72 * H1, refund_vpa: "alice@okhdfc",
      customer: { uid: "alice", email: "alice@example.com", name: "Alice Devi" },
    });
    // Order id payment: amount = gross + GST from the snapshot; starts_at stored in seconds is normalised to ms.
    expect(r.body.items[0]).toMatchObject({ amount_paise: 129800, payer_utr: null, event_starts_at: Math.floor((NOW + 96 * H1) / 1000) * 1000,
      customer: { uid: "bob", name: "Bob Kumar" } });
    expect(r.body.counts).toEqual({ requested: 2, refunded: 1, rejected: 1 });
  });
  it("also answers without the trailing slash", async () => {
    const { env } = setup();
    expect((await call(env, "GET", "/api/admin/refunds?status=refunded")).body.items.map((i: any) => i.refund_id)).toEqual(["r3"]);
  });
  it("status=all puts requested first, then the rest oldest first", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/admin/refunds/?status=all");
    expect(r.body.items.map((i: any) => i.refund_id)).toEqual(["r2", "r1", "r4", "r3"]);
    expect(r.body.items[3]).toMatchObject({ refund_utr: "UTR998877", refunded_at: NOW - 8 * H1, refund_vpa: "carol@ybl" });
  });
  it("rejects a bad status or cursor", async () => {
    const { env } = setup();
    expect((await call(env, "GET", "/api/admin/refunds/?status=paid")).status).toBe(400);
    expect((await call(env, "GET", "/api/admin/refunds/?cursor=zzz")).status).toBe(400);
  });
  it("searches title, name, UTRs, id prefixes and exact email hash", async () => {
    const { env } = setup();
    const ids = async (q: string) => (await call(env, "GET", `/api/admin/refunds/?status=all&q=${encodeURIComponent(q)}`)).body.items.map((i: any) => i.refund_id);
    expect(await ids("ganesh")).toEqual(["r1"]);
    expect(await ids("kumar")).toEqual(["r2"]);
    expect(await ids("51234")).toEqual(["r1"]);
    expect(await ids("utr998")).toEqual(["r3"]);
    expect(await ids("o3")).toEqual(["r4", "r3"]);
    expect(await ids("%")).toEqual([]);
  });
  it("keyset pagination walks every row exactly once across the requested/other boundary", async () => {
    const { raw } = setup();
    const db = d1(raw);
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof decodeRefundCursor>;
    for (let guard = 0; guard < 10; guard++) {
      const { sql, binds } = buildAdminRefundsQuery({ status: "all", cursor, limit: 2 });
      const rows = (await db.prepare(sql).bind(...binds).all()).results as any[];
      const page = rows.slice(0, 1);
      seen.push(...page.map((r) => r.refund_id));
      if (rows.length < 2) break;
      cursor = decodeRefundCursor(encodeRefundCursor({ g: page[0].grp ? 1 : 0, t: page[0].requested_at, id: page[0].refund_id }));
    }
    expect(seen).toEqual(["r2", "r1", "r4", "r3"]);
  });
  it("parses status", () => {
    expect(parseRefundStatus(null)).toBe("requested");
    expect(parseRefundStatus("ALL")).toBe("all");
    expect(parseRefundStatus("nope")).toBeNull();
  });
});

describe("POST /api/admin/refunds/:refund_id/reject", () => {
  it("rejects an open request, audits the note and emits admin_refund_rejected", async () => {
    const { raw, wallet, env } = setup();
    const r = await call(env, "POST", "/api/admin/refunds/r1/reject", { note: "  Event already started for you  " });
    expect(r).toEqual({ status: 200, body: { ok: true, refund: { id: "r1", payment_id: "i1", status: "rejected" } } });
    expect(raw.prepare("SELECT status, admin_uid, refunded_at FROM refunds WHERE id='r1'").get()).toMatchObject({ status: "rejected", admin_uid: "admin1", refunded_at: null });
    const audit = wallet.prepare("SELECT * FROM admin_audit").all() as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ admin_id: "admin1", action: "refund_request_rejected", target: "i1" });
    expect(JSON.parse(audit[0].meta)).toMatchObject({ refund_id: "r1", note: "Event already started for you" });
    expect(H.events).toEqual([{ uid: "alice", event: "admin_refund_rejected", props: expect.objectContaining({ refund_id: "r1", has_note: true, admin_uid: "admin1" }) }]);
    // The customer may ask again after a rejection (partial unique index).
    raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r5','i1','alice',62700,'requested',${NOW})`);
  });
  it("works without a note", async () => {
    const { env } = setup();
    const r = await call(env, "POST", "/api/admin/refunds/r2/reject", {});
    expect(r.status).toBe(200);
    expect(H.events[0].props).toMatchObject({ has_note: false, note_len: 0 });
  });
  it("refuses refunded, already-rejected and unknown requests, and non-admins", async () => {
    const { env } = setup();
    expect((await call(env, "POST", "/api/admin/refunds/r3/reject", {})).body.error).toBe("already_refunded");
    expect((await call(env, "POST", "/api/admin/refunds/r4/reject", {})).body.error).toBe("already_rejected");
    expect((await call(env, "POST", "/api/admin/refunds/nope/reject", {})).status).toBe(404);
    expect((await call(env, "POST", "/api/admin/refunds/r1/reject", { note: 5 })).body.error).toBe("invalid_note");
    H.uid = "bob";
    expect((await call(env, "POST", "/api/admin/refunds/r1/reject", {})).status).toBe(403);
    expect(H.events).toEqual([]);
  });
  it("keeps the rejection when the audit write fails, and reports it", async () => {
    const { raw, env } = setup();
    env.DB_WALLET = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("wallet down"); } }) }) };
    expect((await call(env, "POST", "/api/admin/refunds/r1/reject", {})).status).toBe(200);
    expect(raw.prepare("SELECT status FROM refunds WHERE id='r1'").get().status).toBe("rejected");
    expect(H.exceptions).toBe(1);
  });
});

describe("POST /api/admin/refunds/:payment_id still records a refund", () => {
  it("routes the record action, not the reject action, for a bare id", async () => {
    const { raw, env } = setup();
    const r = await call(env, "POST", "/api/admin/refunds/i1", { refund_utr: "HDFC123456", amount_paise: 62700, refund_vpa: "alice@okhdfc" });
    expect(r.status).toBe(200);
    expect(raw.prepare("SELECT status, refund_utr FROM refunds WHERE id='r1'").get()).toMatchObject({ status: "refunded", refund_utr: "HDFC123456" });
  });
});
