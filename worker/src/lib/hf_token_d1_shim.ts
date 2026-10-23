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
    try { db.exec(lines.filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n")); }
    catch (e) {
      // [HF-CALL-MODES-INT] A file that mixes an ALTER with an UPDATE / INDEX on the new column (2026-10-12-hf-call-presence-owner.sql) cannot run with its ALTERs
      // filtered out. Replay it statement by statement, in file order: the ALTER only when `alters` is set, and tolerate what an earlier partial run already did.
      if (!/no such column/.test(String(e))) throw e;
      const stmts = lines.map((l) => l.replace(/--.*$/, "")).join("\n").split(/;\s*\n|;\s*$/).map((x) => x.trim()).filter(Boolean);
      for (const s of stmts) {
        if (/^ALTER TABLE/i.test(s) && !o.alters) continue;
        try { db.exec(s + ";"); } catch (e2) { if (!/already exists|duplicate column|no such column/.test(String(e2))) throw e2; }
      }
    }
    // [HF-WALLET-RUPEES] production has the gp-r1 migration right after the token tables: tests see the same pricing and packs.
    if (m === "2026-10-10-hf-tokens.sql") db.exec(readFileSync(new URL("../../migrations/2026-10-10-hf-pricing-gpr1.sql", import.meta.url), "utf8"));
    if (o.alters) for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) { try { db.exec(l.replace(/--.*$/, "")); } catch { /* column already there */ } }
  }
  // [HF-STD-PLAN-1] production gets the Standard-plan columns and prepared-purchase snapshots before the parallel gp-r1/gp-r2 catalogue.
  for (const l of readFileSync(new URL("../../migrations/2026-10-11-hf-std-plan-alters.sql", import.meta.url), "utf8").split("\n").filter((x) => x.trim().startsWith("ALTER TABLE"))) {
    try { db.exec(l.replace(/--.*$/, "")); } catch { /* table absent or column already there */ }
  }
  if (migrations.includes("2026-10-10-hf-tokens.sql")) {
    db.exec(readFileSync(new URL("../../migrations/2026-10-11-hf-std-plan-play-snapshots.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../../migrations/2026-10-11-hf-std-plan-seed.sql", import.meta.url), "utf8"));
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
    batch: async (list: any[]) => { db.exec("BEGIN"); const results = []; try { for (const s of list) { const r = s._run(); results.push({ meta: { changes: Number(r.changes) } }); } db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return results; },
    _raw: db,
  };
}
