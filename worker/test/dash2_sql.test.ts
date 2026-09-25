// [DASH2-API 2026-09-25] The Dashboard 2 read models and the phone swap, run against
// real SQLite (node:sqlite) with the real 2026-09-25 migrations, so the SQL itself is
// exercised: per-account scoping, payment status folding, keyset pagination, and a
// phone change that never leaves an account without a verified phone.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildPaymentsQuery, EVENTS_SQL, phoneSwapStatements } from "../src/lib/me_dashboard_data";
import { encodeCursor } from "../src/lib/me_dashboard_logic";

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
    async batch(stmts: any[]) {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

const NOW = Date.UTC(2026, 8, 25, 6, 0, 0);
const H = 3_600_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (id TEXT PRIMARY KEY, creator_id TEXT, kind TEXT, title TEXT, description TEXT, category TEXT,
      price INTEGER, free_entry INTEGER DEFAULT 0, cover_media TEXT, attrs TEXT, starts_at INTEGER, duration_min INTEGER,
      capacity INTEGER, status TEXT, expires_at INTEGER, is_example INTEGER DEFAULT 0);
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE orders (id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, creator_id TEXT, amount INTEGER, promo_id TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, kind TEXT, fee_pct INTEGER, escrow_account TEXT, booking_id TEXT);
    CREATE TABLE commercial_policy_snapshots (order_id TEXT PRIMARY KEY, gross_amount INTEGER, gst_amount INTEGER);
    CREATE TABLE commercial_sessions (listing_id TEXT, kind TEXT, session_version INTEGER, replay_state TEXT);
    CREATE TABLE users (uid TEXT PRIMARY KEY, phone_hash TEXT, private_number TEXT, updated_at INTEGER);
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT,
      status TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER, verified_at INTEGER);
  `);
  db.exec(mig("contact_verification.sql"));
  db.exec(mig("2026-09-17-hdfc-sms-payments.sql"));
  for (const f of ["refunds", "receipts", "user-profile-extras", "user-addresses", "user-vpas", "push-subscriptions"]) db.exec(mig(`2026-09-25-dash2-${f}.sql`));
  db.exec(`
    INSERT INTO listing_categories VALUES ('puja','Puja',1,1),('havan','Havan',2,1);
    INSERT INTO listings (id,kind,title,category,price,starts_at,duration_min,status) VALUES
      ('L_future','live_event','Ganesh Puja','puja',501,${NOW + 72 * H},60,'published'),
      ('L_soon','live_event','Rudra Havan','havan',1100,${NOW + 2 * H},60,'published'),
      ('L_past','live_event','Old Havan','havan',300,${NOW - 48 * H},60,'completed'),
      ('L_live','live_event','Live Aarti','puja',101,${NOW - 10 * 60_000},60,'live');
    INSERT INTO orders (id,listing_id,buyer_id,amount,status,created_at,kind) VALUES
      ('o1','L_future','alice',501,'held',${NOW - 5 * H},'live_event'),
      ('o2','L_soon','alice',1100,'held',${NOW - 4 * H},'live_event'),
      ('o3','L_past','alice',300,'released',${NOW - 60 * H},'live_event'),
      ('o4','L_live','alice',0,'free',${NOW - 3 * H},'live_event'),
      ('o5','L_future','bob',501,'held',${NOW - 5 * H},'live_event'),
      ('o6','L_past','alice',300,'refunded',${NOW - 70 * H},'live_event');
    INSERT INTO commercial_policy_snapshots VALUES ('o1',531,96);
    INSERT INTO commercial_sessions VALUES ('L_past','live_event',1,'available');
    INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at) VALUES
      ('i1','alice','L_future','live_event',62700,'confirmed','512345678901','o1',${NOW},${NOW - 5 * H},${NOW - 5 * H + 1000}),
      ('i2','alice','L_soon','live_event',110000,'pending',NULL,NULL,${NOW + H},${NOW - H},${NOW - H}),
      ('i3','alice','L_soon','live_event',110000,'pending',NULL,NULL,${NOW - 1},${NOW - 9 * H},${NOW - 9 * H}),
      ('i4','alice','avatok-upi-smoke-2026','live_event',100,'payment_received',NULL,NULL,${NOW + H},${NOW},${NOW});
  `);
  return { raw: db, db: d1(db) };
}

async function payments(db: any, uid: string, f: Parameters<typeof buildPaymentsQuery>[2] = {}) {
  const { sql, binds } = buildPaymentsQuery(uid, NOW, f);
  return (await db.prepare(sql).bind(...binds).all()).results as any[];
}

describe("payments read model", () => {
  it("returns only the caller's paid lines, intents first by id, excluding free/expired/smoke", async () => {
    const { db } = setup();
    const rows = await payments(db, "alice");
    expect(rows.map((r) => r.id).sort()).toEqual(["i1", "i2", "o2", "o3", "o6"]);
    const i1 = rows.find((r) => r.id === "i1");
    expect(i1).toMatchObject({ order_id: "o1", amount_paise: 62700, utr: "512345678901", status: "paid", event_title: "Ganesh Puja" });
    expect(rows.find((r) => r.id === "o2").amount_paise).toBe(110000); // no snapshot -> orders.amount * 100
    expect(rows.find((r) => r.id === "i2").status).toBe("pending");
    expect(rows.find((r) => r.id === "o6").status).toBe("refunded");
    expect((await payments(db, "bob")).map((r) => r.id)).toEqual(["o5"]);
  });
  it("uses gross + GST from the policy snapshot when there is no UPI intent", async () => {
    const { raw, db } = setup();
    raw.exec("DELETE FROM hdfc_sms_payment_intents WHERE intent_id='i1'");
    expect((await payments(db, "alice", { id: "o1" }))[0].amount_paise).toBe(62700);
  });
  it("folds refund requests into status and filters by status", async () => {
    const { raw, db } = setup();
    raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r1','i1','alice',62700,'requested',${NOW})`);
    expect((await payments(db, "alice", { id: "i1" }))[0].status).toBe("refund_requested");
    expect((await payments(db, "alice", { status: "refund_requested" })).map((r) => r.id)).toEqual(["i1"]);
    // Another account's refund row never leaks into alice's lines.
    raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r2','o2','bob',1,'refunded',${NOW})`);
    expect((await payments(db, "alice", { id: "o2" }))[0].status).toBe("paid");
  });
  it("one open refund per payment is enforced by the index", () => {
    const { raw } = setup();
    raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r1','i1','alice',1,'requested',1)`);
    expect(() => raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r2','i1','alice',1,'requested',2)`)).toThrow(/UNIQUE/);
    raw.exec(`UPDATE refunds SET status='rejected' WHERE id='r1'`);
    raw.exec(`INSERT INTO refunds (id,payment_id,uid,amount_paise,status,requested_at) VALUES ('r3','i1','alice',1,'requested',3)`);
  });
  it("filters: text, category, amount (paise), event window", async () => {
    const { db } = setup();
    expect((await payments(db, "alice", { q: "rudra" })).map((r) => r.id).sort()).toEqual(["i2", "o2"]);
    expect((await payments(db, "alice", { q: "512345" })).map((r) => r.id)).toEqual(["i1"]);
    expect((await payments(db, "alice", { cat: "puja" })).map((r) => r.id)).toEqual(["i1"]);
    expect((await payments(db, "alice", { minPaise: 100000 })).map((r) => r.id).sort()).toEqual(["i2", "o2"]);
    expect((await payments(db, "alice", { eventFrom: NOW, eventTo: NOW + 3 * H })).map((r) => r.id).sort()).toEqual(["i2", "o2"]);
  });
  it("keyset pagination walks every row exactly once", async () => {
    const { db } = setup();
    const all = await payments(db, "alice");
    const seen: string[] = []; let cursor: any = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await payments(db, "alice", { cursor, limit: 2 });
      seen.push(...page.map((r) => r.id));
      if (page.length < 2) break;
      const last = page[page.length - 1];
      cursor = { t: last.sort_ts, id: last.id };
      expect(encodeCursor(cursor)).toBeTruthy();
    }
    expect(seen).toEqual(all.map((r) => r.id));
  });
});

