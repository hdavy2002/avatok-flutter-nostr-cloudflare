// @ts-nocheck -- test helper only (never imported by Worker code): node:sqlite behind a tiny D1 shim, as in hf_credits.test.ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

/** In-memory SQLite with the given migration files applied (ALTER TABLE lines dropped: D1 migration trap #6). */
export function makeDb(migrations: string[] = ["2026-10-10-hf-tokens.sql"]) {
  const db = new DatabaseSync(":memory:");
  for (const m of migrations) {
    const sql = readFileSync(new URL(`../../migrations/${m}`, import.meta.url), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n");
    db.exec(sql);
  }
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
    _raw: db,
  };
}
