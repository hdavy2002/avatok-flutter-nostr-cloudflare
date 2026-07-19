// [WELCOME-100-1] 100-token welcome bonus (Specs/PLAN-2026-07-19-onboarding-
// bonus-analytics.md §A; owner decisions 2026-07-19: bonus is retroactive for
// ALL existing users). The grant lands in the WalletDO's PERSISTENT promo
// bucket (`acct.bonus`, op "promo_credit"): spendable on AI/feature costs
// exactly like daily free coins, but never part of the paid balance — so it can
// never be paid out. Idempotent on op_id `welcome:<uid>`: re-login, re-publish,
// racing requests, and backfill re-runs can never double-grant.
//
//   grantWelcomeBonus(env, uid)                — signup hook (api.ts profileUpsert)
//   POST /api/admin/welcome-backfill[/:secret]?cursor=&batch=
//     One-time retroactive grant, pages the users table (DB_META) by uid and
//     issues the SAME idempotent grant per user. Auth: ADMIN_UIDS Clerk bearer
//     (requireAdmin) on the bare path, OR the VOBIZ-style shared-secret trailing
//     path segment (env.WELCOME_BACKFILL_SECRET — fails CLOSED when unset) so
//     the owner's host shell can drive it without minting a Clerk token.
//     Returns { processed, credited, next_cursor } — loop until next_cursor null.
import type { Env } from "../types";
import { json } from "../util";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import { acctUser } from "../ledger";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { requireAdmin } from "./admin_money";

export const WELCOME_BONUS_TOKENS = 100;

/**
 * Grant the welcome bonus into the persistent promo bucket. Idempotent — the
 * WalletDO dedupes on op_id `welcome:<uid>`, so calling this any number of
 * times credits exactly once. `granted` is true only on the FIRST application.
 */
export async function grantWelcomeBonus(env: Env, uid: string): Promise<{ ok: boolean; granted: boolean }> {
  const ref = `welcome:${uid}`;
  const r = await walletOp(env, uid, {
    op: "promo_credit", uid, amount: WELCOME_BONUS_TOKENS, type: "promo",
    app_name: "welcome_bonus", ref, op_id: ref,
    ledger: {
      debit: "external:promo", credit: acctUser(uid), type: "promo", ref,
      meta: JSON.stringify({ title: "Welcome bonus", source: "welcome_bonus", tokens: WELCOME_BONUS_TOKENS }),
    },
  });
  const ok = r.status === 200 && r.body?.ok === true;
  const granted = ok && r.body?.duplicate !== true;
  if (granted) {
    // Email-stamped telemetry (contactFor) so support can pull this by tester
    // email/phone in PostHog. Best-effort — never blocks the grant.
    try {
      const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
      await trackUserContact(env, uid, c.email, c.phone, "welcome_bonus_granted", "avawallet", { tokens: WELCOME_BONUS_TOKENS });
    } catch { /* telemetry best-effort */ }
  }
  return { ok, granted };
}

// POST /api/admin/welcome-backfill[/:secret]?cursor=&batch=
export async function welcomeBackfill(req: Request, env: Env, secret?: string): Promise<Response> {
  if (secret !== undefined) {
    if (!env.WELCOME_BACKFILL_SECRET || secret !== env.WELCOME_BACKFILL_SECRET) {
      return json({ error: "forbidden" }, 403);
    }
  } else {
    const a = await requireAdmin(req, env);
    if (a instanceof Response) return a;
  }
  const u = new URL(req.url);
  const cursor = (u.searchParams.get("cursor") || "").trim();
  // Batch ≤200; default 50 keeps the per-invocation subrequest budget safe
  // (each fresh grant = 1 DO fetch + contactFor KV/Clerk lookups + PostHog).
  const batch = Math.min(200, Math.max(1, Math.trunc(Number(u.searchParams.get("batch") || 50)) || 50));
  const rs = await metaDb(env).prepare(
    "SELECT uid FROM users WHERE uid > ?1 ORDER BY uid LIMIT ?2",
  ).bind(cursor, batch).all<{ uid: string }>();
  const rows = (rs.results ?? []) as { uid: string }[];
  let credited = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const g = await grantWelcomeBonus(env, String(row.uid));
      if (g.granted) credited++;
      if (!g.ok) failed.push(String(row.uid));
    } catch { failed.push(String(row.uid)); }
  }
  return json({
    processed: rows.length,
    credited,
    next_cursor: rows.length === batch && rows.length > 0 ? String(rows[rows.length - 1].uid) : null,
    ...(failed.length ? { failed } : {}),
  });
}
