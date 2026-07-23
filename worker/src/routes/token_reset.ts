// [TOKENS-100-GRANT-1] ONE-TIME token HARD RESET (owner decision 2026-07-23).
//
// ⚠️ DESTRUCTIVE + OWNER-DIRECTED. This resets EVERY user's wallet to EXACTLY 100
// spendable tokens — including users who purchased or spent (paid balance IS wiped).
// It exists because per-user balances live in the WalletDO's own SQLite (the D1
// `wallet_balances` table is only an eventually-consistent AUDIT MIRROR), so there
// is NO SQL statement that can reset real balances — the authority is the DO, and
// the only correct reset is to page the users table and issue the DO `hard_reset`
// op per uid. That is exactly what welcome_bonus.ts already does for the +100 grant;
// this mirrors it.
//
// The reset amount is delivered into the PERSISTENT welcome/promo bucket (`acct.bonus`)
// so, combined with DAILY_FREE_GRANT=0, every account lands in the same one-time,
// non-renewable "join and explore" state: 100 tokens, no daily/monthly refill.
//
// Idempotent per uid on op_id `hardreset:v1:<uid>` — re-running the backfill (resume
// after a timeout, retry a failed page) can NEVER double-apply. To run the reset a
// SECOND time later you must bump RESET_VERSION (new op_id) — a deliberate guard so a
// routine re-run of the loop doesn't silently re-zero someone's later top-up.
//
//   POST /api/admin/token-hard-reset[/:secret]?cursor=&batch=&amount=
//     Auth: ADMIN_UIDS Clerk bearer (requireAdmin) on the bare path, OR the
//     shared-secret trailing path segment (env.TOKEN_RESET_SECRET — fails CLOSED
//     when unset). Returns { processed, reset, next_cursor } — loop until next_cursor
//     is null. See worker/migrations/2026-07-23-token-hard-reset-100.md for the exact
//     run procedure, the count/backup steps, and the D1-mirror alignment SQL.
import type { Env } from "../types";
import { json } from "../util";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { requireAdmin } from "./admin_money";

export const HARD_RESET_TOKENS = 100;
const RESET_VERSION = "v1"; // bump to re-authorize a fresh reset (new idempotency key)

/**
 * Hard-reset a single user's wallet to exactly HARD_RESET_TOKENS spendable tokens.
 * Idempotent — the WalletDO dedupes on op_id `hardreset:<version>:<uid>`, so calling
 * this any number of times resets exactly once. `reset` is true only on the FIRST
 * application (a replay returns duplicate:true).
 */
export async function hardResetTokens(env: Env, uid: string, amount = HARD_RESET_TOKENS): Promise<{ ok: boolean; reset: boolean }> {
  const ref = `hardreset:${RESET_VERSION}:${uid}`;
  // NOTE: deliberately NO double-entry `ledger` row. A hard reset sets the DO to an
  // ABSOLUTE value and wipes any prior PAID balance, which no single per-user ledger
  // entry can represent honestly (we don't know each user's prior paid coins here) —
  // emitting one would credit the ledger wrongly and trip nightly recon. We record
  // only the plain wallet_transactions audit row (type 'adjustment'). Recon must be
  // re-baselined after the run — see the migration doc.
  const r = await walletOp(env, uid, {
    op: "hard_reset", uid, amount, type: "adjustment",
    app_name: "token_hard_reset", ref, op_id: ref,
  });
  const ok = r.status === 200 && r.body?.ok === true;
  const reset = ok && r.body?.duplicate !== true;
  if (reset) {
    // Email/phone-stamped telemetry so the reset is auditable per tester in PostHog.
    try {
      const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
      await trackUserContact(env, uid, c.email, c.phone, "token_hard_reset", "avawallet", { tokens: amount });
    } catch { /* telemetry best-effort */ }
  }
  return { ok, reset };
}

// POST /api/admin/token-hard-reset[/:secret]?cursor=&batch=&amount=
export async function tokenHardResetBackfill(req: Request, env: Env, secret?: string): Promise<Response> {
  if (secret !== undefined) {
    if (!env.TOKEN_RESET_SECRET || secret !== env.TOKEN_RESET_SECRET) {
      return json({ error: "forbidden" }, 403);
    }
  } else {
    const a = await requireAdmin(req, env);
    if (a instanceof Response) return a;
  }
  const u = new URL(req.url);
  const cursor = (u.searchParams.get("cursor") || "").trim();
  const amount = Math.max(0, Math.trunc(Number(u.searchParams.get("amount") || HARD_RESET_TOKENS)) || HARD_RESET_TOKENS);
  // Batch ≤200; default 50 keeps the per-invocation subrequest budget safe (each
  // reset = 1 DO fetch + contactFor lookups + PostHog), same as welcome-backfill.
  const batch = Math.min(200, Math.max(1, Math.trunc(Number(u.searchParams.get("batch") || 50)) || 50));
  const rs = await metaDb(env).prepare(
    "SELECT uid FROM users WHERE uid > ?1 ORDER BY uid LIMIT ?2",
  ).bind(cursor, batch).all<{ uid: string }>();
  const rows = (rs.results ?? []) as { uid: string }[];
  let reset = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const g = await hardResetTokens(env, String(row.uid), amount);
      if (g.reset) reset++;
      if (!g.ok) failed.push(String(row.uid));
    } catch { failed.push(String(row.uid)); }
  }
  return json({
    processed: rows.length,
    reset,
    amount,
    next_cursor: rows.length === batch && rows.length > 0 ? String(rows[rows.length - 1].uid) : null,
    ...(failed.length ? { failed } : {}),
  });
}
