// ava_group_policy.ts — [AVA-GROUP-COMPANION-1] Group Ava state + member
// prefs (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md I1/I2/I4/I5).
//
// Two additive D1 tables (worker/migrations/ava_group_companion.sql):
//   ava_group_state        — one row per group conv: mode, budget, cooldown.
//   ava_group_member_prefs — one row per (conv, uid): mute + muted capabilities.
//
// STAYS DARK end-to-end. Reaching ANY user-visible output out of this module
// requires ALL of: odlEnabled && avaMomentsEnabled && avaGroupCompanionEnabled
// (worker/src/routes/config.ts, all default false) AND the specific group's
// own ava_group_state.mode === 'companion' (I1 — per-group owner/admin
// opt-in, disclosed to members). The GET/PUT endpoints in messaging.ts that
// read/write ava_group_state are reachable regardless of the platform flags
// (so a client can render the toggle before the platform ships it) — they
// only ever change ROWS in a table nothing else reads while the flags are off.
//
// FAIL-CLOSED BY DESIGN (unlike ava_odl.ts's 1:1 gates, which mostly
// fail-open toward "keep evaluating, shadow mode has no user impact"): every
// read here defaults toward the LEAST Ava exposure on any error —
// getGroupState() → 'off', getMemberPrefs()/isMemberMuted() → muted=true,
// isCurrentGroupMember() → false. A D1 hiccup must never cause an unsolicited
// group post; it should only ever cause a missed one.

import type { Env } from "../types";

export type GroupAvaMode = "off" | "assistant" | "companion";

export interface GroupAvaState {
  conv: string;
  mode: GroupAvaMode;
  budgetTokensDaily: number; // v1: count-based daily cap on PUBLIC interventions — see migration header
  cooldownS: number;
  policyVersion: number;
  updatedBy: string | null;
  updatedAt: number;
}

export interface GroupMemberPrefs {
  conv: string;
  uid: string;
  muted: boolean;
  mutedCapabilities: string[];
  updatedAt: number;
}

