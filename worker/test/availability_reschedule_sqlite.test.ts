import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "buyer" }));
vi.mock("../src/authz", () => ({
  requireUser: async () => ({ uid: H.uid }),
  isFail: (value: any) => Boolean(value?.error),
}));
vi.mock("../src/lib/commercial_notifications", () => ({ notifyCommercialUsers: async () => undefined }));
vi.mock("../src/lib/commercial_telemetry", () => ({ commercialEvent: () => undefined }));
vi.mock("../src/ledger", () => ({ escrowBalance: async () => 0, refund: async () => ({ ok: true }) }));
vi.mock("../src/lib/commercial_refund_rail", () => ({ executeCommercialRefund: async () => ({ ok: true, state: "refunded" }) }));
vi.mock("../src/commercial_money_claim", () => ({
  claimCommercialMoney: async () => ({ ok: true, owned: true }),
  completeCommercialMoneyClaim: async () => undefined,
}));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};
const AVAILABILITY = readFileSync(
  fileURLToPath(new URL("../migrations/2026-09-10-unified-availability.sql", import.meta.url)),
  "utf8",
);
const LIFECYCLE = readFileSync(
  fileURLToPath(new URL("../migrations/2026-08-25-commercial-lifecycle.sql", import.meta.url)),
  "utf8",
);