describe("events read model", () => {
  it("lists the caller's seats (paid, free) and live pending intents, not refunded ones", async () => {
    const { db } = setup();
    const rows = (await db.prepare(EVENTS_SQL).bind("alice", NOW).all()).results as any[];
    expect(rows.map((r) => r.order_id ?? r.payment_id).sort()).toEqual(["i2", "o1", "o2", "o3", "o4"]);
    // payment_id matches the Billing line id; a free seat has none.
    expect(rows.find((r) => r.order_id === "o1").payment_id).toBe("i1");
    expect(rows.find((r) => r.order_id === "o4").payment_id).toBeNull();
    expect(rows.find((r) => r.order_id === "o3").replay_state).toBe("available");
    expect(rows.find((r) => r.payment_id === "i2").paid).toBe(0);
  });
});

describe("receipt numbering", () => {
  it("numbers per year and never twice for one payment", async () => {
    const { db } = setup();
    const ins = (id: string, pid: string) => db.prepare(
      `INSERT INTO receipts (id,payment_id,uid,receipt_no,r2_key,created_at)
       SELECT ?1, ?2, ?3, 'SH-'||?4||'-'||printf('%06d', COALESCE(MAX(CAST(substr(receipt_no,9) AS INTEGER)),0)+1),
              'receipts/'||?3||'/'||'SH-'||?4||'-'||printf('%06d', COALESCE(MAX(CAST(substr(receipt_no,9) AS INTEGER)),0)+1)||'.pdf', ?5
         FROM receipts WHERE receipt_no LIKE 'SH-'||?4||'-%'
       ON CONFLICT(payment_id) DO NOTHING`).bind(id, pid, "alice", "2026", NOW).run();
    await ins("a", "i1"); await ins("b", "o2"); await ins("c", "i1");
    const rows = (await db.prepare("SELECT payment_id, receipt_no, r2_key FROM receipts ORDER BY receipt_no").all()).results;
    expect(rows).toEqual([
      { payment_id: "i1", receipt_no: "SH-2026-000001", r2_key: "receipts/alice/SH-2026-000001.pdf" },
      { payment_id: "o2", receipt_no: "SH-2026-000002", r2_key: "receipts/alice/SH-2026-000002.pdf" },
    ]);
  });
});