const DEFAULT_COOLDOWN_S = 1800;   // I5 — 30 min between PUBLIC group interventions
const DEFAULT_BUDGET_DAILY = 20;   // v1 count-based cap on PUBLIC interventions/day (I4)
const POLICY_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// FNV-1a (32-bit) → hex. Deliberately duplicated rather than imported — the
// same local-copy idiom ava_odl.ts's fnv1aHex documents (matching
// brain_ingest.ts / inbox.ts): synchronous, no crypto.subtle await on a hot
// path, and this module must not import from ava_odl.ts (no such export
// exists, and re-exporting it there is outside this issue's file set).
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability groupScope classification (I2: "classify each candidate public
// vs private"). Kept HERE (a local allowlist) rather than adding a
// `groupScope` field to ava_capabilities.ts's CAPABILITY_SEED, even though the
// issue narrative describes the latter — ava_capabilities.ts is a shared
// registry file NOT in this issue's declared server-only file set, and other
// concurrent workstreams (composio/billing) may be touching Ava infra at the
// same time. A local allowlist here is additive, has zero blast radius on
// that file, and is trivially mergeable into CAPABILITY_SEED later if a
// maintainer wants the metadata to live there instead.
//
// Default is 'private' for anything NOT explicitly listed (fail closed —
// I2: "warnings/safety → private by default"). Only capabilities whose output
// is inherently group-appropriate and low-risk are public candidates.
const GROUP_PUBLIC_CAPABILITIES = new Set<string>([
  "birthday",     // festive, low risk, informational to the whole group
  "celebration",  // festive, low risk
  "meeting",      // scheduling nudge relevant to every invitee
  "humor",        // v1.1 shadow capability — tasteful one-liner
  "auto_sticker", // v1.1 shadow capability — sticker reaction
]);
// Everything else in CAPABILITY_SEED (expense_split, otp_guard, order_tracking,
// travel_plan, reminder) is personal/financial/safety-adjacent → private.

export function groupScopeOf(capabilityId: string): "public" | "private" {
  return GROUP_PUBLIC_CAPABILITIES.has(capabilityId) ? "public" : "private";
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Ava state
// ─────────────────────────────────────────────────────────────────────────────

export async function getGroupState(env: Env, conv: string): Promise<GroupAvaState> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT conv, mode, budget_tokens_daily, cooldown_s, policy_version, updated_by, updated_at
         FROM ava_group_state WHERE conv = ?1`,
    ).bind(conv).first<{
      conv: string; mode: string; budget_tokens_daily: number; cooldown_s: number;
      policy_version: number; updated_by: string | null; updated_at: number;
    }>();
    if (!r) return emptyGroupState(conv);
    const mode: GroupAvaMode = r.mode === "assistant" || r.mode === "companion" ? r.mode : "off";
    return {
      conv, mode,
      budgetTokensDaily: Number(r.budget_tokens_daily ?? DEFAULT_BUDGET_DAILY),
      cooldownS: Number(r.cooldown_s ?? DEFAULT_COOLDOWN_S),
      policyVersion: Number(r.policy_version ?? POLICY_VERSION),
      updatedBy: r.updated_by ?? null,
      updatedAt: Number(r.updated_at ?? 0),
    };
  } catch {
    return emptyGroupState(conv); // fail CLOSED — never enable Companion mode on a D1 hiccup
  }
}

function emptyGroupState(conv: string): GroupAvaState {
  return {
    conv, mode: "off", budgetTokensDaily: DEFAULT_BUDGET_DAILY, cooldownS: DEFAULT_COOLDOWN_S,
    policyVersion: POLICY_VERSION, updatedBy: null, updatedAt: 0,
  };
}

export async function setGroupState(
  env: Env, conv: string,
  patch: { mode?: GroupAvaMode; budgetTokensDaily?: number; cooldownS?: number },
  updatedBy: string,
): Promise<GroupAvaState> {
  const cur = await getGroupState(env, conv);
  const next: GroupAvaState = {
    conv,
    mode: patch.mode ?? cur.mode,
    budgetTokensDaily: patch.budgetTokensDaily ?? cur.budgetTokensDaily,
    cooldownS: patch.cooldownS ?? cur.cooldownS,
    policyVersion: cur.policyVersion || POLICY_VERSION,
    updatedBy,
    updatedAt: Date.now(),
  };
  await env.DB_META.prepare(
    `INSERT INTO ava_group_state (conv, mode, budget_tokens_daily, cooldown_s, policy_version, updated_by, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(conv) DO UPDATE SET
       mode = excluded.mode,
       budget_tokens_daily = excluded.budget_tokens_daily,
       cooldown_s = excluded.cooldown_s,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(next.conv, next.mode, next.budgetTokensDaily, next.cooldownS, next.policyVersion, next.updatedBy, next.updatedAt).run();
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-member prefs (mute)
// ─────────────────────────────────────────────────────────────────────────────

export async function getMemberPrefs(env: Env, conv: string, uid: string): Promise<GroupMemberPrefs> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT conv, uid, muted, muted_capabilities, updated_at FROM ava_group_member_prefs WHERE conv=?1 AND uid=?2`,
    ).bind(conv, uid).first<{ conv: string; uid: string; muted: number; muted_capabilities: string | null; updated_at: number }>();
    if (!r) return { conv, uid, muted: false, mutedCapabilities: [], updatedAt: 0 }; // no row yet = never muted
    let caps: string[] = [];
    try { const parsed = JSON.parse(r.muted_capabilities || "[]"); if (Array.isArray(parsed)) caps = parsed.map(String); } catch { /* ignore malformed json */ }
    return { conv, uid, muted: !!r.muted, mutedCapabilities: caps, updatedAt: Number(r.updated_at ?? 0) };
  } catch {
    // Fail CLOSED for a privacy control: treat an unreadable prefs row as
    // muted so a D1 hiccup can never cause an unsolicited nudge to reach a
    // member who may have muted it.
    return { conv, uid, muted: true, mutedCapabilities: [], updatedAt: 0 };
  }
}

export async function setMemberPrefs(
  env: Env, conv: string, uid: string,
  patch: { muted?: boolean; mutedCapabilities?: string[] },
): Promise<GroupMemberPrefs> {
  const cur = await getMemberPrefs(env, conv, uid);
  const next: GroupMemberPrefs = {
    conv, uid,
    muted: patch.muted ?? cur.muted,
    mutedCapabilities: patch.mutedCapabilities ?? cur.mutedCapabilities,
    updatedAt: Date.now(),
  };
  await env.DB_META.prepare(
    `INSERT INTO ava_group_member_prefs (conv, uid, muted, muted_capabilities, updated_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(conv, uid) DO UPDATE SET
       muted = excluded.muted,
       muted_capabilities = excluded.muted_capabilities,
       updated_at = excluded.updated_at`,
  ).bind(next.conv, next.uid, next.muted ? 1 : 0, JSON.stringify(next.mutedCapabilities), next.updatedAt).run();
  return next;
}

/** True if `uid` has muted Ava entirely, or muted this specific capability, in `conv`. Fails CLOSED (see getMemberPrefs). */
export async function isMemberMuted(env: Env, conv: string, uid: string, capability?: string): Promise<boolean> {
  const p = await getMemberPrefs(env, conv, uid);
  if (p.muted) return true;
  if (capability && p.mutedCapabilities.includes(capability)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Membership (I2/J5-lite: "re-verify the target uid is currently a member")
// ─────────────────────────────────────────────────────────────────────────────

/** Direct D1 membership check — mirrors messaging.ts's convRoleOf query shape (not imported: that helper is unexported there). */
export async function isCurrentGroupMember(env: Env, conv: string, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT 1 FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1`,
    ).bind(conv, uid).first();
    return !!r;
  } catch {
    return false; // fail CLOSED — never post toward a membership we couldn't verify
  }
}

export async function memberRole(env: Env, conv: string, uid: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT role FROM conversation_members WHERE conv_id=?1 AND uid=?2`,
    ).bind(conv, uid).first<{ role: string }>();
    return r?.role ?? null;
  } catch {
    return null;
  }
}

export async function isGroupAdmin(env: Env, conv: string, uid: string): Promise<boolean> {
  const role = await memberRole(env, conv, uid);
  return role === "owner" || role === "admin";
}

// ─────────────────────────────────────────────────────────────────────────────
// Group cooldown + daily budget for PUBLIC interventions (I4/I5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1, count-based (see migration header: real token-cost accounting is a
 * follow-up billing-wave item). Reads the EXISTING ava_interventions ledger
 * (worker/migrations/ava_interventions.sql) filtered to this conv's `payer =
 * 'group'`, `status = 'posted'` rows — no new counter table, no separate spend
 * path; the ledger IS the source of truth for both cooldown and the daily cap.
 * Fails OPEN on the two SELECTs (a D1 read hiccup lets a candidate proceed to
 * the ledger INSERT, which is the hard, race-safe backstop via decision_id
 * dedup — see ava_odl.ts groupDecisionIdFor/INSERT OR IGNORE).
 */
export async function checkGroupCooldownAndBudget(
  env: Env, conv: string, state: GroupAvaState,
): Promise<{ allowed: boolean; reason?: "group_cooldown" | "group_budget_exhausted" }> {
  const convHash = fnv1aHex(conv);

  try {
    const last = await env.DB_META.prepare(
      `SELECT updated_at FROM ava_interventions WHERE conv_hash=?1 AND payer='group' AND status='posted' ORDER BY updated_at DESC LIMIT 1`,
    ).bind(convHash).first<{ updated_at: number }>();
    if (last?.updated_at && Date.now() - last.updated_at < state.cooldownS * 1000) {
      return { allowed: false, reason: "group_cooldown" };
    }
  } catch { /* fail-open — decision_id dedup is the hard backstop */ }

  try {
    const dayStart = Date.now() - DAY_MS;
    const cnt = await env.DB_META.prepare(
      `SELECT COUNT(*) AS n FROM ava_interventions WHERE conv_hash=?1 AND payer='group' AND status='posted' AND updated_at >= ?2`,
    ).bind(convHash, dayStart).first<{ n: number }>();
    if ((cnt?.n ?? 0) >= state.budgetTokensDaily) return { allowed: false, reason: "group_budget_exhausted" };
  } catch { /* fail-open */ }

  return { allowed: true };
}
