// usage.ts — per-dimension daily allowance counters + the single gate every
// metered AI service calls (Phase 1 subscription gating). Generalizes ai_quota.ts
// (which only knew `ava_turns`) to any billing dimension.
//
// STORE: KV (env.TOKENS), one key per uid per UTC day per dim, self-evicting TTL.
//   usage:{dim}:{uid}:{YYYY-MM-DD}
// A daily cap doesn't need atomicity (a rare concurrent double-count undercounts
// in the user's favour), so KV's eventual consistency is fine — same rationale as
// ai_quota.ts.
//
// GATING CONTRACT: `enforceAllowance` returns the SAME hard-stop shape the clients
// already understand for a 402/daily-cap, so a blocked call surfaces the upgrade
// popup with no new client work:
//   { allowed:false, reason:"plan_limit", dimension, cap, remaining:0, upsell:{tier,price_usd} }
//
// NOTE: while `billingEnabled` is false (beta), callers should SKIP the gate (or
// pass through) so nothing changes in production. The gate itself is pure; the
// decision to call it lives at each choke point.

import type { Env } from "../types";
import { capFor, nextTier, readPlans, type Dim, type TierId } from "../routes/plans";

function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
function kvKey(dim: Dim, uid: string, day = dayKey()): string {
  return `usage:${dim}:${uid}:${day}`;
}
const TTL_SECONDS = 2 * 24 * 60 * 60;

export interface AllowanceResult {
  allowed: boolean;
  reason?: "plan_limit";
  dimension: Dim;
  used: number;
  cap: number | null;          // null === unlimited
  remaining: number | null;    // null === unlimited
  upsell?: { tier: TierId; price_usd: number };
}

async function read(env: Env, dim: Dim, uid: string): Promise<number> {
  try {
    const raw = await env.TOKENS.get(kvKey(dim, uid));
    return raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
  } catch {
    return 0; // fail open
  }
}

async function bump(env: Env, dim: Dim, uid: string, units: number): Promise<number> {
  const key = kvKey(dim, uid);
  let used = 0;
  try {
    const raw = await env.TOKENS.get(key);
    used = (raw ? Math.max(0, parseInt(raw, 10) || 0) : 0) + units;
    await env.TOKENS.put(key, String(used), { expirationTtl: TTL_SECONDS });
  } catch {
    /* fail open — never block a turn on a counter write */
  }
  return used;
}

/**
 * Check (and, when allowed, consume) `units` of a daily dimension for `uid` on
 * `tier`. `units` is 1 for discrete actions (a chat turn, an image) or the
 * minutes elapsed this beat for per-minute services.
 *
 * `commit` defaults true (check + increment). Pass false to peek without
 * consuming (e.g. to render "remaining" without spending).
 */
export async function enforceAllowance(
  env: Env,
  uid: string,
  tier: TierId,
  dim: Dim,
  units = 1,
  opts: { commit?: boolean } = {},
): Promise<AllowanceResult> {
  const commit = opts.commit !== false;
  const plans = await readPlans(env);
  const cap = capFor(plans, tier, dim);

  // Unlimited dimension (Max tier, or any tier with a null cap): never counts.
  if (cap === null) {
    return { allowed: true, dimension: dim, used: 0, cap: null, remaining: null };
  }

  const used = await read(env, dim, uid);
  if (used + units > cap) {
    const up = nextTier(tier);
    return {
      allowed: false, reason: "plan_limit", dimension: dim, used, cap, remaining: Math.max(0, cap - used),
      upsell: up !== null ? { tier: up, price_usd: plans[up].priceUsd } : undefined,
    };
  }

  const after = commit ? await bump(env, dim, uid, units) : used + units;
  return { allowed: true, dimension: dim, used: after, cap, remaining: Math.max(0, cap - after) };
}

/** The 402-style JSON body a route returns when `enforceAllowance` blocks. */
export function planLimitBody(r: AllowanceResult): Record<string, unknown> {
  return {
    ok: false, blocked: true, reason: "plan_limit",
    dimension: r.dimension, cap: r.cap, remaining: r.remaining ?? 0,
    upsell: r.upsell ? { tier: r.upsell.tier, price_usd: r.upsell.price_usd } : undefined,
  };
}
