import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("../src/hooks", () => ({ track: async () => undefined, metric: () => undefined }));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

// [SESSION-CLOCK-0] Minimal D1-shaped wrapper over node:sqlite, matching the
// pattern used by availability_commercial_hold_sqlite.test.ts. Adds `.batch()`
// (sequential, not atomic -- good enough for these single-process tests) since
// `endDueConsultSessions` writes its terminal state through one.
function d1(db: any): any {
  function makeStatement(sql: string) {
    let named = "";
    let next = 1;
    const used = new Set<number>();
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] !== "?") { named += sql[i]; continue; }
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j])) j++;
      if (j > i + 1) {
        const index = Number(sql.slice(i + 1, j));
        named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1;
      } else { named += `$p${next}`; used.add(next); next++; }
    }
    let params: Record<string, unknown> = {};
    const wrapped = {
      bind(...values: unknown[]) {
        const maxIndex = used.size ? Math.max(...used) : 0;
        if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
        params = {};
        for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
        return wrapped;
      },
      async run() {
        const result = db.prepare(named).run(params);
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
  }
  return {
    prepare: makeStatement,
    async batch(statements: ReturnType<typeof makeStatement>[]) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY, listing_id TEXT, creator_id TEXT, buyer_id TEXT,
      kind TEXT, status TEXT, starts_at INTEGER, ends_at INTEGER, order_id TEXT
    );
    CREATE TABLE commercial_sessions (
      commercial_session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL,
      booking_id TEXT, order_id TEXT, creator_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_call_type TEXT NOT NULL, provider_call_id TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1, scheduled_at INTEGER NOT NULL,
      backstage_opened_at INTEGER, live_started_at INTEGER, ended_at INTEGER,
      state TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 1,
      settlement_state TEXT NOT NULL DEFAULT 'not_ready',
      recording_state TEXT NOT NULL DEFAULT 'disabled', replay_state TEXT NOT NULL DEFAULT 'disabled',
      policy_snapshot_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_participant_intervals (
      interval_id TEXT PRIMARY KEY, commercial_session_id TEXT NOT NULL, account_id TEXT NOT NULL,
      provider_user_id TEXT NOT NULL, provider_session_id TEXT NOT NULL, joined_event_id TEXT NOT NULL,
      left_event_id TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, connected_ms INTEGER,
      reconciliation_state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_settlement_jobs (
      settlement_job_id TEXT PRIMARY KEY, commercial_session_id TEXT NOT NULL, order_id TEXT NOT NULL,
      state TEXT NOT NULL, terminal_event_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      funds_verified_at INTEGER, ledger_confirmed_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_policy_snapshots (
      policy_snapshot_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL,
      booking_id TEXT, buyer_id TEXT NOT NULL, creator_id TEXT NOT NULL, kind TEXT NOT NULL,
      gross_amount INTEGER NOT NULL, currency TEXT NOT NULL, creator_fee_pct INTEGER NOT NULL,
      settlement_hold_hours INTEGER NOT NULL, platform_fee_amount INTEGER NOT NULL,
      creator_amount INTEGER NOT NULL, cancellation_policy_json TEXT NOT NULL,
      conversion_snapshot_json TEXT, policy_version TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_entitlements (
      entitlement_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL, booking_id TEXT,
      order_id TEXT, account_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
      starts_at INTEGER, ends_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE commercial_session_members (
      commercial_session_id TEXT NOT NULL, account_id TEXT NOT NULL, entitlement_id TEXT NOT NULL,
      provider_user_id TEXT NOT NULL, role TEXT NOT NULL, order_id TEXT, added_at INTEGER NOT NULL,
      removed_at INTEGER
    );
  `);
  return { db, env: { DB_META: d1(db), TOKENS: { get: async () => null } } };
}

function insertBooking(db: any, args: { id: string; startsAt: number; endsAt: number; orderId?: string }) {
  db.prepare(
    "INSERT INTO bookings (id,listing_id,creator_id,buyer_id,kind,status,starts_at,ends_at,order_id) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(args.id, "listing-1", "creator-1", "buyer-1", "consult_1to1", "confirmed", args.startsAt, args.endsAt, args.orderId ?? null);
}

function insertSession(db: any, args: { id: string; bookingId: string; startsAt: number; state: string }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO commercial_sessions
     (commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,provider,
      provider_call_type,provider_call_id,scheduled_at,state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    args.id, "consult_1to1", "listing-1", args.bookingId, null, "creator-1", "getstream",
    "avatok_consult_1to1", `call-${args.id}`, args.startsAt, args.state, now, now,
  );
}

function insertPolicySnapshot(db: any, args: { orderId: string; listingId: string; bookingId: string }) {
  db.prepare(
    `INSERT INTO commercial_policy_snapshots
     (policy_snapshot_id,order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
      creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,
      policy_version,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `policy:${args.orderId}`, args.orderId, args.listingId, args.bookingId, "buyer-1", "creator-1",
    "consult_1to1", 10000, "INR", 20, 24, 2000, 8000, "{}", "v1", Date.now(),
  );
}

let clock: typeof import("../src/lib/commercial_session_clock");
let currentDb: any;
beforeEach(async () => {
  vi.resetModules();
  clock = await import("../src/lib/commercial_session_clock");
});
afterEach(() => { currentDb?.close(); currentDb = null; });

describe("endDueConsultSessions [SESSION-CLOCK-0]", () => {
  it("ends a consult session past ends_at + commercialConsultJoinLateMin, closes intervals, queues settlement", async () => {
    const { db, env } = setup();
    currentDb = db;
    const now = Date.now();
    // Late grace default is 2 minutes; put ends_at 3 minutes in the past so it's due.
    const startsAt = now - 63 * 60_000;
    const endsAt = now - 3 * 60_000;
    insertBooking(db, { id: "booking-1", startsAt, endsAt, orderId: "order-1" });
    insertSession(db, { id: "session-1", bookingId: "booking-1", startsAt, state: "scheduled" });
    insertPolicySnapshot(db, { orderId: "order-1", listingId: "listing-1", bookingId: "booking-1" });
    db.prepare(
      `INSERT INTO commercial_participant_intervals
       (interval_id,commercial_session_id,account_id,provider_user_id,provider_session_id,
        joined_event_id,joined_at,reconciliation_state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("interval-1", "session-1", "creator-1", "creator-1", "sess", "evt-1", startsAt, "open", startsAt, startsAt);

    const result = await clock.endDueConsultSessions(env as any);
    expect(result).toMatchObject({ scanned: 1, ended: 1 });

    const session = db.prepare("SELECT state,settlement_state,ended_at FROM commercial_sessions WHERE commercial_session_id=?")
      .get("session-1") as any;
    expect(session.state).toBe("ended");
    expect(session.settlement_state).toBe("pending");
    expect(session.ended_at).toBeTruthy();

    const interval = db.prepare("SELECT reconciliation_state,left_at FROM commercial_participant_intervals WHERE interval_id=?")
      .get("interval-1") as any;
    expect(interval.reconciliation_state).toBe("closed");
    expect(interval.left_at).toBeTruthy();

    const job = db.prepare("SELECT state FROM commercial_settlement_jobs WHERE commercial_session_id=? AND order_id=?")
      .get("session-1", "order-1") as any;
    expect(job.state).toBe("pending");
  });

  it("leaves a session alone before ends_at + late grace has passed", async () => {
    const { db, env } = setup();
    currentDb = db;
    const now = Date.now();
    const startsAt = now - 10 * 60_000;
    const endsAt = now + 30 * 60_000; // still well within the slot
    insertBooking(db, { id: "booking-2", startsAt, endsAt, orderId: "order-2" });
    insertSession(db, { id: "session-2", bookingId: "booking-2", startsAt, state: "live" });

    const result = await clock.endDueConsultSessions(env as any);
    expect(result).toMatchObject({ scanned: 0, ended: 0 });
    const session = db.prepare("SELECT state FROM commercial_sessions WHERE commercial_session_id=?").get("session-2") as any;
    expect(session.state).toBe("live");
  });

  it("never re-touches an already-ended or cancelled session", async () => {
    const { db, env } = setup();
    currentDb = db;
    const now = Date.now();
    const startsAt = now - 63 * 60_000;
    const endsAt = now - 3 * 60_000;
    insertBooking(db, { id: "booking-3", startsAt, endsAt, orderId: "order-3" });
    insertSession(db, { id: "session-3", bookingId: "booking-3", startsAt, state: "ended" });

    const result = await clock.endDueConsultSessions(env as any);
    expect(result).toMatchObject({ scanned: 0, ended: 0 });
  });

  it("is idempotent across repeated cron ticks", async () => {
    const { db, env } = setup();
    currentDb = db;
    const now = Date.now();
    const startsAt = now - 63 * 60_000;
    const endsAt = now - 3 * 60_000;
    insertBooking(db, { id: "booking-4", startsAt, endsAt, orderId: "order-4" });
    insertSession(db, { id: "session-4", bookingId: "booking-4", startsAt, state: "scheduled" });
    insertPolicySnapshot(db, { orderId: "order-4", listingId: "listing-1", bookingId: "booking-4" });

    const first = await clock.endDueConsultSessions(env as any);
    expect(first.ended).toBe(1);
    const second = await clock.endDueConsultSessions(env as any);
    expect(second).toMatchObject({ scanned: 0, ended: 0 });

    const jobs = db.prepare("SELECT COUNT(*) n FROM commercial_settlement_jobs WHERE commercial_session_id=?")
      .get("session-4") as any;
    expect(jobs.n).toBe(1);
  });
});
