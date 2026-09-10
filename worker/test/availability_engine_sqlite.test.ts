import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// node:sqlite is a runtime built-in in the CI Node image. The D1-shaped shim
// below executes the real engine SQL against SQLite; it is deliberately not a
// hand-written copy of the admission predicates.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/2026-09-10-unified-availability.sql", import.meta.url)),
  "utf8",
);

function d1(db: any): any {
  return {
    prepare(sql: string) {
      // D1 permits numbered placeholders to be repeated and leaves gaps in
      // the bind list. SQLite's named parameters preserve that behavior while
      // this scanner also assigns anonymous placeholders to the next index.
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
      const stmt = () => db.prepare(named);
      const wrapped = {
        bind(...values: unknown[]) {
          const maxIndex = used.size ? Math.max(...used) : 0;
          if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
          params = {};
          for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
          return wrapped;
        },
        async run() {
          const result = stmt().run(params);
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
        async first<T = any>(): Promise<T | null> {
          return (stmt().get(params) as T | undefined) ?? null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          return { results: stmt().all(params) as T[] };
        },
      };
      return wrapped;
    },
    async batch(statements: any[]) {
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

function schema(db: any) {
  db.exec(`
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, duration_min INTEGER,
      starts_at INTEGER, ends_at INTEGER, attrs TEXT, price INTEGER DEFAULT 0
    );
    CREATE TABLE listing_slots (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, status TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1, booked_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE calendar_blocks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_app TEXT NOT NULL,
      source_ref TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      title TEXT, status TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY, listing_id TEXT, creator_id TEXT, buyer_id TEXT,
      kind TEXT, status TEXT, starts_at INTEGER, ends_at INTEGER
    );
    CREATE TABLE availability_rules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, weekday INTEGER NOT NULL,
      start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, tz TEXT NOT NULL,
      slot_min INTEGER NOT NULL
    );
    CREATE TABLE booking_policies (
      user_id TEXT PRIMARY KEY, buffer_min INTEGER, min_notice_min INTEGER,
      max_per_day INTEGER, vacation_until INTEGER
    );
    CREATE TABLE gcal_accounts (user_id TEXT PRIMARY KEY);
    CREATE TABLE gcal_calendars (
      user_id TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER, last_error TEXT
    );
  `);
  db.exec(MIGRATION);
}

function seed(db: any, timezone = "UTC") {
  const now = Date.now();
  db.prepare(
    "INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("shared", "creator", null, timezone, "shared", 60, 60, 10, 0, 8, 366, 1, "", now);
  for (let weekday = 0; weekday < 7; weekday++) {
    db.prepare("INSERT INTO availability_schedule_rules (id,schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?,?)")
      .run(`rule-${weekday}`, "shared", weekday, 0, 1440);
  }
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)")
    .run("consult", "creator", "consult", "Consult", "published", 60);
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)")
    .run("short", "creator", "consult", "Short", "published", 30);
}

let db: any;
let env: any;
let engine: typeof import("../src/cal/engine");

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  schema(db);
  seed(db);
  env = { DB_META: d1(db) };
  engine = await import("../src/cal/engine");
});
afterEach(() => db.close());

function futureSlot(durationMinutes = 60): { start: number; end: number } {
  const start = Math.ceil((Date.now() + 48 * 60 * 60_000) / 3_600_000) * 3_600_000;
  return { start, end: start + durationMinutes * 60_000 };
}

describe("unified availability engine against SQLite", () => {
  it("admits exactly one of two simultaneous creator claims", async () => {
    const slot = futureSlot();
    const args = {
      creatorId: "creator", listingId: "consult", startAt: slot.start, endAt: slot.end,
      kind: "booking" as const, status: "confirmed" as const,
    };
    const [left, right] = await Promise.all([
      engine.claimListingSlot(env, { ...args, sourceRef: "order:left" }),
      engine.claimListingSlot(env, { ...args, sourceRef: "order:right" }),
    ]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_reservations WHERE status='confirmed'").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE source_app='availability' AND status='busy'").get().n).toBe(1);
  });

  it("enforces each listing's duration at the authority boundary", async () => {
    const slot = futureSlot(60);
    const wrong = await engine.validateListingSlot(env, "short", slot.start, slot.end, { now: Date.now() - 1_000 });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe("duration");
    const right = await engine.validateListingSlot(env, "short", slot.start, slot.start + 30 * 60_000, { now: Date.now() - 1_000 });
    expect(right.ok).toBe(true);
  });

  it("keeps a hard global closure closed even when weekly hours are open", async () => {
    const slot = futureSlot();
    const date = new Date(slot.start).toISOString().slice(0, 10);
    db.prepare("INSERT INTO availability_exceptions (id,creator_id,schedule_id,listing_id,date,start_min,end_min,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("closure", "creator", "shared", null, date, new Date(slot.start).getUTCHours() * 60, new Date(slot.start).getUTCHours() * 60 + 60, "unavailable", Date.now());
    const result = await engine.validateListingSlot(env, "consult", slot.start, slot.end, { now: Date.now() - 1_000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside_hours");
  });

  it("rejects a fixed listing window inside another creator block's buffer", async () => {
    const slot = futureSlot();
    const blockStart = slot.start + 3 * 60 * 60_000;
    db.prepare("INSERT INTO calendar_blocks (id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("busy-1", "creator", "google", "event-1", blockStart, blockStart + 60 * 60_000, "Private event", "busy", Date.now());
    const near = await engine.claimExclusiveReservation(env, {
      creatorId: "creator", listingId: "consult", startAt: blockStart + 65 * 60_000,
      endAt: blockStart + 125 * 60_000, sourceRef: "live:consult:1",
    });
    expect(near.ok).toBe(false);
    expect(near.reason).toBe("conflict");
  });

  it("round-trips India wall time and refuses a New York DST gap", () => {
    const india = engine.zonedEpoch("2026-01-15", 9 * 60, "Asia/Kolkata");
    expect(engine.localParts(india, "Asia/Kolkata")).toMatchObject({ date: "2026-01-15", minutes: 540 });

    const gap = engine.zonedEpoch("2026-03-08", 2 * 60 + 30, "America/New_York");
    expect(engine.localParts(gap, "America/New_York")).not.toMatchObject({ date: "2026-03-08", minutes: 150 });

    const fold = engine.zonedEpoch("2026-11-01", 60 + 30, "America/New_York");
    expect(engine.localParts(fold, "America/New_York")).toMatchObject({ date: "2026-11-01", minutes: 90 });
  });
});
