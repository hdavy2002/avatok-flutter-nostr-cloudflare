// [AUDIT-5/6] Google readiness parity, status freshness and manual sync.
//
// These are the invariants a creator's "Connected" badge depends on:
//   * status `ready`/`reason` come from the booking authority's predicate;
//   * the headline `last_success_at` is the OLDEST selected sync, so a fresh
//     calendar can never mask a stale selected one;
//   * preview slots are unbookable whenever the booking path would refuse;
//   * "Sync busy times now" imports and is bounded/rate-limited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "creator" }));
const T = vi.hoisted(() => ({ events: [] as Array<{ uid: string; event: string; app: string; props: Record<string, unknown> }> }));
vi.mock("../src/authz", () => ({
  requireUser: async () => ({ uid: H.uid }),
  isFail: (value: any) => Boolean(value?.error),
}));
vi.mock("../src/hooks", () => ({
  // Records what the route ACTUALLY emitted, so a "completed" that should have
  // been "failed"/"partial" fails the test instead of passing on trust.
  track: async (_env: any, uid: string, event: string, app: string, props: Record<string, unknown> = {}) => {
    T.events.push({ uid, event, app, props });
  },
  // Reachable through src/util.ts -> src/lib/ava_reason.ts; declared so the
  // mocked module namespace is complete for every importer in this graph.
  trackUser: async () => undefined,
  brainFact: async () => undefined,
}));

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
    // calendar.ts reads through metaSession(); the shim keeps one writer.
    withSession() { return wrapped; },
  };
  return wrapped;
}

