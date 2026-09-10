import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "buyer" }));
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
  };
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
    CREATE TABLE gcal_accounts (user_id TEXT PRIMARY KEY);
    CREATE TABLE gcal_calendars (
      user_id TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER, last_error TEXT
    );
    CREATE TABLE gateway_orders (order_id TEXT PRIMARY KEY, gateway TEXT);
  `);
  db.exec(MIGRATION);
  const now = Date.now();
  db.prepare("INSERT INTO availability_schedules (id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,write_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("shared", "creator", null, "UTC", "shared", 60, 60, 0, 0, 8, 366, 1, "", now);
  for (let weekday = 0; weekday < 7; weekday++) {
    db.prepare("INSERT INTO availability_schedule_rules (id,schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?,?)")
      .run(`rule-${weekday}`, "shared", weekday, 0, 1440);
  }
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)")
    .run("consult", "creator", "consult", "Consult", "published", 60);
  return { db, env: { DB_META: d1(db) } };
}

let commercial: typeof import("../src/routes/commercial_checkout");
let currentDb: any;
beforeEach(async () => {
  H.uid = "buyer";
  commercial = await import("../src/routes/commercial_checkout");
});
afterEach(() => { currentDb?.close(); currentDb = null; });

function holdRequest(slotId: string, idem: string, holdId?: string): Request {
  return new Request("https://api.test/api/commercial/consult/consult/hold", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idem },
    body: JSON.stringify({ slot_id: slotId, ...(holdId ? { hold_id: holdId } : {}) }),
  });
}

describe("commercial availability holds against SQLite", () => {
  it("replays an owned hold, rejects foreign ownership, and refuses an expired hold", async () => {
    const { db, env } = setup();
    currentDb = db;
    const start = Math.ceil((Date.now() + 48 * 60 * 60_000) / 3_600_000) * 3_600_000;
    const slotId = `availability:consult:${start}:${start + 60 * 60_000}`;

    const created = await commercial.commercialHold(holdRequest(slotId, "hold-key-1"), env as any);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as any;
    expect(createdBody.hold_id).toBeTruthy();

    const replay = await commercial.commercialHold(holdRequest(slotId, "hold-key-1"), env as any);
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as any;
    expect(replayBody.hold_id).toBe(createdBody.hold_id);
    expect(replayBody.idempotent_replay).toBe(true);

    H.uid = "other-buyer";
    const foreign = await commercial.commercialHold(holdRequest(slotId, "other-key-1"), env as any);
    expect(foreign.status).toBe(409);

    H.uid = "buyer";
    db.prepare("UPDATE availability_reservations SET hold_expires_at=? WHERE id=?").run(Date.now() - 1, createdBody.hold_id);
    const foreignClaim = await commercial.claimCheckoutAvailability(env as any, {
      uid: "other-buyer", listingId: "consult", startAt: start, endAt: start + 60 * 60_000,
      sourceRef: "commercial-availability:other-buyer:order-1", holdId: createdBody.hold_id,
    });
    expect(foreignClaim).toMatchObject({ ok: false, reason: "hold_not_found" });
    const expiredClaim = await commercial.claimCheckoutAvailability(env as any, {
      uid: "buyer", listingId: "consult", startAt: start, endAt: start + 60 * 60_000,
      sourceRef: "commercial-availability:buyer:order-1", holdId: createdBody.hold_id,
    });
    expect(expiredClaim.ok).toBe(false);
    expect(["hold_expired", "hold_unavailable"]).toContain((expiredClaim as any).reason);
  });
});
