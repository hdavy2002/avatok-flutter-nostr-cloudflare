// @ts-nocheck -- test helper only (never imported by Worker code): node:sqlite behind a tiny D1 shim, as in hf_credits.test.ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

/**
 * In-memory SQLite with the given migration files applied. Pass `alters: true` to also run each ALTER TABLE line on its own
 * (a duplicate column is ignored), for tests that need columns added by ALTER migrations (D1 migration trap #6 keeps them in separate files).
 */
export function makeDb(migrations: string[] = ["2026-10-10-hf-tokens.sql"], o: { alters?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of migrations) {
    const lines = readFileSync(new URL(`../../migrations/${m}`, import.meta.url), "utf8").split("\n");
    db.exec(lines.filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n"));
    // [HF-WALLET-RUPEES] production has the gp-r1 migration right after the token tables: tests see the same pricing and packs.
    if (m === "2026-10-10-hf-tokens.sql") db.exec(readFileSync(new URL("../../migrations/2026-10-10-hf-pricing-gpr1.sql", import.meta.url), "utf8"));
    if (o.alters) for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) { try { db.exec(l.replace(/--.*$/, "")); } catch { /* column already there */ } }
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