function d1(db: any, beforeBatch?: () => void): any {
  return {
    prepare(sql: string) {
      let named = "", next = 1;
      const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1; while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) {
          const index = Number(sql.slice(i + 1, j));
          named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1;
        } else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      const wrapped: any = {
        bind(...values: unknown[]) {
          const maxIndex = used.size ? Math.max(...used) : 0;
          if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
          params = {};
          for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
          return wrapped;
        },
        async run() {
          let result;try{result=db.prepare(named).run(params);}catch(error){console.error("D1 fixture SQL failed",sql,String(error));throw error;}
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
        async first<T = any>(): Promise<T | null> {
          return (db.prepare(named).get(params) as T | undefined) ?? null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          return { results: db.prepare(named).all(params) as T[] };
        },
      };
      return wrapped;
    },
    async batch(statements: any[]) {
      beforeBatch?.();
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function setup(simulateCasLoss = false) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, duration_min INTEGER, attrs TEXT, starts_at INTEGER, ends_at INTEGER
    );
    CREATE TABLE listing_slots (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      status TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 1, booked_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY, listing_id TEXT, creator_id TEXT, buyer_id TEXT, kind TEXT,
      status TEXT, starts_at INTEGER, ends_at INTEGER, reschedule_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE calendar_blocks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_app TEXT NOT NULL, source_ref TEXT,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, title TEXT, status TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      status TEXT NOT NULL, reminded_24 INTEGER NOT NULL DEFAULT 0, reminded_10 INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, booking_id TEXT, buyer_id TEXT NOT NULL,
      creator_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE commercial_policy_snapshots (
      policy_snapshot_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, currency TEXT NOT NULL,
      cancellation_policy_json TEXT NOT NULL, creator_fee_pct INTEGER NOT NULL,
      platform_fee_amount INTEGER NOT NULL, creator_amount INTEGER NOT NULL, gst_amount INTEGER
    );
    CREATE TABLE commercial_entitlements (
      entitlement_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, account_id TEXT NOT NULL,
      kind TEXT NOT NULL, listing_id TEXT NOT NULL, booking_id TEXT, role TEXT NOT NULL,
      state TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE TABLE commercial_sessions (
      commercial_session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL,
      booking_id TEXT, session_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      state TEXT NOT NULL, settlement_state TEXT, scheduled_at INTEGER
    );
    CREATE TABLE commercial_money_claims(order_id TEXT PRIMARY KEY,claim_type TEXT,claim_id TEXT,state TEXT);
    CREATE TABLE gcal_accounts (user_id TEXT PRIMARY KEY);
    CREATE TABLE gcal_calendars (user_id TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER, last_error TEXT);
  `);
  db.exec(AVAILABILITY);
  db.exec(LIFECYCLE);
  const now = Date.now();
  const oldStart = Math.ceil((now + 48 * 60 * 60_000) / 3_600_000) * 3_600_000;
  const oldEnd = oldStart + 60 * 60_000;
  const newStart = oldStart + 2 * 60 * 60_000;
  const newEnd = newStart + 60 * 60_000;
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min,attrs) VALUES (?,?,?,?,?,?,?)")
    .run("listing-1", "creator", "consult_1to1", "Consult", "published", 60, JSON.stringify({ commercial_booking_notice_hours: 24 }));
  db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("shared", "creator", null, "UTC", "shared", 60, 60, 0, 0, 8, 366, 1, "", now);
  for (let weekday = 0; weekday < 7; weekday++) {
    db.prepare("INSERT INTO availability_schedule_rules (id,schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?,?)")
      .run(`rule-${weekday}`, "shared", weekday, 0, 1440);
  }
  db.prepare("INSERT INTO orders (id,listing_id,booking_id,buyer_id,creator_id,kind,amount,status) VALUES (?,?,?,?,?,?,?,?)")
    .run("order-1", "listing-1", "booking-1", "buyer", "creator", "consult_1to1", 100, "held");
  db.prepare("INSERT INTO commercial_policy_snapshots (policy_snapshot_id,order_id,currency,cancellation_policy_json,creator_fee_pct,platform_fee_amount,creator_amount,gst_amount) VALUES (?,?,?,?,?,?,?,?)")
    .run("policy-1", "order-1", "INR", JSON.stringify({ reschedule_allowed: true, booking_notice_hours: 24 }), 0, 0, 100, 0);
  db.prepare("INSERT INTO bookings (id,listing_id,creator_id,buyer_id,kind,status,starts_at,ends_at,reschedule_count,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("booking-1", "listing-1", "creator", "buyer", "consult_1to1", "confirmed", oldStart, oldEnd, 0, now);
  db.prepare("INSERT INTO commercial_entitlements (entitlement_id,order_id,account_id,kind,listing_id,booking_id,role,state,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("entitlement-1", "order-1", "buyer", "consult_1to1", "listing-1", "booking-1", "buyer", "active", oldStart, oldEnd);
  db.prepare("INSERT INTO commercial_sessions (commercial_session_id,kind,listing_id,booking_id,session_version,updated_at,state,settlement_state,scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("session-1", "consult_1to1", "listing-1", "booking-1", 1, now, "scheduled", "held", oldStart);
  db.prepare("INSERT INTO calendar_blocks (id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("buyer-block", "buyer", "avaconsult", "commercial:booking-1:buyer", oldStart, oldEnd, "Consult", "busy", now);
  db.prepare("INSERT INTO calendar_events (id,booking_id,start_at,end_at,status) VALUES (?,?,?,?,?)")
    .run("event-1", "booking-1", oldStart, oldEnd, "confirmed");
  db.prepare("INSERT INTO calendar_events (id,booking_id,start_at,end_at,status) VALUES (?,?,?,?,?)")
    .run("event-2", "booking-1", oldStart, oldEnd, "confirmed");
  db.prepare("INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("old-reservation", "creator", "listing-1", "booking", "reserved", oldStart, oldEnd, "Consult", "commercial-availability:buyer:order-1", now, now);
  const mutate = simulateCasLoss ? () => db.prepare("UPDATE bookings SET reschedule_count=9 WHERE id='booking-1'").run() : undefined;
  return { db, env: { DB_META: d1(db, mutate) }, oldStart, oldEnd, newStart, newEnd };
}

let lifecycle: typeof import("../src/routes/commercial_lifecycle");
let currentDb: any;
beforeEach(async () => {
  H.uid = "buyer";
  lifecycle = await import("../src/routes/commercial_lifecycle");
});
afterEach(() => { currentDb?.close(); currentDb = null; });

function request(newStart: number, newEnd: number, idempotencyKey: string): Request {
  return new Request("https://api.test/api/commercial/consult/booking-1/reschedule", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ new_start: newStart, new_end: newEnd }),
  });
}

describe("commercial reschedule route against SQLite", () => {
  it("moves the real reservation, entitlement, both mirrors, events, and session", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const response = await lifecycle.commercialLifecycle(request(fixture.newStart, fixture.newEnd, "reschedule-1"), fixture.env as any);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(fixture.db.prepare("SELECT starts_at,ends_at,reschedule_count FROM bookings WHERE id='booking-1'").get())
      .toMatchObject({ starts_at: fixture.newStart, ends_at: fixture.newEnd, reschedule_count: 1 });
    expect(fixture.db.prepare("SELECT status,starts_at,ends_at FROM availability_reservations WHERE id='old-reservation'").get())
      .toMatchObject({ status: "cancelled", starts_at: fixture.oldStart, ends_at: fixture.oldEnd });
    expect(fixture.db.prepare("SELECT status,starts_at,ends_at,source_ref FROM availability_reservations WHERE creator_id='creator' AND id!='old-reservation'").get())
      .toMatchObject({ status: "reserved", starts_at: fixture.newStart, ends_at: fixture.newEnd, source_ref: "commercial-availability:buyer:order-1" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM commercial_entitlements WHERE starts_at=? AND ends_at=?").get(fixture.newStart, fixture.newEnd).n).toBe(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE starts_at=? AND ends_at=? AND status='busy'").get(fixture.newStart, fixture.newEnd).n).toBe(2);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE source_app='availability' AND starts_at=? AND ends_at=? AND status='busy'").get(fixture.newStart, fixture.newEnd).n).toBe(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE source_app='avaconsult' AND source_ref='commercial:booking-1:buyer' AND starts_at=? AND ends_at=? AND status='busy'").get(fixture.newStart, fixture.newEnd).n).toBe(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE booking_id='booking-1' AND start_at=? AND end_at=?").get(fixture.newStart, fixture.newEnd).n).toBe(2);
    expect(fixture.db.prepare("SELECT scheduled_at FROM commercial_sessions WHERE commercial_session_id='session-1'").get().scheduled_at).toBe(fixture.newStart);
  });

  it("leaves old projections intact when a concurrent booking CAS loses", async () => {
    const fixture = setup(true); currentDb = fixture.db;
    const response = await lifecycle.commercialLifecycle(request(fixture.newStart, fixture.newEnd, "reschedule-cas"), fixture.env as any);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM commercial_entitlements WHERE starts_at=? AND ends_at=?").get(fixture.oldStart, fixture.oldEnd).n).toBe(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE starts_at=? AND ends_at=? AND status='busy'").get(fixture.oldStart, fixture.oldEnd).n).toBe(2);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE booking_id='booking-1' AND start_at=? AND end_at=?").get(fixture.oldStart, fixture.oldEnd).n).toBe(2);
    expect(fixture.db.prepare("SELECT scheduled_at FROM commercial_sessions WHERE commercial_session_id='session-1'").get().scheduled_at).toBe(fixture.oldStart);
    expect(fixture.db.prepare("SELECT status,starts_at,ends_at FROM availability_reservations WHERE id='old-reservation'").get())
      .toMatchObject({ status: "reserved", starts_at: fixture.oldStart, ends_at: fixture.oldEnd });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM availability_reservations WHERE starts_at=? AND ends_at=? AND status IN ('reserved','confirmed')").get(fixture.newStart, fixture.newEnd).n).toBe(0);
  });
});
