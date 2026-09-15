// [AUDIT-2/3/10] Date exception invariants shared by app and web:
//   * end_min 1440 keeps meaning "end of day" and round-trips unchanged;
//   * several intervals on one day stay independently stored;
//   * an edit that omits an unrelated interval never erases it;
//   * a holiday date range expands into per-date rows;
//   * a deliberately chosen horizon survives an update that omits it.
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
  const wrapped: any = {
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
      const statement: any = {
        bind(...values: unknown[]) {
          const maxIndex = used.size ? Math.max(...used) : 0;
          if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
          params = {};
          for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
          return statement;
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
      return statement;
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
  return wrapped;
}

function setup() {
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
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min,attrs) VALUES (?,?,?,?,?,?,?)")
    .run("consult", "creator", "consult", "Consult", "published", 60, null);
  return { db, env: { DB_META: d1(db) } };
}

type ExceptionInput = {
  id?: string; date: string; start_min: number; end_min: number;
  status: "available" | "unavailable" | "reserved"; listing_id?: string; end_date?: string;
};

function scheduleBody(version: number, exceptions: ExceptionInput[], extra: Record<string, unknown> = {}) {
  return {
    schedule: {
      timezone: "UTC", mode: "shared", duration_min: 60, slot_interval_min: 60,
      buffer_min: 10, min_notice_min: 0, max_per_day: 8, horizon_days: 60,
      version, rules: [{ weekday: 1, start_min: 540, end_min: 1020 }], exceptions, ...extra,
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
afterEach(() => { currentDb?.close(); currentDb = null; });

async function save(env: any, request: Request): Promise<any> {
  const response = await calendar.putSchedule(request, env);
  const body = await response.json() as any;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.schedule;
}

describe("date exception invariants", () => {
  it("round-trips an all-day block at end_min 1440 and keeps separate breaks on one day", async () => {
    const { db, env } = setup();
    currentDb = db;
    const saved = await save(env, putRequest(scheduleBody(0, [
      { date: "2026-10-05", start_min: 0, end_min: 1440, status: "unavailable" },
      { date: "2026-10-06", start_min: 780, end_min: 840, status: "unavailable" },
      { date: "2026-10-06", start_min: 960, end_min: 1020, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"));

    const allDay = saved.exceptions.filter((row: any) => row.date === "2026-10-05");
    expect(allDay).toHaveLength(1);
    expect(allDay[0]).toMatchObject({ start_min: 0, end_min: 1440, status: "unavailable" });
    const breaks = saved.exceptions.filter((row: any) => row.date === "2026-10-06")
      .map((row: any) => [row.start_min, row.end_min]).sort((a: number[], b: number[]) => a[0] - b[0]);
    expect(breaks).toEqual([[780, 840], [960, 1020]]);
    expect(new Set(saved.exceptions.map((row: any) => row.id)).size).toBe(3);
  });

  it("keeps an unmentioned interval in explicit-removal mode and removes only the named one", async () => {
    const { db, env } = setup();
    currentDb = db;
    const first = await save(env, putRequest(scheduleBody(0, [
      { date: "2026-10-12", start_min: 780, end_min: 840, status: "unavailable" },
      { date: "2026-10-13", start_min: 960, end_min: 1020, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"));
    const lunch = first.exceptions.find((row: any) => row.date === "2026-10-12");
    const pickup = first.exceptions.find((row: any) => row.date === "2026-10-13");

    // A client that knows about lunch saves lunch, names nothing to remove and
    // the unrelated interval survives with its original id.
    const second = await save(env, putRequest(scheduleBody(first.version, [
      { id: lunch.id, date: "2026-10-12", start_min: 780, end_min: 840, status: "unavailable" },
    ], { listing_id: "consult", removed_exception_ids: [] }), "consult"));
    expect(second.exceptions.map((row: any) => row.date).sort()).toEqual(["2026-10-12", "2026-10-13"]);
    expect(second.exceptions.find((row: any) => row.date === "2026-10-13").id).toBe(pickup.id);

    // Removal is explicit and targeted: the named interval goes, the other stays.
    const third = await save(env, putRequest(scheduleBody(second.version, [
      { id: lunch.id, date: "2026-10-12", start_min: 780, end_min: 840, status: "unavailable" },
    ], { listing_id: "consult", removed_exception_ids: [pickup.id] }), "consult"));
    expect(third.exceptions.map((row: any) => row.date)).toEqual(["2026-10-12"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_exceptions WHERE id=?").get(pickup.id).n).toBe(0);
  });

  it("never erases an interval backed by a live booking, even for a legacy whole-set save", async () => {
    const { db, env } = setup();
    currentDb = db;
    const first = await save(env, putRequest(scheduleBody(0, [
      { date: "2026-10-20", start_min: 600, end_min: 660, status: "reserved" },
      { date: "2026-10-21", start_min: 600, end_min: 660, status: "reserved" },
    ], { listing_id: "consult" }), "consult"));
    const booked = first.exceptions.find((row: any) => row.date === "2026-10-20");
    const other = first.exceptions.find((row: any) => row.date === "2026-10-21");
    // The commercial lifecycle rewrites the reservation ref and status, so this
    // interval is now a real commitment rather than a saved preference.
    db.prepare("UPDATE availability_reservations SET status=?, source_ref=? WHERE creator_id=? AND id=(SELECT reservation_id FROM availability_exceptions WHERE id=?)")
      .run("confirmed", "commercial-availability:buyer-1:order-9", "creator", booked.id);

    // A legacy whole-set client (no removed_exception_ids) saves only the second
    // interval; the committed one must survive untouched, reservation included.
    const second = await save(env, putRequest(scheduleBody(first.version, [
      { id: other.id, date: "2026-10-21", start_min: 600, end_min: 660, status: "reserved" },
    ], { listing_id: "consult" }), "consult"));
    expect(second.exceptions.map((row: any) => row.date).sort()).toEqual(["2026-10-20", "2026-10-21"]);
    expect(second.exceptions.find((row: any) => row.date === "2026-10-20").id).toBe(booked.id);
    const reservation = db.prepare("SELECT status FROM availability_reservations WHERE id=(SELECT reservation_id FROM availability_exceptions WHERE id=?)").get(booked.id);
    expect(reservation.status).toBe("confirmed");
  });

  it("expands a holiday date range into one independently editable row per date", async () => {
    const { db, env } = setup();
    currentDb = db;
    const saved = await save(env, putRequest(scheduleBody(0, [
      { date: "2026-12-24", end_date: "2026-12-26", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"));
    expect(saved.exceptions.map((row: any) => row.date).sort()).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
    expect(saved.exceptions.every((row: any) => row.end_min === 1440)).toBe(true);
    expect(new Set(saved.exceptions.map((row: any) => row.id)).size).toBe(3);

    const middle = saved.exceptions.find((row: any) => row.date === "2026-12-25");
    // Reopen one day of the holiday: the other days carry the full range, and
    // the omitted middle day is removed explicitly (never dropped by accident).
    const removed = await save(env, putRequest(scheduleBody(saved.version, [
      { date: "2026-12-24", start_min: 0, end_min: 1440, status: "unavailable" },
      { date: "2026-12-26", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult", removed_exception_ids: [middle.id] }), "consult"));
    expect(removed.exceptions.map((row: any) => row.date).sort()).toEqual(["2026-12-24", "2026-12-26"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_exceptions WHERE date=?").get("2026-12-25").n).toBe(0);
  });

  it("rejects a range longer than the supported window and more than 100 intervals", async () => {
    const { db, env } = setup();
    currentDb = db;
    const tooLong = await calendar.putSchedule(putRequest(scheduleBody(0, [
      { date: "2026-01-01", end_date: "2026-06-30", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"), env);
    expect(tooLong.status).toBe(400);

    const many = Array.from({ length: 101 }, (_, index) => ({
      date: `2027-01-${String((index % 28) + 1).padStart(2, "0")}`,
      start_min: index, end_min: index + 1, status: "available" as const,
    }));
    const tooMany = await calendar.putSchedule(putRequest(scheduleBody(0, many, { listing_id: "consult" }), "consult"), env);
    expect(tooMany.status).toBe(400);
  });

  it("preserves a chosen horizon when an update omits it", async () => {
    const { db, env } = setup();
    currentDb = db;
    const first = await save(env, putRequest(scheduleBody(0, [], { listing_id: "consult", horizon_days: 30 }), "consult"));
    expect(first.horizon_days).toBe(30);
    const second = await save(env, putRequest({ schedule: { ...scheduleBody(first.version, [], { listing_id: "consult" }).schedule, horizon_days: undefined } as any }, "consult"));
    expect(second.horizon_days).toBe(30);
    const explicit = await save(env, putRequest(scheduleBody(second.version, [], { listing_id: "consult", horizon_days: 62 }), "consult"));
    expect(explicit.horizon_days).toBe(62);
  });

  it("rejects a malformed or reversed date range as a 400 instead of a RangeError", async () => {
    const { db, env } = setup();
    currentDb = db;
    const badEnd = await calendar.putSchedule(putRequest(scheduleBody(0, [
      { date: "2026-12-24", end_date: "2026-13-99", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"), env);
    expect(badEnd.status).toBe(400);

    const badDate = await calendar.putSchedule(putRequest(scheduleBody(0, [
      { date: "not-a-date", end_date: "2026-12-26", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"), env);
    expect(badDate.status).toBe(400);

    // Reversed: the range must expand into nothing, never into a negative loop.
    const reversed = await calendar.putSchedule(putRequest(scheduleBody(0, [
      { date: "2026-12-26", end_date: "2026-12-24", start_min: 0, end_min: 1440, status: "unavailable" },
    ], { listing_id: "consult" }), "consult"), env);
    expect(reversed.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_exceptions").get().n).toBe(0);
  });

  it("refuses a range that duplicates an interval in the same submission", async () => {
    const { db, env } = setup();
    currentDb = db;
    // 25 Dec appears twice (once from the range, once explicitly) with the same
    // interval. Uniqueness is decided on date+interval, so this is a stable 400
    // rather than two competing rows for one day.
    const response = await calendar.putSchedule(putRequest(scheduleBody(0, [
      { date: "2026-12-24", end_date: "2026-12-25", start_min: 0, end_min: 1440, status: "unavailable" },
      { date: "2026-12-25", start_min: 0, end_min: 1440, status: "reserved", listing_id: "consult" },
    ], { listing_id: "consult" }), "consult"), env);
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe("Duplicate date interval");
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_exceptions").get().n).toBe(0);
  });

  it("explains the effective policy and applies the buffer on both sides", async () => {
    const { db, env } = setup();
    currentDb = db;
    db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("shared", "creator", null, "UTC", "shared", 60, 60, 15, 120, 8, 45, 1, "", Date.now());
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 48 }), "consult");

    // The listing has no schedule of its own, so every rule is inherited from
    // the creator-wide schedule and the commercial notice is the floor.
    const response = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule?listing_id=consult"), env);
    expect(response.status).toBe(200);
    const saved = (await response.json() as any).schedule;
    expect(saved.effective.inherited_from).toBe("global");
    expect(saved.effective.listing_overrides).toBeNull();
    expect(saved.effective.effective.buffer_scope).toBe("before_and_after");
    expect(saved.effective.effective.min_notice_min).toBe(48 * 60);
    expect(saved.effective_min_notice_min).toBe(48 * 60);
    expect(saved.effective.notice_source).toBe("listing_commercial");
    expect(saved.effective.global).toMatchObject({ buffer_min: 15, horizon_days: 45 });
    expect(saved.effective.effective.horizon_days).toBe(45);
    expect(saved.effective.effective.buffer_min).toBe(15);
    expect(saved.effective.calendar_min_notice_min).toBe(120);
    // The configured (inherited) value is what the editor round-trips; the 48 h
    // commercial floor is a separate, additive number.
    expect(saved.min_notice_min).toBe(120);
  });

  it("reports the effective notice as the larger of calendar and commercial, with the source", async () => {
    const { db, env } = setup();
    currentDb = db;
    // A 72-hour calendar notice with a 2-hour commercial notice: the calendar
    // wins, and the win is named so the creator is not told to look at the
    // listing's commercial setting.
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 2 }), "consult");
    const saved = await save(env, putRequest(scheduleBody(0, [], { listing_id: "consult", min_notice_min: 72 * 60 }), "consult"));
    expect(saved.effective.listing_commercial_notice_min).toBe(120);
    expect(saved.effective.effective.min_notice_min).toBe(72 * 60);
    expect(saved.effective_min_notice_min).toBe(72 * 60);
    expect(saved.effective.notice_source).toBe("calendar");
    expect(saved.effective.calendar_min_notice_min).toBe(72 * 60);
    expect(saved.min_notice_min).toBe(72 * 60);
  });

  it("never lets a calendar notice fall below the commercial floor", async () => {
    const { db, env } = setup();
    currentDb = db;
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 48 }), "consult");
    // An explicit 0 means "no calendar notice", not "ignore the listing". The
    // booking authority floors it at the commercial notice, so the explained
    // value has to be the SAME number the booking path enforces.
    const saved = await save(env, putRequest(scheduleBody(0, [], { listing_id: "consult", min_notice_min: 0 }), "consult"));
    expect(db.prepare("SELECT min_notice_min FROM availability_schedules WHERE creator_id=? AND listing_id=?").get("creator", "consult").min_notice_min).toBe(0);
    expect(saved.effective.effective.min_notice_min).toBe(48 * 60);
    expect(saved.effective_min_notice_min).toBe(48 * 60);
    expect(saved.effective.notice_source).toBe("listing_commercial");
    // The response's `min_notice_min` is the CONFIGURED calendar notice (0), not
    // the commercial floor (2880) the engine applies at booking time.
    expect(saved.min_notice_min).toBe(0);
    expect(saved.effective.calendar_min_notice_min).toBe(0);
    // A missing value inherits rather than becoming NaN.
    const inherited = await save(env, putRequest(scheduleBody(saved.version, [], { listing_id: "consult", min_notice_min: undefined }), "consult"));
    expect(inherited.effective.effective.min_notice_min).toBe(48 * 60);
    expect(inherited.effective_min_notice_min).toBe(48 * 60);
    // An OMITTED notice still takes the PUT default (120, pre-existing contract:
    // only `horizon_days` inherits on omission). What must never come back is the
    // engine's floored 2880, which would then be saved back by the editor.
    expect(inherited.min_notice_min).toBe(120);
    expect(db.prepare("SELECT min_notice_min FROM availability_schedules WHERE creator_id=? AND listing_id=?").get("creator", "consult").min_notice_min).toBe(120);
    expect(Number.isFinite(inherited.effective.effective.min_notice_min)).toBe(true);
  });

  it("survives a routine editor round-trip without persisting the commercial floor", async () => {
    const { db, env } = setup();
    currentDb = db;
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 48 }), "consult");
    const stored = () => db.prepare("SELECT min_notice_min FROM availability_schedules WHERE creator_id=? AND listing_id=?").get("creator", "consult").min_notice_min;

    const first = await save(env, putRequest(scheduleBody(0, [], { listing_id: "consult", min_notice_min: 0, buffer_min: 25 }), "consult"));
    expect(first.min_notice_min).toBe(0);
    expect(first.effective_min_notice_min).toBe(48 * 60);
    expect(stored()).toBe(0);

    // What the native editor actually sends: the schedule it just loaded,
    // re-serialized (AvailabilitySchedule.fromJson -> toJson), with one UNRELATED
    // field changed. Before the reporting fix this carried 2880 back and the
    // creator's saved 0 became 2880 for good.
    const second = await save(env, putRequest({ schedule: { ...first, buffer_min: 30 } }, "consult"));
    expect(second.buffer_min).toBe(30);
    expect(second.min_notice_min).toBe(0);
    expect(second.effective_min_notice_min).toBe(48 * 60);
    expect(stored()).toBe(0);
    // The commercial floor is never written into the stored column: no schedule
    // row anywhere holds 2880 after the round-trip.
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_schedules WHERE min_notice_min=?").get(48 * 60).n).toBe(0);
  });

  it("reports the configured notice for a creator-wide schedule and inherits it into a listing", async () => {
    const { db, env } = setup();
    currentDb = db;
    db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("shared", "creator", null, "UTC", "shared", 60, 60, 10, 0, 8, 30, 1, "", Date.now());
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 48 }), "consult");

    const global = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule"), env);
    expect(global.status).toBe(200);
    const globalSchedule = (await global.json() as any).schedule;
    expect(globalSchedule.min_notice_min).toBe(0);
    expect(globalSchedule.effective_min_notice_min).toBe(0);
    expect(globalSchedule.effective.listing_commercial_notice_min).toBeNull();
    expect(globalSchedule.effective.notice_source).toBe("calendar");

    const listing = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule?listing_id=consult"), env);
    expect(listing.status).toBe(200);
    const listingSchedule = (await listing.json() as any).schedule;
    expect(listingSchedule.effective.inherited_from).toBe("global");
    expect(listingSchedule.effective.calendar_min_notice_min).toBe(0);
    expect(listingSchedule.min_notice_min).toBe(0);
    expect(listingSchedule.effective_min_notice_min).toBe(48 * 60);
    expect(listingSchedule.effective.notice_source).toBe("listing_commercial");
  });

  it("uses the legacy booking policy notice until a unified schedule row exists", async () => {
    const { db, env } = setup();
    currentDb = db;
    db.prepare("INSERT INTO booking_policies (user_id,buffer_min,min_notice_min,max_per_day,vacation_until) VALUES (?,?,?,?,?)")
      .run("creator", 10, 420, 8, null);
    db.prepare("UPDATE listings SET attrs=? WHERE id=?").run(JSON.stringify({ commercial_booking_notice_hours: 48 }), "consult");

    const globalResponse = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule"), env);
    expect(globalResponse.status).toBe(200);
    const globalSchedule = (await globalResponse.json() as any).schedule;
    expect(globalSchedule.min_notice_min).toBe(420);
    expect(globalSchedule.effective.calendar_min_notice_min).toBe(420);
    expect(globalSchedule.effective_min_notice_min).toBe(420);

    const listingResponse = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule?listing_id=consult"), env);
    expect(listingResponse.status).toBe(200);
    const listingSchedule = (await listingResponse.json() as any).schedule;
    expect(listingSchedule.min_notice_min).toBe(420);
    expect(listingSchedule.effective.calendar_min_notice_min).toBe(420);
    expect(listingSchedule.effective.effective.min_notice_min).toBe(48 * 60);
    expect(listingSchedule.effective_min_notice_min).toBe(48 * 60);

    const saved = await save(env, putRequest({ schedule: { ...listingSchedule, buffer_min: 25 } }, "consult"));
    expect(saved.buffer_min).toBe(25);
    expect(saved.min_notice_min).toBe(420);
    expect(saved.effective_min_notice_min).toBe(48 * 60);
    expect(db.prepare("SELECT min_notice_min FROM availability_schedules WHERE creator_id=? AND listing_id=?").get("creator", "consult").min_notice_min).toBe(420);
  });

  it("defaults missing legacy notice to 120 and lets explicit unified zero override legacy policy", async () => {
    const { db, env } = setup();
    currentDb = db;

    const absentPolicy = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule"), env);
    expect(absentPolicy.status).toBe(200);
    const absentPolicySchedule = (await absentPolicy.json() as any).schedule;
    expect(absentPolicySchedule.min_notice_min).toBe(120);
    expect(absentPolicySchedule.effective.calendar_min_notice_min).toBe(120);

    db.prepare("INSERT INTO booking_policies (user_id,buffer_min,min_notice_min,max_per_day,vacation_until) VALUES (?,?,?,?,?)")
      .run("creator", 10, 420, 8, null);
    db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("shared-zero", "creator", null, "UTC", "shared", 60, 60, 10, 0, 8, 30, 1, "", Date.now());

    const unified = await calendar.getSchedule(new Request("https://api.test/api/calendar/schedule"), env);
    expect(unified.status).toBe(200);
    const unifiedSchedule = (await unified.json() as any).schedule;
    expect(unifiedSchedule.min_notice_min).toBe(0);
    expect(unifiedSchedule.effective.calendar_min_notice_min).toBe(0);
    expect(unifiedSchedule.effective_min_notice_min).toBe(0);
  });
});
