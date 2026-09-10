import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};
const AVAILABILITY = readFileSync(
  fileURLToPath(new URL("../migrations/2026-09-10-unified-availability.sql", import.meta.url)),
  "utf8",
);
const GCAL_RELIABILITY = readFileSync(
  fileURLToPath(new URL("../migrations/2026-09-10-gcal-reliability.sql", import.meta.url)),
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
      const wrapped: any = {
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

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, duration_min INTEGER,
      starts_at INTEGER, ends_at INTEGER, attrs TEXT
    );
    CREATE TABLE listing_slots (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, status TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1, booked_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE calendar_blocks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_app TEXT NOT NULL,
      source_ref TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      title TEXT, status TEXT NOT NULL, gcal_event_id TEXT, created_at INTEGER
    );
    CREATE TABLE availability_reservations (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, listing_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, title TEXT, source_ref TEXT, hold_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcal_accounts (
      user_id TEXT PRIMARY KEY, email TEXT, refresh_token_enc TEXT NOT NULL,
      access_token TEXT, access_expires_at INTEGER, sync_token TEXT,
      channel_id TEXT, resource_id TEXT, channel_expires_at INTEGER,
      connected_at INTEGER, last_sync_at INTEGER, last_error TEXT
    );
  `);
  // Use the production reservation mirror triggers and the production export
  // mapping schema; only the network boundary is mocked below.
  db.exec(AVAILABILITY);
  db.exec(GCAL_RELIABILITY);
  const now = Date.now();
  const start = Math.ceil((now + 48 * 60 * 60_000) / 3_600_000) * 3_600_000;
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)")
    .run("listing-1", "creator", "consult", "Consult", "published", 60);
  db.prepare("INSERT INTO gcal_accounts (user_id,email,refresh_token_enc,access_token,access_expires_at,connected_at) VALUES (?,?,?,?,?,?)")
    .run("creator", "creator@example.test", "encrypted-token", "access-token", now + 3_600_000, now);
  db.prepare("INSERT INTO gcal_calendars (user_id,calendar_id,summary,timezone,access_role,primary_calendar,selected,destination,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("creator", "primary", "Primary", "UTC", "owner", 1, 1, 1, now);
  db.prepare("INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("reservation-1", "creator", "listing-1", "booking", "reserved", start, start + 60 * 60_000, "Consult", "booking:1", now, now);
  return { db, env: { DB_META: d1(db), GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", GCAL_TOKEN_KEY: "test-token-key" }, blockId: "availability:reservation-1", start };
}

type Call = { input: string; init?: RequestInit };
function fakeFetch(sequence: Array<{ status: number; body?: Record<string, unknown> }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const next = sequence.shift() ?? { status: 500, body: { error: "unexpected fetch" } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.body === undefined ? undefined : { "content-type": "application/json" },
    });
  }));
  return calls;
}

let gcal: typeof import("../src/cal/gcal");
let currentDb: any;
beforeEach(async () => { gcal = await import("../src/cal/gcal"); });
afterEach(() => { vi.unstubAllGlobals(); currentDb?.close(); currentDb = null; });

describe("Google Calendar availability export against SQLite", () => {
  it("exports a booking with Google default reminders and persists the event mapping", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const calls = fakeFetch([{ status: 200, body: { id: "google-event-1" } }]);
    await gcal.gcalExport(fixture.env as any, "creator", fixture.blockId, "upsert");
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.reminders).toEqual({ useDefault: true });
    expect(body.reminders.overrides).toBeUndefined();
    expect(body.visibility).toBe("private");
    expect(body.start.timeZone).toBe("UTC");
    expect(fixture.db.prepare("SELECT gcal_event_id FROM calendar_blocks WHERE id=?").get(fixture.blockId).gcal_event_id).toBe("google-event-1");
    expect(fixture.db.prepare("SELECT event_id,state FROM gcal_export_events WHERE block_id=?").get(fixture.blockId)).toMatchObject({ event_id: "google-event-1", state: "active" });
  });

  it("recovers a POST conflict with a PATCH to the stable Google event id", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const calls = fakeFetch([{ status: 409 }, { status: 200, body: { id: "stable-event" } }]);
    await gcal.gcalExport(fixture.env as any, "creator", fixture.blockId, "upsert");
    expect(calls).toHaveLength(2);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[1].init?.method).toBe("PATCH");
    const stableId = JSON.parse(String(calls[0].init?.body)).id;
    expect(calls[1].input).toContain(`/events/${stableId}`);
  });

  it("deletes a cancelled prior export once and skips an unexported cancellation", async () => {
    const fixture = setup(); currentDb = fixture.db;
    fixture.db.prepare("UPDATE calendar_blocks SET status='cancelled',gcal_event_id='old-event' WHERE id=?").run(fixture.blockId);
    fixture.db.prepare("INSERT INTO gcal_export_events (user_id,block_id,calendar_id,event_id,state,snapshot_status,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("creator", fixture.blockId, "primary", "old-event", "active", "busy", Date.now());
    const calls = fakeFetch([{ status: 204 }]);
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(fixture.db.prepare("SELECT state FROM gcal_export_events WHERE block_id=?").get(fixture.blockId).state).toBe("deleted");
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(0);
    expect(calls).toHaveLength(1);

    const unexported = setup();
    unexported.db.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE id=?").run(unexported.blockId);
    const noCalls = fakeFetch([]);
    expect(await gcal.gcalExportSweep(unexported.env as any)).toBe(0);
    expect(noCalls).toHaveLength(0);
    unexported.db.close();
  });

  it("does not fetch on an unchanged second sweep", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const calls = fakeFetch([{ status: 200, body: { id: "sweep-event" } }]);
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(1);
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("records temporary failures and backs off the next sweep", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const calls = fakeFetch([{ status: 503, body: { error: "temporary" } }]);
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(1);
    expect(calls).toHaveLength(1);
    const retry = fixture.db.prepare("SELECT state,retry_count,next_retry_at FROM gcal_export_events WHERE block_id=?").get(fixture.blockId);
    expect(retry.state).toBe("error");
    expect(retry.retry_count).toBe(1);
    expect(Number(retry.next_retry_at)).toBeGreaterThan(Date.now());
    expect(await gcal.gcalExportSweep(fixture.env as any)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("retires the old destination mapping before exporting to the selected destination", async () => {
    const fixture = setup(); currentDb = fixture.db;
    const now = Date.now();
    fixture.db.prepare("UPDATE gcal_calendars SET destination=0 WHERE user_id=? AND calendar_id='primary'").run("creator");
    fixture.db.prepare("INSERT INTO gcal_calendars (user_id,calendar_id,summary,timezone,access_role,primary_calendar,selected,destination,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("creator", "work", "Work", "UTC", "writer", 0, 1, 1, now);
    fixture.db.prepare("INSERT INTO gcal_export_events (user_id,block_id,calendar_id,event_id,state,updated_at) VALUES (?,?,?,?,?,?)")
      .run("creator", fixture.blockId, "primary", "old-destination-event", "active", now);
    const calls = fakeFetch([{ status: 204 }, { status: 200, body: { id: "new-destination-event" } }]);
    await gcal.gcalExport(fixture.env as any, "creator", fixture.blockId, "upsert");
    expect(calls).toHaveLength(2);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].input).toContain("/calendars/primary/events/old-destination-event");
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].input).toContain("/calendars/work/events");
  });
});
