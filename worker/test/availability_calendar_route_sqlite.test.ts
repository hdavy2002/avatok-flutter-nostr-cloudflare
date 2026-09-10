import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "creator" }));
vi.mock("../src/authz", () => ({
  requireUser: async () => ({ uid: H.uid }),
  isFail: (value: any) => Boolean(value?.error),
}));
vi.mock("../src/hooks", () => ({ track: async () => undefined }));

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

function setup(timezone = "UTC", duration = 60) {
  const db = new DatabaseSync(":memory:");
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
    CREATE TABLE gcal_accounts (user_id TEXT PRIMARY KEY);
    CREATE TABLE gcal_calendars (
      user_id TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER, last_error TEXT
    );
  `);
  db.exec(MIGRATION);
  db.prepare(
    "INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)",
  ).run("consult", "creator", "consult", "Consult", "published", duration);
  return { db, env: { DB_META: d1(db) } };
}

function scheduleBody(version: number, rules: Array<{ weekday: number; start_min: number; end_min: number }>, extra: Record<string, unknown> = {}) {
  return {
    schedule: {
      timezone: "UTC", mode: "shared", duration_min: 60, slot_interval_min: 60,
      buffer_min: 10, min_notice_min: 0, max_per_day: 8, horizon_days: 62,
      version, rules, exceptions: [], ...extra,
    },
  };
}

function putRequest(body: unknown, listingId?: string): Request {
  return new Request(`https://api.test/api/calendar/schedule${listingId ? `?listing_id=${listingId}` : ""}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

let calendar: typeof import("../src/routes/calendar_availability");
let currentDb: any;
beforeEach(async () => {
  H.uid = "creator";
  calendar = await import("../src/routes/calendar_availability");
});
afterEach(() => {
  currentDb?.close();
  currentDb = null;
});

describe("calendar availability routes against SQLite", () => {
  it("rejects a stale schedule write without touching child rules", async () => {
    const { db, env } = setup();
    currentDb = db;
    const one = await calendar.putSchedule(putRequest(scheduleBody(0, [{ weekday: 1, start_min: 540, end_min: 600 }])), env as any);
    expect(one.status).toBe(200);

    const childOne = await calendar.putSchedule(putRequest(
      scheduleBody(0, [{ weekday: 1, start_min: 600, end_min: 660 }], { listing_id: "consult" }), "consult",
    ), env as any);
    expect(childOne.status).toBe(200);
    const childTwo = await calendar.putSchedule(putRequest(
      scheduleBody(1, [{ weekday: 1, start_min: 660, end_min: 720 }], { listing_id: "consult" }), "consult",
    ), env as any);
    expect(childTwo.status).toBe(200);

    const stale = await calendar.putSchedule(putRequest(
      scheduleBody(1, [{ weekday: 1, start_min: 780, end_min: 840 }], { listing_id: "consult" }), "consult",
    ), env as any);
    expect(stale.status).toBe(409);
    const rules = db.prepare(
      "SELECT weekday,start_min,end_min FROM availability_schedule_rules r JOIN availability_schedules s ON s.id=r.schedule_id WHERE s.listing_id='consult' ORDER BY start_min",
    ).all();
    expect(rules).toEqual([{ weekday: 1, start_min: 660, end_min: 720 }]);
  });

  it("returns fold-day viewer slots in the requested timezone without shifting their local date", async () => {
    const { db, env } = setup("America/New_York", 30);
    currentDb = db;
    db.prepare(
      "INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("shared", "creator", null, "America/New_York", "shared", 30, 30, 0, 0, 8, 366, 1, "", Date.now());
    db.prepare("INSERT INTO availability_schedule_rules (id,schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?,?)")
      .run("fold-rule", "shared", 0, 60, 150);

    const response = await calendar.listingAvailability(
      new Request("https://api.test/api/listings/consult/availability?from=2026-11-01&to=2026-11-01&timezone=America/New_York"),
      env as any,
      "consult",
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.timezone).toBe("America/New_York");
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots.every((slot: any) => calendarDate(slot.start_at, "America/New_York") === "2026-11-01")).toBe(true);
  });
});

function calendarDate(epoch: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epoch));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
