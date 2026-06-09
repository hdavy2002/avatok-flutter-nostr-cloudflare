// Strike escalation (spec §8.5): strike 1 = 24h, 2 = 7d, 3 = perm ban.
import type { Env } from "./types";

const DAY = 86_400_000;

export async function applyStrike(
  env: Env, uid: string, category: string, evidence: string | null, confidence: number | null,
): Promise<void> {
  // clerk_user_id may not exist pre-Clerk-link; fall back to uid as the key.
  const link = await env.DB_META.prepare("SELECT clerk_user_id FROM clerk_nostr_link WHERE uid=?1")
    .bind(uid).first<{ clerk_user_id: string }>();
  const clerkId = link?.clerk_user_id ?? uid;

  const prior = await env.DB_META.prepare("SELECT count(*) AS c FROM account_strikes WHERE uid=?1")
    .bind(uid).first<{ c: number }>();
  const n = (prior?.c ?? 0) + 1;

  let action: string, status: string, until: number | null;
  if (n === 1) { action = "temp_block"; status = "temp_blocked"; until = Date.now() + DAY; }
  else if (n === 2) { action = "temp_block"; status = "temp_blocked"; until = Date.now() + 7 * DAY; }
  else { action = "perm_ban"; status = "perm_banned"; until = null; }

  await env.DB_META.batch([
    env.DB_META.prepare(
      `INSERT INTO account_strikes (id,uid,clerk_user_id,category,evidence_url,ai_confidence,source,action_taken,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,'ai_auto',?7,?8)`,
    ).bind(crypto.randomUUID(), uid, clerkId, category, evidence, confidence, action, Date.now()),
    env.DB_META.prepare(
      `INSERT INTO account_status (clerk_user_id,uid,status,reason,blocked_until,blocked_at)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(clerk_user_id) DO UPDATE SET status=?3, reason=?4, blocked_until=?5, blocked_at=?6`,
    ).bind(clerkId, uid, status, category, until, Date.now()),
  ]);
}
