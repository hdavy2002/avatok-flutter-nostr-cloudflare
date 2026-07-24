// ava_capabilities.ts — Phase C (ODL). The Capability Registry (plan D24/D25/D27).
//
// A capability is a ROLE'S permission slip: id + named owner + lifecycle +
// budgets + kill switch. The 8 v1 capabilities live here as an IN-CODE SEED —
// the source of truth, exactly like `DEFAULTS` in routes/config.ts. The KV blob
// `cap_registry` (env.TOKENS) holds OVERRIDES ONLY, layered over the seed at
// read time. NEVER re-materialize the merged registry back into KV — that pins
// stale values forever (same lesson as the flag blob).
//
// Lifecycle (D27): experimental → shadow → beta → production → deprecated →
// deleted. EVERY capability enters at "shadow" (fully running, full telemetry,
// ZERO user visibility). Promotion = a one-key KV override, e.g.
//   cap_registry = { "meeting": { "lifecycle": "beta" } }
// gated by the Capability Cost Ledger numbers (D25). No deploy needed (bible §5).

import type { Env } from "../types";
import type { TriggerCategory } from "./ava_triggers";

export type Lifecycle = "experimental" | "shadow" | "beta" | "production" | "deprecated" | "deleted";
export type CostClass = "none" | "low" | "medium" | "high";

export interface Capability {
  id: string;
  owner: string;          // a NAMED person (D25) — no owner, no capability
  role: string;           // which Ava role runs it (v1: all "copilot")
  lifecycle: Lifecycle;   // D27 — entry point is ALWAYS "shadow"
  cost_class: CostClass;  // Governor pauses "high" first under load
  min_opportunity: number;// 0–100 floor below which it stays silent
  daily_limit: number;    // platform-wide per-day circuit breaker (ava_budget counters)
  kill_switch: string;    // flag-blob key; explicitly `false` in KV = capability OFF
}

// ─────────────────────────────────────────────────────────────────────────────
// The 8 v1 capabilities (plan D9). ALL enter in "shadow" — deploying this
// changes NOTHING user-visible; the shadow events project acceptance (D27).
// ─────────────────────────────────────────────────────────────────────────────
// [AVA-ODL-POST-1] `meeting` and `reminder` are promoted to lifecycle:
// "production" — see ava_odl.ts step 6, which is the actual post path wired
// by that issue. This changes NOTHING observable: the funnel only reaches a
// production capability's post branch when BOTH `odlEnabled` AND
// `avaMomentsEnabled` are true in KV (both default false in prod,
// worker/src/routes/config.ts DEFAULTS), and each capability's own
// kill_switch flag is now a REAL, settable flag (declared in config.ts
// PlatformConfig + DEFAULTS in this same change — see the "fake flag" lesson
// in CLAUDE.md: a kill_switch key that config.ts never declares can never be
// flipped via scripts/flags.sh, so it would be a brake nobody could pull).
//
// `humor` and `auto_sticker` are two NEW v1.1 capabilities, both entering at
// "shadow" (D27 default) exactly like the original 8. They exist purely so a
// future promotion is a one-line lifecycle change:
//   - humor: a tasteful one-liner comment on obvious joke/celebration
//     patterns. No new trigger category was added — "trivially addable" per
//     the task, but a joke/celebration signal is NOT cheaply distinguishable
//     from the existing `festival` category with a regex (sarcasm/humor
//     detection is not a regex problem), so `humor` reuses the `festival`
//     trigger class via CATEGORY_TO_CAPABILITY below (celebration and humor
//     both key off `festival` matches; ava_odl.ts's `cats[0]` priority order
//     means `celebration` still wins the CATEGORY_TO_CAPABILITY lookup today
//     — humor is reachable once/if a future change lets one trigger fan out
//     to multiple candidate capabilities, which is out of scope here).
//   - auto_sticker: returns a sticker asset id (kind:"ava_sticker") for the
//     client's existing sticker renderer (app/lib/features/messaging/widgets/
//     sticker_packs.dart ships kStickerPacks with built-in packs). Reuses the
//     `festival`/`birthday` trigger classes the same way for the same reason.
export const CAPABILITY_SEED: Capability[] = [
  { id: "meeting",        owner: "davy", role: "copilot", lifecycle: "production", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapMeetingEnabled" },
  { id: "expense_split",  owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapExpenseSplitEnabled" },
  { id: "birthday",       owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 20000, kill_switch: "avaCapBirthdayEnabled" },
  { id: "otp_guard",      owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 40, daily_limit: 50000, kill_switch: "avaCapOtpGuardEnabled" },
  { id: "order_tracking", owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 20000, kill_switch: "avaCapOrderTrackingEnabled" },
  { id: "travel_plan",    owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapTravelPlanEnabled" },
  { id: "celebration",    owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 50000, kill_switch: "avaCapCelebrationEnabled" },
  { id: "reminder",       owner: "davy", role: "copilot", lifecycle: "production", cost_class: "low",  min_opportunity: 65, daily_limit: 20000, kill_switch: "avaCapReminderEnabled" },
  { id: "humor",          owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 65, daily_limit: 20000, kill_switch: "avaCapHumorEnabled" },
  { id: "auto_sticker",   owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 65, daily_limit: 20000, kill_switch: "avaCapAutoStickerEnabled" },
];

/**
 * Trigger category → v1 capability. Ambient contact markers feed reminder.
 * `humor`/`auto_sticker` are NOT wired here in v1 (see the comment above the
 * seed) — matchedCategories() → CATEGORY_TO_CAPABILITY is a strict 1:1 map,
 * and `festival` already routes to `celebration`. They stay reachable only
 * via a direct getCapability(env, "humor" | "auto_sticker") call (e.g. from a
 * future multi-candidate ODL pass or an ops/test route), which is enough for
 * their shadow telemetry to exist without changing today's funnel.
 */
export const CATEGORY_TO_CAPABILITY: Record<TriggerCategory, string> = {
  otp: "otp_guard",
  money: "expense_split",
  date_meeting: "meeting",
  birthday: "birthday",
  festival: "celebration",
  life_event: "reminder",
  commerce: "order_tracking",
  travel: "travel_plan",
  contact_marker: "reminder",
};

const REG_KEY = "cap_registry";

type Overrides = Record<string, Partial<Capability>>;

async function readOverrides(env: Env): Promise<Overrides> {
  try { return ((await env.TOKENS.get(REG_KEY, "json")) ?? {}) as Overrides; } catch { return {}; }
}

/** Merged registry: KV overrides layered over the in-code seed. Fail-open to seed. */
export async function getCapabilities(env: Env): Promise<Capability[]> {
  const over = await readOverrides(env);
  return CAPABILITY_SEED.map((c) => ({ ...c, ...(over[c.id] ?? {}) }));
}

/** One merged capability by id, or null if not in the seed. */
export async function getCapability(env: Env, id: string): Promise<Capability | null> {
  if (!id) return null;
  const seed = CAPABILITY_SEED.find((c) => c.id === id);
  if (!seed) return null;
  const over = await readOverrides(env);
  return { ...seed, ...(over[id] ?? {}) };
}

/**
 * Write an override for ONE capability (e.g. shadow → beta promotion). Stores
 * ONLY the patched keys for that id — the seed stays the layered source of
 * truth for everything else. Never writes the full merged registry.
 */
export async function setCapabilityOverride(env: Env, id: string, patch: Partial<Capability>): Promise<void> {
  const over = await readOverrides(env);
  over[id] = { ...(over[id] ?? {}), ...patch };
  await env.TOKENS.put(REG_KEY, JSON.stringify(over));
}
