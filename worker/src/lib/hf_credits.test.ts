// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for

// [HF-WALLET-1] Runs the real hf_credits SQL against an in-memory SQLite (node:sqlite) behind a tiny D1 shim.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { grantTestCredits, reserveTestCredits, settleTestCredits, getTestBalance } from "./hf_credits";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  const sql = readFileSync(new URL("../../migrations/2026-10-09-hf-credits.sql", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n");
  db.exec(sql);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
    _run: () => db.prepare(q).run(...args),
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (list: any[]) => { db.exec("BEGIN"); try { for (const s of list) s._run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
  };
}

let env: any;
beforeEach(() => { env = { DB_META: makeDb() }; });

describe("hf_credits", () => {
  it("grant is idempotent per op id", async () => {
    const a = await grantTestCredits(env, "u1", 100, "op1", "x");
    const b = await grantTestCredits(env, "u1", 100, "op1", "x");
    expect(a).toEqual({ applied: true, balance: 100 });
    expect(b).toEqual({ applied: false, balance: 100 });
    await grantTestCredits(env, "u1", 50, "op2", "y");
    expect((await getTestBalance(env, "u1")).balance).toBe(150);
  });

  it("reserve holds min(available, max), is idempotent, and nothing for a user without credits", async () => {
    expect(await reserveTestCredits(env, "none", "c0", 100)).toBe(0);
    await grantTestCredits(env, "u1", 100, "g", "x");
    expect(await reserveTestCredits(env, "u1", "c1", 60)).toBe(60);
    expect(await reserveTestCredits(env, "u1", "c1", 60)).toBe(60); // retry
    expect(await getTestBalance(env, "u1")).toEqual({ balance: 40, reserved: 60 });
    expect(await reserveTestCredits(env, "u1", "c2", 500)).toBe(40); // second call takes the rest
    expect(await getTestBalance(env, "u1")).toEqual({ balance: 0, reserved: 100 });
  });

  it("settle consumes up to the hold, returns the remainder, and is idempotent", async () => {
    await grantTestCredits(env, "u1", 100, "g", "x");
    await reserveTestCredits(env, "u1", "c1", 60);
    expect(await settleTestCredits(env, "u1", "c1", 25)).toBe(25);
    expect(await settleTestCredits(env, "u1", "c1", 25)).toBe(25); // retry changes nothing
    expect(await getTestBalance(env, "u1")).toEqual({ balance: 75, reserved: 0 });
  });

  it("settle never spends more than was held, and a zero spend returns everything", async () => {
    await grantTestCredits(env, "u1", 30, "g", "x");
    await reserveTestCredits(env, "u1", "c1", 500);
    expect(await settleTestCredits(env, "u1", "c1", 999)).toBe(30);
    expect(await getTestBalance(env, "u1")).toEqual({ balance: 0, reserved: 0 });
    await grantTestCredits(env, "u1", 40, "g2", "x");
    await reserveTestCredits(env, "u1", "c2", 500);
    expect(await settleTestCredits(env, "u1", "c2", 0)).toBe(0);
    expect(await getTestBalance(env, "u1")).toEqual({ balance: 40, reserved: 0 });
  });

  it("settle with no hold is a no-op", async () => {
    expect(await settleTestCredits(env, "u1", "never", 10)).toBe(0);
  });
});
