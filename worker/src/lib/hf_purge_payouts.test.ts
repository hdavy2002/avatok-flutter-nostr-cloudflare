// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-PAYOUT-1] Account deletion keeps PAID withdrawal rows as anonymised financial records and deletes the rest.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { purgeHfUser } from "./hf_purge";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

describe("purgeHfUser: hf_payout_requests", () => {
  it("deletes unpaid rows, anonymises paid rows, leaves other hosts alone, and is idempotent", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../migrations/2026-10-09-hf-payouts.sql", import.meta.url), "utf8"));
    db.exec("CREATE TABLE hf_avatars (taken_by_uid TEXT)");
    const ins = db.prepare("INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, utr, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1)");
    ins.run("a1", "user_gone", 500, "paid", '{"accountLast4":"1234","name":"X"}', "UTR111111");
    ins.run("a2", "user_gone", 600, "requested", "{}", null);
    ins.run("a3", "user_gone", 700, "rejected", "{}", null);
    ins.run("b1", "user_stay", 800, "paid", '{"accountLast4":"9999"}', "UTR222222");
    const stmt = (q: string, args: unknown[] = []) => ({
      bind: (...a: unknown[]) => stmt(q, a),
      run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
      all: async () => ({ results: db.prepare(q).all(...args) }),
    });
    const env = { DB_META: { prepare: (q: string) => stmt(q) } };
    for (let i = 0; i < 2; i++) {
      const r = await purgeHfUser(env, "user_gone");
      expect(r.errors).toEqual([]);
    }
    const rows = db.prepare("SELECT id, host_uid, amount_rupees, utr, bank_snapshot FROM hf_payout_requests ORDER BY id").all();
    expect(rows.map((r) => r.id)).toEqual(["a1", "b1"]);
    expect(rows[0].host_uid).toMatch(/^del:[0-9a-f]{32}$/);
    expect(rows[0]).toMatchObject({ amount_rupees: 500, utr: "UTR111111", bank_snapshot: "{}" });
    expect(rows[1]).toMatchObject({ host_uid: "user_stay", bank_snapshot: '{"accountLast4":"9999"}' });
  });
});
