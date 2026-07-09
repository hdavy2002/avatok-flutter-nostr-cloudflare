// ava_governor.ts — Phase D (first slice). The Global AI Governor as KV-config
// policy (plan §9/D13). No DO yet: the cron/feedback loop that ADJUSTS the
// policy from cost/latency signals arrives later; for now the policy is a
// hand-set (or script-set) KV blob and every ODL wake obeys it. Changing
// behaviour under load = one KV write, NO deploy (bible §5).
//
// KV KEY: `ava_governor` (env.TOKENS) — OVERRIDES layered over POLICY_DEFAULTS
// (same philosophy as the flag blob: store only what differs, never
// re-materialize the merged policy).
//
// Degradation ladder (plan §9): raise min_opportunity_floor → generation_off
// (templates still serve) → wake_only (detect + telemetry, never act) → paused.
//
// GUARDIAN IS NEVER GATED HERE. The Guardian regex+Nemotron safety floor is
// exempt from every Governor policy (Constitution 12) — Guardian code must not
// call governorGate(), and nothing in this module is imported by the Guardian
// scan path.

import type { Env } from "../types";

export interface GovernorPolicy {
  min_opportunity_floor: number; // global floor layered over capability.min_opportunity
  generation_off: boolean;       // reasoner generation paused; templates still serve
  wake_only: boolean;            // ODL detects + logs, but nothing may fire
  paused: boolean;               // everything (except Guardian) stops
  updated_at?: number;
}

export const POLICY_DEFAULTS: GovernorPolicy = {
  min_opportunity_floor: 0,
  generation_off: false,
  wake_only: false,
  paused: false,
};

const KEY = "ava_governor";

/** Merged policy: KV overrides over defaults. Fail-open to defaults. */
export async function readGovernorPolicy(env: Env): Promise<GovernorPolicy> {
  try {
    const stored = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<GovernorPolicy>;
    return { ...POLICY_DEFAULTS, ...stored };
  } catch {
    return { ...POLICY_DEFAULTS };
  }
}

/** Patch the stored policy (overrides only). Returns the merged result. */
export async function setGovernorPolicy(env: Env, patch: Partial<GovernorPolicy>): Promise<GovernorPolicy> {
  let stored: Partial<GovernorPolicy> = {};
  try { stored = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<GovernorPolicy>; } catch { /* fresh */ }
  const next = { ...stored, ...patch, updated_at: Date.now() };
  await env.TOKENS.put(KEY, JSON.stringify(next));
  return { ...POLICY_DEFAULTS, ...next };
}

export interface GovernorVerdict {
  allowed: boolean;
  reason: string | null; // "governor_paused" | "governor_wake_only" | "governor_floor" | null
  policy: GovernorPolicy;
}

/**
 * governorGate — may this capability act at this opportunity, under the
 * current global policy? Detection/telemetry always runs regardless (the ODL
 * calls this AFTER matching, to decide would_fire / fire) — the Governor
 * throttles ACTION and SPEND, never observation. Guardian never calls this.
 */
export async function governorGate(
  env: Env,
  capability: { id: string; cost_class: string },
  opportunity: number,
): Promise<GovernorVerdict> {
  const policy = await readGovernorPolicy(env);
  if (policy.paused) return { allowed: false, reason: "governor_paused", policy };
  if (policy.wake_only) return { allowed: false, reason: "governor_wake_only", policy };
  if (opportunity < policy.min_opportunity_floor) return { allowed: false, reason: "governor_floor", policy };
  return { allowed: true, reason: null, policy };
}