const HOUR = 3_600_000;

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
      title TEXT, status TEXT NOT NULL, gcal_event_id TEXT, created_at INTEGER
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
    CREATE TABLE gcal_accounts (
      user_id TEXT PRIMARY KEY, email TEXT, refresh_token_enc TEXT NOT NULL DEFAULT '',
      access_token TEXT, access_expires_at INTEGER, sync_token TEXT,
      channel_id TEXT, resource_id TEXT, channel_expires_at INTEGER,
      connected_at INTEGER, last_sync_at INTEGER, last_error TEXT
    );
  `);
  db.exec(AVAILABILITY);
  db.exec(GCAL_RELIABILITY);
  const now = Date.now();
  db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("shared", "creator", null, "UTC", "shared", 60, 60, 0, 0, 8, 366, 1, "", now);
  for (let weekday = 0; weekday < 7; weekday++) {
    db.prepare("INSERT INTO availability_schedule_rules (id,schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?,?)")
      .run(`rule-${weekday}`, "shared", weekday, 0, 1440);
  }
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min,attrs) VALUES (?,?,?,?,?,?,?)")
    .run("consult", "creator", "consult", "Consult", "published", 60, null);
  const env = {
    DB_META: d1(db),
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GCAL_TOKEN_KEY: "test-token-key",
    TOKENS: kv(),
  };
  return { db, env, now, kv: env.TOKENS };
}

/** Minimal in-memory KV with the surface `rateLimit` uses (get/put). The
 *  manual-sync throttle must survive an isolate change, so the test asserts the
 *  counters land in KV rather than in a module-level Map. */
function kv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> { return store.has(key) ? store.get(key)! : null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
    async delete(key: string): Promise<void> { store.delete(key); },
    async list(): Promise<any> { return { keys: [...store.keys()].map((name) => ({ name })) }; },
  };
}

function connectAccount(db: any, uid: string, now = Date.now()): void {
  db.prepare("INSERT INTO gcal_accounts (user_id,email,refresh_token_enc,access_token,access_expires_at,connected_at,last_sync_at,last_error) VALUES (?,?,?,?,?,?,?,NULL)")
    .run(uid, `${uid}@example.test`, "encrypted-token", "access-token", now + HOUR, now, now);
}

function addCalendar(db: any, uid: string, id: string, opts: { selected?: number; lastSuccess?: number | null; lastError?: string | null; primary?: number } = {}): void {
  db.prepare("INSERT INTO gcal_calendars (user_id,calendar_id,summary,timezone,access_role,primary_calendar,selected,destination,last_success_at,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(uid, id, id, "UTC", "owner", opts.primary ?? 0, opts.selected ?? 1, 0, opts.lastSuccess ?? null, opts.lastError ?? null, Date.now());
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

function syncRequest(): Request {
  return new Request("https://api.test/api/calendar/gcal/sync", { method: "POST" });
}

let gcal: typeof import("../src/cal/gcal");
let calendar: typeof import("../src/routes/calendar_availability");
let currentDb: any;
beforeEach(async () => {
  H.uid = "creator";
  T.events.length = 0;
  gcal = await import("../src/cal/gcal");
  calendar = await import("../src/routes/calendar_availability");
});
afterEach(() => { vi.unstubAllGlobals(); currentDb?.close(); currentDb = null; });

describe("Google Calendar status freshness", () => {
  it("reports the OLDEST selected success and refuses to call a stale selection ready", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-status";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "fresh", { lastSuccess: now - 60_000 });
    addCalendar(db, H.uid, "stale", { lastSuccess: now - 2 * HOUR });

    const response = await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    // The old field keeps its old meaning (most recent success anywhere)...
    expect(body.last_sync_at).toBe(now - 60_000);
    // ...but the readiness headline is the weakest selected source.
    expect(body.last_success_at).toBe(now - 2 * HOUR);
    expect(body.newest_last_success_at).toBe(now - 60_000);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("stale");
    expect(body.stale_count).toBe(1);
    expect(body.selected_count).toBe(2);
    expect(body.calendars.find((row: any) => row.id === "stale").stale).toBe(true);
    expect(body.calendars.find((row: any) => row.id === "fresh").stale).toBe(false);
  });

  it("ignores an unselected stale calendar for readiness but still flags it", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-unselected";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "fresh", { selected: 1, lastSuccess: now - 60_000 });
    addCalendar(db, H.uid, "old-unselected", { selected: 0, lastSuccess: now - 5 * HOUR });

    const body = await (await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any)).json() as any;
    expect(body.ready).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.last_success_at).toBe(now - 60_000);
    expect(body.calendars.find((row: any) => row.id === "old-unselected").stale).toBe(true);
  });

  it("is not ready while a selected calendar has never synced or has failed", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-pending";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "never", { lastSuccess: null });
    let body = await (await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any)).json() as any;
    expect(body).toMatchObject({ ready: false, reason: "pending", last_success_at: null });

    db.prepare("UPDATE gcal_calendars SET last_success_at=?, last_error=? WHERE user_id=? AND calendar_id=?")
      .run(now - 60_000, "Google event sync failed (500)", H.uid, "never");
    body = await (await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any)).json() as any;
    expect(body).toMatchObject({ ready: false, reason: "error", last_success_at: now - 60_000 });
    expect(body.failed_count).toBe(1);
  });

  it("never labels a disconnected account ready", async () => {
    const { db, env } = setup();
    currentDb = db;
    H.uid = "creator-disconnected";
    const response = await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any);
    const body = await response.json() as any;
    expect(body.connected).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("disconnected");
    expect(body.last_success_at).toBeNull();
    expect(body.calendars).toEqual([]);
  });

  it("treats a NULL or zero last_success_at as never synced, not as an epoch success", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-zero";
    connectAccount(db, H.uid, now);
    // A zero/NULL column is a missing timestamp. Number(null) is 0, and 0 is a
    // finite POSITIVE-looking epoch that would otherwise mark the source fresh
    // and fill the headline with 1970.
    addCalendar(db, H.uid, "never-null", { lastSuccess: null });
    addCalendar(db, H.uid, "never-zero", { lastSuccess: 0 });

    let body = await (await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any)).json() as any;
    expect(body).toMatchObject({ ready: false, reason: "pending", last_success_at: null, newest_last_success_at: null });
    expect(body.never_synced_count).toBe(2);
    expect(body.stale_count).toBe(2);
    expect(body.calendars.every((row: any) => row.stale)).toBe(true);
    // The preserved old field must never read back as a 1970 success either.
    expect(Number(body.last_sync_at ?? 0)).toBeGreaterThan(0);

    // One source syncs: the headline stays null because the OTHER selected
    // source still has no success at all.
    db.prepare("UPDATE gcal_calendars SET last_success_at=? WHERE user_id=? AND calendar_id='never-zero'").run(now - 60_000, H.uid);
    body = await (await gcal.gcalStatus(new Request("https://api.test/api/calendar/gcal/status"), env as any)).json() as any;
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("pending");
    expect(body.last_success_at).toBeNull();
    expect(body.newest_last_success_at).toBeNull();
    expect(body.calendars.find((row: any) => row.id === "never-zero").stale).toBe(false);
    expect(body.calendars.find((row: any) => row.id === "never-null").stale).toBe(true);
  });

  it("keeps a fresh calendar response fresh when it is the first row of the map", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-list";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "primary", { primary: 1, lastSuccess: now - 60_000 });
    addCalendar(db, H.uid, "old", { lastSuccess: now - 5 * HOUR });
    // Regression: `rows.map(calendarResponse)` used to pass (row, index, array),
    // so index 0 became maxAgeMs=0 and the freshest source rendered stale.
    fakeFetch([{ status: 200, body: { items: [
      { id: "primary", summary: "Primary", timeZone: "UTC", primary: true, accessRole: "owner" },
      { id: "old", summary: "Old", timeZone: "UTC", accessRole: "owner" },
    ] } }]);
    const response = await gcal.gcalCalendars(new Request("https://api.test/api/calendar/gcal/calendars"), env as any);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.calendars.map((row: any) => [row.id, row.stale])).toEqual([["primary", false], ["old", true]]);
  });
});

describe("manual Google sync", () => {
  it("imports busy times, returns the same status, then throttles a repeat call", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-sync";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "primary", { lastSuccess: now - 4 * HOUR, lastError: "stale source" });
    const calls = fakeFetch([
      { status: 200, body: { id: "channel-1", resourceId: "resource-1", expiration: String(now + 6 * 24 * HOUR) } },
      { status: 200, body: { items: [], nextSyncToken: "sync-token-1" } },
    ]);

    const first = await gcal.gcalSyncNow(syncRequest(), env as any);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.imported).toBe(0);
    expect(firstBody.ready).toBe(true);
    expect(firstBody.reason).toBeNull();
    expect(Number(firstBody.last_success_at)).toBeGreaterThanOrEqual(now);
    expect(firstBody.calendars[0].last_error).toBeNull();
    expect(calls).toHaveLength(2);

    const second = await gcal.gcalSyncNow(syncRequest(), env as any);
    expect(second.status).toBe(429);
    const secondBody = await second.json() as any;
    expect(secondBody.code).toBe("gcal_sync_rate_limited");
    expect(secondBody.retry_after_ms).toBeGreaterThan(0);
    // A throttled call still reports real readiness instead of a bare error.
    expect(secondBody.ready).toBe(true);
    expect(calls).toHaveLength(2);
    // The throttle is the shared DURABLE KV window, not a per-isolate Map.
    expect([...env.TOKENS.store.keys()].some((key) => key.startsWith("rl:gcal-sync-burst:"))).toBe(true);
    expect([...env.TOKENS.store.keys()].some((key) => key.startsWith("rl:gcal-sync-window:"))).toBe(true);
  });

  it("refuses to sync a disconnected account and never touches permissions", async () => {
    const { db, env } = setup();
    currentDb = db;
    H.uid = "creator-sync-disconnected";
    const calls = fakeFetch([]);
    const response = await gcal.gcalSyncNow(syncRequest(), env as any);
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.code).toBe("gcal_disconnected");
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("disconnected");
    expect(calls).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gcal_calendars").get().n).toBe(0);
  });

  it("bounds how many selected calendars one sync reads", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-sync-bound";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "primary", {});
    addCalendar(db, H.uid, "work", {});
    const calls = fakeFetch([
      { status: 200, body: { id: "channel-1", resourceId: "resource-1", expiration: String(now + 6 * 24 * HOUR) } },
      { status: 200, body: { items: [], nextSyncToken: "sync-1" } },
    ]);
    expect(await gcal.importGcal(env as any, H.uid, { maxCalendars: 1 })).toBe(0);
    expect(calls).toHaveLength(2);
    const rows = db.prepare("SELECT calendar_id,last_success_at FROM gcal_calendars WHERE user_id=? ORDER BY calendar_id").all(H.uid);
    expect(rows.filter((row: any) => row.last_success_at !== null)).toHaveLength(1);
  });

  it("walks the selection oldest-first and reports a bounded run honestly", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-sync-bound-honest";
    connectAccount(db, H.uid, now);
    // 11 selected calendars, 1 above the per-call bound. Six have never synced
    // and the freshest one is the one a "first ten, same order" bound would
    // re-read (and mis-report) forever.
    const fresh = now - 5 * 60_000;
    for (let i = 1; i <= 6; i++) addCalendar(db, H.uid, `cal-0${i}`, { lastSuccess: null });
    for (let i = 7; i <= 10; i++) addCalendar(db, H.uid, `cal-${i}`, { lastSuccess: now - (30 - i) * HOUR });
    addCalendar(db, H.uid, "cal-11", { lastSuccess: fresh });
    const calls = fakeFetch(Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? { status: 200, body: { id: `channel-${index}`, resourceId: `resource-${index}`, expiration: String(now + 6 * 24 * HOUR) } }
      : { status: 200, body: { items: [], nextSyncToken: `sync-${index}` } }));

    const response = await gcal.gcalSyncNow(syncRequest(), env as any);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      bound_hit: true,
      calendars_selected: 11,
      calendars_attempted: 10,
      calendars_failed: 0,
      sync_outcome: "partial",
    });
    expect(calls).toHaveLength(20);
    const rows = db.prepare("SELECT calendar_id,last_success_at FROM gcal_calendars WHERE user_id=?").all(H.uid) as any[];
    // Only the freshest calendar was skipped, so a repeat sync covers it.
    expect(rows.find((row) => row.calendar_id === "cal-11").last_success_at).toBe(fresh);
    expect(rows.filter((row) => row.calendar_id !== "cal-11" && row.last_success_at === null)).toHaveLength(0);
    const emitted = T.events.find((row) => row.event === "gcal_manual_sync");
    expect(emitted?.props).toMatchObject({ outcome: "partial", bound_hit: true, calendars_attempted: 10, calendars_selected: 11, ready: true });
  });

  it("records a failed outcome and an errored source instead of claiming success", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-sync-failed";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "primary", { lastSuccess: null });
    const calls = fakeFetch([
      { status: 200, body: { id: "channel-1", resourceId: "resource-1", expiration: String(now + 6 * 24 * HOUR) } },
      { status: 500, body: { error: "backend error" } },
    ]);

    const response = await gcal.gcalSyncNow(syncRequest(), env as any);
    // The import itself is bounded and per-calendar failures are recorded, so
    // the HTTP call still settles — but it settles telling the truth.
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.calendars_attempted).toBe(1);
    expect(body.calendars_failed).toBe(1);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("error");
    expect(body.sync_outcome).toBe("failed");
    expect(body.last_error).toContain("500");
    expect(calls).toHaveLength(2);
    const emitted = T.events.find((row) => row.event === "gcal_manual_sync");
    expect(emitted?.props).toMatchObject({ outcome: "failed", calendars_failed: 1, ready: false, reason: "error" });
  });

  it("fails closed when the durable rate limiter is unavailable", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator-sync-no-kv";
    connectAccount(db, H.uid, now);
    addCalendar(db, H.uid, "primary", { lastSuccess: now - 4 * HOUR });
    const calls = fakeFetch([]);
    const noKv = { ...env, TOKENS: undefined } as any;

    const response = await gcal.gcalSyncNow(syncRequest(), noKv);
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.code).toBe("gcal_sync_unavailable");
    // No limiter ⇒ no sync. Falling back to a per-isolate counter is exactly the
    // unbounded-God-call behaviour the throttle exists to prevent.
    expect(calls).toHaveLength(0);
    expect(T.events.some((row) => row.event === "gcal_manual_sync")).toBe(false);
  });
});

describe("preview and booking agree about Google readiness", () => {
  it("answers 503 calendar_refresh_pending while the booking authority would refuse", async () => {
    const { db, env } = setup();
    currentDb = db;
    // No gcal_accounts row at all: the creator has never connected Google.
    const start = Math.ceil((Date.now() + 48 * HOUR) / HOUR) * HOUR;
    const date = new Date(start).toISOString().slice(0, 10);

    const booking = await import("../src/cal/engine");
    const refusal = await booking.validateListingSlot(env as any, "consult", start, start + HOUR, { now: Date.now() - 1_000 });
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toBe("calendar_refresh_pending");

    const response = await calendar.listingAvailability(
      new Request(`https://api.test/api/listings/consult/availability?from=${date}&to=${date}&timezone=UTC`),
      env as any,
      "consult",
    );
    // A 200 grid of `available:false` slots is indistinguishable from "no open
    // times" for every existing client, which rendered "0 open" instead of
    // "refresh your calendar". The pre-change error code is preserved.
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.error).toBe("calendar_refresh_pending");
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("disconnected");
    expect(body.last_success_at).toBeNull();
    // No fake empty availability.
    expect(body.slots).toBeUndefined();
    expect(body.days).toBeUndefined();
  });

  it("keeps the last known success on the 503 so a failed source is nameable", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    H.uid = "creator";
    connectAccount(db, H.uid, now);
    const lastSuccess = now - 4 * HOUR;
    addCalendar(db, H.uid, "primary", { lastSuccess, lastError: "Google event sync failed (500)" });
    const start = Math.ceil((Date.now() + 48 * HOUR) / HOUR) * HOUR;
    const date = new Date(start).toISOString().slice(0, 10);

    const response = await calendar.listingAvailability(
      new Request(`https://api.test/api/listings/consult/availability?from=${date}&to=${date}&timezone=UTC`),
      env as any,
      "consult",
    );
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body).toMatchObject({ error: "calendar_refresh_pending", ready: false, reason: "error", last_success_at: lastSuccess });
    expect(body.age_ms).toBeGreaterThan(0);
  });

  it("restores bookable slots once every selected source is fresh", async () => {
    const { db, env, now } = setup();
    currentDb = db;
    const uid = "creator";
    connectAccount(db, uid, now);
    addCalendar(db, uid, "primary", { selected: 1, lastSuccess: now - 60_000 });
    const start = Math.ceil((Date.now() + 48 * HOUR) / HOUR) * HOUR;
    const date = new Date(start).toISOString().slice(0, 10);

    const response = await calendar.listingAvailability(
      new Request(`https://api.test/api/listings/consult/availability?from=${date}&to=${date}&timezone=UTC`),
      env as any,
      "consult",
    );
    const body = await response.json() as any;
    expect(body.ready).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.slots.some((slot: any) => slot.available)).toBe(true);
  });
});
