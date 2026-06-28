// Team billing indirection — Specs/TEAM-RECEPTIONIST-IVR-SPEC.md.
//
// When a staff member is on a Team plan, ALL their AvaTOK expenses must come out of
// the TEAM wallet, not their personal one. Rather than rewrite the money engine, we
// add ONE indirection at the single charge boundary: every feature/AI spend resolves
// `billingUidFor(env, uid)` and charges THAT uid's WalletDO. The op_id stays keyed to
// the originating member + action, so the audit trail still shows WHO spent while the
// MONEY leaves the team wallet. Ledger double-entry + nightly recon are unaffected.
//
// `team_billing_map` is denormalized (member_uid -> {team_id, billing_uid, member_tier})
// so this runs as a single PK read on the hot path.
import type { Env } from "./types";
import { metaSession } from "./db/shard";

export interface TeamMembership {
  teamId: string;
  billingUid: string;
  memberTier: number;
}

/** Resolve a member's team membership (null when they're not on a team). */
export async function teamMembershipOf(env: Env, uid: string): Promise<TeamMembership | null> {
  try {
    const r = await metaSession(env)
      .prepare("SELECT team_id, billing_uid, member_tier FROM team_billing_map WHERE member_uid=?1")
      .bind(uid)
      .first<{ team_id: string; billing_uid: string; member_tier: number }>();
    if (!r) return null;
    return { teamId: r.team_id, billingUid: r.billing_uid, memberTier: r.member_tier ?? 2 };
  } catch {
    return null; // fail-open to the member's own wallet/tier
  }
}

/**
 * The wallet that should pay for `uid`'s actions: the team wallet when `uid` is a
 * team member, else `uid` itself. Called on every paid feature charge.
 */
export async function billingUidFor(env: Env, uid: string): Promise<string> {
  const m = await teamMembershipOf(env, uid);
  return m?.billingUid ?? uid;
}

/** Team-granted entitlement tier (0 when not on a team). Merged into tierOf(). */
export async function teamTierOf(env: Env, uid: string): Promise<number> {
  const m = await teamMembershipOf(env, uid);
  return m?.memberTier ?? 0;
}

/** Bump a team's monthly AI-message pool counter, keyed by the team wallet uid.
 * Best-effort gauge for the manager's dashboard; never blocks the charge. */
export async function bumpTeamAiMsgPool(env: Env, billingUid: string): Promise<void> {
  try {
    await metaSession(env)
      .prepare("UPDATE teams SET ai_msg_used = ai_msg_used + 1, updated_at=?2 WHERE billing_uid=?1 AND status='active'")
      .bind(billingUid, Date.now()).run();
  } catch { /* gauge only */ }
}
