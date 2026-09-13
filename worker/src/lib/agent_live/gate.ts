// [AGENT-LIVE-1] Fail-closed lane gates (BUILD SPEC D12) + the sole-admin
// check (D2, R2 §7.1). Every agent_live route that can move money or open a
// provider session must call laneGate/talkGate BEFORE doing anything else.
import type { Env } from "../../types";
import type { PlatformConfig } from "../../routes/config";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { DEFAULT_SLOT_MINUTES } from "./types";

export type LaneGateFailReason =
  | "agent_listings_disabled"
  | "agent_checkout_disabled"
  | "agent_talk_disabled"
  | "agent_emergency_stop"
  | "openai_key_missing"
  | "agent_admin_unconfigured"
  | "join_link_secret_missing"
  | "agent_platform_capacity_misconfigured";

export type LaneGateResult = { ok: true } | { ok: false; reason: LaneGateFailReason };

/** Resolve `env.AGENT_ADMIN_UIDS` to the single provisioned admin uid, or
 * null when it is unset/empty/not exactly one uid (D2 — never an allowlist). */
export function adminUid(env: Env): string | null {
  const uids = (env.AGENT_ADMIN_UIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return uids.length === 1 ? uids[0] : null;
}

function baseChecks(env: Env, cfg: PlatformConfig): LaneGateResult {
  if (!cfg.agentListingsEnabled) return { ok: false, reason: "agent_listings_disabled" };
  if (!cfg.agentTalkEnabled) return { ok: false, reason: "agent_talk_disabled" };
  if (cfg.agentEmergencyStop) return { ok: false, reason: "agent_emergency_stop" };
  if (!env.OPENAI_API_KEY) return { ok: false, reason: "openai_key_missing" };
  if (!adminUid(env)) return { ok: false, reason: "agent_admin_unconfigured" };
  if (!env.JOIN_LINK_SECRET) return { ok: false, reason: "join_link_secret_missing" };
  if (!(cfg.agentPlatformMaxConcurrent > 0)) {
    return { ok: false, reason: "agent_platform_capacity_misconfigured" };
  }
  return { ok: true };
}

/** Full checkout/quote gate — D12. Fails closed before any wallet hold. */
export function laneGate(env: Env, cfg: PlatformConfig): LaneGateResult {
  if (!cfg.agentCheckoutEnabled) return { ok: false, reason: "agent_checkout_disabled" };
  return baseChecks(env, cfg);
}

/** Talk/prejoin gate — same as laneGate minus the checkout flag (D12). */
export function talkGate(env: Env, cfg: PlatformConfig): LaneGateResult {
  return baseChecks(env, cfg);
}

/** Parse `agentSlotMinutes` ("5,10,20,30,40,60") into a sorted subset of
 * DEFAULT_SLOT_MINUTES. Unknown/duplicate/out-of-range values are dropped;
 * an empty or unparsable result falls back to the full default list so a bad
 * KV write never zeroes out every slot length. */
export function slotMinutesFrom(cfg: PlatformConfig): number[] {
  const allowed = new Set<number>(DEFAULT_SLOT_MINUTES);
  const parsed = (cfg.agentSlotMinutes ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && allowed.has(n));
  const unique = Array.from(new Set(parsed)).sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_SLOT_MINUTES];
}

/** Gate for admin-only agent_live routes (D2, R2 §7.1). Returns `{uid}` on
 * success or a `Response` on failure, mirroring `requireAdmin` in
 * routes/admin_money.ts. */
export async function requireAgentAdmin(
  req: Request,
  env: Env,
): Promise<{ uid: string } | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = adminUid(env);
  if (!uid) return json({ error: "agent_admin_unconfigured" }, 503);
  if (ctx.uid !== uid) return json({ error: "agent_admin_only" }, 403);
  return { uid: ctx.uid };
}
