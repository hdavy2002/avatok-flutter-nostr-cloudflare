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
export const CAPABILITY_SEED: Capability[] = [
  { id: "meeting",        owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapMeetingEnabled" },
  { id: "expense_split",  owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapExpenseSplitEnabled" },
  { id: "birthday",       owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 20000, kill_switch: "avaCapBirthdayEnabled" },
  { id: "otp_guard",      owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 40, daily_limit: 50000, kill_switch: "avaCapOtpGuardEnabled" },
  { id: "order_tracking", owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 20000, kill_switch: "avaCapOrderTrackingEnabled" },
  { id: "travel_plan",    owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 60, daily_limit: 20000, kill_switch: "avaCapTravelPlanEnabled" },
  { id: "celebration",    owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "none", min_opportunity: 55, daily_limit: 50000, kill_switch: "avaCapCelebrationEnabled" },
  { id: "reminder",       owner: "davy", role: "copilot", lifecycle: "shadow", cost_class: "low",  min_opportunity: 65, daily_limit: 20000, kill_switch: "avaCapReminderEnabled" },
];

/** Trigger category → v1 capability. Ambient contact markers feed reminder. */
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
