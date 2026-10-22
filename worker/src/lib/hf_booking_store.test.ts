// @ts-nocheck -- uses node:sqlite (via the D1 shim), which the worker tsconfig has no types for
// [HF-FIX-AVAIL-SAVE-1] Schedule compare-and-save against the REAL SQL: first save, repeated saves, stale version, lock rules.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  acquireHfScheduleWriteLock, emptyHfBookingSchedule, getHfBookingSchedule, releaseHfScheduleWriteLock, saveHfBookingSchedule,
} from "./hf_booking_store";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

// Only the two tables this path touches, taken verbatim from the real migration (the rest of it needs other migrations' columns).
function makeEnv() {
  const sql = readFileSync(new URL("../../migrations/2026-10-13-hf-bookings.sql", import.meta.url), "utf8");
  const db = new DatabaseSync(":memory:");
  for (const t of ["hf_availability_schedules", "hf_booking_schedule_locks"]) {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`table ${t} not found in migration`);
    db.exec(m[0]);
  }
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { db.prepare(q).run(...args); return {}; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
  });
  return { DB_META: { prepare: (q: string) => stmt(q), _raw: db } };
}

let env: any;
beforeEach(() => { env = makeEnv(); });

const sched = (buffer = 0) => ({ ...emptyHfBookingSchedule(), bufferMinutes: buffer });
const NOW = 1_800_000_000_000;

async function save(expected: number, buffer = 0, now = NOW) {
  const token = await acquireHfScheduleWriteLock(env, "h1", expected, now);
  expect(token).toBeTruthy();
  const v = await saveHfBookingSchedule(env, "h1", expected, token!, sched(buffer), now);
  await releaseHfScheduleWriteLock(env, "h1", token!); // the routes release the lease after every save
  return v;
}

describe("saveHfBookingSchedule", () => {
  it("first save v0 -> 1, then repeated saves keep working (v1 -> 2 -> 3)", async () => {
    expect(await save(0)).toBe(1);
    expect(await save(1, 5)).toBe(2);
    expect(await save(2, 10)).toBe(3);
    expect((await getHfBookingSchedule(env, "h1")).bufferMinutes).toBe(10);
  });

  it("saving with zero edits still succeeds at version >= 1", async () => {
    await save(0);
    expect(await save(1)).toBe(2);
  });

  it("refuses a stale expectedVersion and changes nothing", async () => {
    await save(0); await save(1, 5);
    const token = await acquireHfScheduleWriteLock(env, "h1", 2, NOW);
    expect(token).toBeTruthy();
    expect(await saveHfBookingSchedule(env, "h1", 1, token!, sched(99), NOW)).toBeNull();
    expect((await getHfBookingSchedule(env, "h1")).bufferMinutes).toBe(5);
  });

  it("refuses v0 insert when a row already exists", async () => {
    await save(0);
    const token = await acquireHfScheduleWriteLock(env, "h1", 1, NOW);
    expect(await saveHfBookingSchedule(env, "h1", 0, token!, sched(7), NOW)).toBeNull();
  });

  it("refuses expectedVersion >= 1 for a host with no row", async () => {
    env.DB_META._raw.exec("INSERT INTO hf_booking_schedule_locks(host_uid,token,expires_at) VALUES('h1','t',9999999999999)");
    expect(await saveHfBookingSchedule(env, "h1", 1, "t", sched(), NOW)).toBeNull();
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) c FROM hf_availability_schedules").get().c).toBe(0);
  });

  it("refuses a missing, wrong or expired lock", async () => {
    await save(0);
    expect(await saveHfBookingSchedule(env, "h1", 1, "nope", sched(3), NOW)).toBeNull();
    const token = await acquireHfScheduleWriteLock(env, "h1", 1, NOW, 2_000);
    expect(await saveHfBookingSchedule(env, "h1", 1, token!, sched(3), NOW + 5_000)).toBeNull();
    expect((await getHfBookingSchedule(env, "h1")).version).toBe(1);
  });
});
