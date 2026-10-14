import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { acquireHfScheduleWriteLock, releaseHfScheduleWriteLock } from "../src/lib/hf_booking_store";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
    close(): void;
  };
};
const migration = readFileSync(
  fileURLToPath(new URL("../migrations/2026-10-13-hf-bookings.sql", import.meta.url)), "utf8",
);

function testEnv(): { env: Env; close: () => void } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE hf_calls (id TEXT PRIMARY KEY);");
  db.exec(migration);
  const DB_META = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const statement = db.prepare(sql);
          return {
            first: async <T>() => statement.get(...args) as T | undefined,
            run: async () => statement.run(...args),
          };
        },
      };
    },
  };
  return { env: { DB_META } as unknown as Env, close: () => db.close() };
}

describe("HF booking schedule write gate", () => {
  it("admits one concurrent writer for a host and rejects the other", async () => {
    const { env, close } = testEnv();
    try {
      const now = Date.parse("2026-10-14T00:00:00Z");
      const results = await Promise.all([
        acquireHfScheduleWriteLock(env, "host-1", 0, now),
        acquireHfScheduleWriteLock(env, "host-1", 0, now),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((value) => value === null)).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("allows takeover only after expiry and protects the new writer token", async () => {
    const { env, close } = testEnv();
    try {
      const now = Date.parse("2026-10-14T00:00:00Z");
      const first = await acquireHfScheduleWriteLock(env, "host-1", 0, now);
      const second = await acquireHfScheduleWriteLock(env, "host-1", 0, now + 120_001);
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      await releaseHfScheduleWriteLock(env, "host-1", first!);
      const third = await acquireHfScheduleWriteLock(env, "host-1", 0, now + 120_002);
      expect(third).toBeNull();
    } finally {
      close();
    }
  });
});