describe("phone swap — never zero phones", () => {
  const verifiedPhones = (raw: any, uid: string) =>
    raw.prepare("SELECT phone_hash FROM contact_verification WHERE uid=? AND phone_verified=1").all(uid) as any[];

  it("replaces the old number in one transaction", async () => {
    const { raw, db } = setup();
    raw.exec(`INSERT INTO contact_verification (uid,phone_verified,phone_hash,updated_at) VALUES ('alice',1,'old',1);
              INSERT INTO users VALUES ('alice','old','+919800000001',1);
              INSERT INTO phone_otp (uid,phone_hash,e164,session_id,status,created_at) VALUES ('alice','new','+919800000002','s','sent',${NOW})`);
    await db.batch(phoneSwapStatements(db, { uid: "alice", otpId: 1, hash: "new", e164: "+919800000002", now: NOW }));
    expect(verifiedPhones(raw, "alice")).toEqual([{ phone_hash: "new" }]);
    expect(raw.prepare("SELECT phone_hash, private_number FROM users WHERE uid='alice'").get()).toEqual({ phone_hash: "new", private_number: "+919800000002" });
    expect(raw.prepare("SELECT status FROM phone_otp WHERE id=1").get()).toEqual({ status: "verified" });
  });

  it("a failure mid-swap rolls back: the old phone stays verified", async () => {
    const { raw, db } = setup();
    raw.exec(`INSERT INTO contact_verification (uid,phone_verified,phone_hash,updated_at) VALUES ('alice',1,'old',1)`);
    raw.exec("DROP TABLE users"); // the third statement now fails
    await expect(db.batch(phoneSwapStatements(db, { uid: "alice", otpId: 1, hash: "new", e164: "+919800000002", now: NOW }))).rejects.toThrow();
    expect(verifiedPhones(raw, "alice")).toEqual([{ phone_hash: "old" }]);
  });

  it("the swap statements contain no DELETE", () => {
    const sqls: string[] = [];
    const spy: any = { prepare: (s: string) => { sqls.push(s); return { bind: () => ({}) }; } };
    phoneSwapStatements(spy, { uid: "u", otpId: 1, hash: "h", e164: "+91", now: 1 });
    expect(sqls.some((s) => /\bDELETE\b/i.test(s))).toBe(false);
    expect(sqls.length).toBe(3);
  });
});
