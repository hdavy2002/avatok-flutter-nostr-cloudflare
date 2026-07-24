// companion_policy.ts — [AVABRAIN-COMPANION-2] Group Companion policy engine +
// draft/approval lifecycle (Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md §6.2,
// §6.3, §P2, §10.2).
//
// BUILDS ON [AVA-GROUP-COMPANION-1] (worker/src/lib/ava_group_policy.ts,
// worker/migrations/ava_group_companion.sql) and [AVA-ODL-POST-1]
// (worker/src/lib/ava_odl.ts, worker/migrations/ava_interventions.sql) — does
// NOT duplicate their state (ava_group_state, ava_interventions) or their
// mode/cooldown/budget columns. It ADDS:
//   • evaluate() — the deterministic gate chain the bible's proactive loop
//     (§6.3) requires: "relevance + cooldown + safety + token check", i.e.
//     platform kill switches → per-group mode → per-user mute → a NEW
//     per-group draft cooldown/daily-budget (distinct from
//     ava_group_state.cooldown_s/budget_tokens_daily, which gate the older
//     PUBLIC POST rate — this gates DRAFT CREATION itself, across both
//     public and private candidates, so Companion mode can't spam drafts even
//     when the eventual post would have been allowed).
//   • the draft ledger (worker/migrations/ava_companion_drafts.sql) — NO
//     autonomous posting. ava_odl.ts's group path (postGroupCandidate) calls
//     createDraft() here INSTEAD OF posting directly; a human must call
//     approveDraft() before ava_lane.ts's postAvaPrivate/postAvaGroup (the
//     SAME existing post path — this file never sends a message itself) ever
//     fires. rejectDraft() is terminal.
//
// SAFETY (bible §6.2: "No autonomous warnings about individuals; use neutral
// safety templates"): draft_text is ALWAYS the deterministic output of
// ava_templates.ts's fillTemplate() — this module never accepts or stores
// free-form generated text, only a fixed template_id + its filled string.
//
// GROUP SCOPING (bible §6.2: "must not become a user's private memory...
// Never use one group's transcript to answer another group"): every query in
// this file is scoped by `conv` (or `decision_id`, which is itself
// conv-derived) — there is no lookup here that can return rows from a
// different group or a user's private memory. This module reads/writes ONLY
// ava_companion_drafts + the existing ava_group_state/ava_interventions rows
// for the ONE conv passed in.

import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { track, trackUser, trackException } from "../hooks";
import {
  getGroupState, isMemberMuted, isCurrentGroupMember, isGroupAdmin,
  type GroupAvaState,
} from "./ava_group_policy";

const DEFAULT_DRAFT_COOLDOWN_S = 300;   // companionGroupCooldownSec — distinct from ava_group_state's PUBLIC-POST cooldown
const DEFAULT_DRAFT_DAILY_BUDGET = 10;  // companionGroupDailyBudget — drafts/day per group, across public+private
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // lazy sweep, mirrors ava_odl.ts's sweepExpiredInterventions
const SWEEP_SAMPLE = 50;

export type DraftScope = "public" | "private";
export type DraftStatus = "pending_approval" | "approved" | "posted" | "rejected" | "expired";

export interface CompanionTrigger {
  capability: string;
  scope: DraftScope;
  /** Required when scope === "private" — the specific recipient. */
  targetUid?: string;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
  state: GroupAvaState;
}

export interface CompanionDraft {
  decisionId: string;
  conv: string;
  capability: string;
  templateId: string;
  draftText: string;
  scope: DraftScope;
  targetUid: string | null;
  status: DraftStatus;
  createdBy: string | null;
  decidedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluate() — the deterministic gate chain (§6.3). Cheapest/least-I/O gates
// first. Fails CLOSED throughout (same posture as ava_group_policy.ts) — a D1
// or KV hiccup can only ever SUPPRESS a draft, never let one through.
// ─────────────────────────────────────────────────────────────────────────────
export async function evaluate(env: Env, conv: string, trigger: CompanionTrigger): Promise<PolicyVerdict> {
  let cfg: any = {};
  try { cfg = await readConfig(env); } catch { /* fail closed below via defaults-of-undefined */ }

  // Platform-wide kill switches — undefined reads as false (fail closed), NOT
  // read as whatever DEFAULTS says in this module (this file must never
  // assert an effective flag value — it only ever reads the live cfg it was
  // handed by readConfig, which itself layers KV over DEFAULTS).
  if (cfg.aiEnabled === false) return { allowed: false, reason: "ai_disabled", state: emptyState(conv) };
  if (cfg.odlEnabled !== true) return { allowed: false, reason: "odl_disabled", state: emptyState(conv) };
  if (cfg.avaMomentsEnabled !== true) return { allowed: false, reason: "moments_disabled", state: emptyState(conv) };
  if (cfg.avaGroupCompanionEnabled !== true) return { allowed: false, reason: "group_companion_disabled", state: emptyState(conv) };

  // Per-group mode (I1) — 'companion' is the only mode that may produce a
  // draft (mirrors ava_odl.ts's 4g gate; kept in sync deliberately rather than
  // imported, since ava_odl.ts's gate also needs to run before this file even
  // computes a capability/template, and this file has no reason to import
  // from ava_odl.ts — see that file's own no-shared-import convention).
  const state = await getGroupState(env, conv);
  if (state.mode !== "companion") return { allowed: false, reason: "group_mode_off", state };

  // Per-user mute (private scope only — a public candidate has no single
  // "target", so member-level mute is checked per-recipient at the point a
  // draft actually gets shown to them, same as the pre-existing behavior).
  if (trigger.scope === "private") {
    if (!trigger.targetUid) return { allowed: false, reason: "missing_target_uid", state };
    const stillMember = await isCurrentGroupMember(env, conv, trigger.targetUid);
    if (!stillMember) return { allowed: false, reason: "not_a_member", state };
    const muted = await isMemberMuted(env, conv, trigger.targetUid, trigger.capability);
    if (muted) return { allowed: false, reason: "member_muted", state };
  }

  // NEW: per-group draft cooldown + daily budget (distinct from
  // ava_group_state's public-POST cooldown/budget — this one gates DRAFT
  // CREATION itself, across public AND private candidates, so Companion mode
  // cannot flood a group with drafts even when each individual post would
  // have separately been allowed).
  const cooldownS = Number(cfg.companionGroupCooldownSec ?? DEFAULT_DRAFT_COOLDOWN_S);
  const dailyBudget = Number(cfg.companionGroupDailyBudget ?? DEFAULT_DRAFT_DAILY_BUDGET);

  try {
    const last = await env.DB_META.prepare(
      `SELECT created_at FROM ava_companion_drafts WHERE conv=?1 ORDER BY created_at DESC LIMIT 1`,
    ).bind(conv).first<{ created_at: number }>();
    if (last?.created_at && Date.now() - last.created_at < cooldownS * 1000) {
      return { allowed: false, reason: "draft_cooldown", state };
    }
  } catch { /* fail-open on the SELECT — the decision_id PK dedup in ava_odl.ts is the hard backstop against duplicates */ }

  try {
    const dayStart = Date.now() - DRAFT_TTL_MS;
    const cnt = await env.DB_META.prepare(
      `SELECT COUNT(*) AS n FROM ava_companion_drafts WHERE conv=?1 AND created_at >= ?2`,
    ).bind(conv, dayStart).first<{ n: number }>();
    if ((cnt?.n ?? 0) >= dailyBudget) return { allowed: false, reason: "draft_budget_exhausted", state };
  } catch { /* fail-open */ }

  return { allowed: true, state };
}

function emptyState(conv: string): GroupAvaState {
  return { conv, mode: "off", budgetTokensDaily: 0, cooldownS: 0, policyVersion: 1, updatedBy: null, updatedAt: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy TTL sweep for stale pending drafts (mirrors ava_odl.ts's
// sweepExpiredInterventions — sampled, best-effort, DELETE not relabel isn't
// needed here since decision_id here is shared with ava_interventions, whose
// own PK-freeing sweep already handles reservation reuse; this sweep only
// relabels forgotten drafts to 'expired' so a draft-card UI stops showing a
// stale pending item — it does not touch ava_interventions).
// ─────────────────────────────────────────────────────────────────────────────
export async function sweepExpiredDrafts(env: Env): Promise<void> {
  if (Math.floor(Math.random() * SWEEP_SAMPLE) !== 0) return;
  try {
    const cutoff = Date.now() - DRAFT_TTL_MS;
    await env.DB_META.prepare(
      `UPDATE ava_companion_drafts SET status='expired', updated_at=?1
       WHERE status='pending_approval' AND created_at < ?2`,
    ).bind(Date.now(), cutoff).run();
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// createDraft — called from ava_odl.ts's postGroupCandidate INSTEAD OF
// posting directly. The ava_interventions row is ALREADY reserved by the
// caller (decisionId is that same PK) — this only adds the draft-card content
// row. Emits avabrain_companion_draft_created (bible §10.2).
// ─────────────────────────────────────────────────────────────────────────────
export async function createDraft(env: Env, args: {
  decisionId: string; conv: string; capability: string; templateId: string;
  draftText: string; scope: DraftScope; targetUid?: string | null;
}): Promise<{ created: boolean }> {
  void sweepExpiredDrafts(env);
  const now = Date.now();
  try {
    const ins = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO ava_companion_drafts
         (decision_id, conv, capability, template_id, draft_text, scope, target_uid, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending_approval', 'ava', ?8, ?8)`,
    ).bind(
      args.decisionId, args.conv, args.capability, args.templateId, args.draftText,
      args.scope, args.targetUid ?? null, now,
    ).run();
    const created = ((ins as any)?.meta?.changes ?? 0) > 0;
    if (created) {
      void track(env, "server", "avabrain_companion_draft_created", "avabrain_companion", {
        decision_id: args.decisionId, conv, capability: args.capability,
        template_id: args.templateId, scope: args.scope, has_target: !!args.targetUid,
      });
    }
    return { created };
  } catch (err) {
    void trackException(env, err, { route: "companion_policy.createDraft", app_name: "avabrain_companion", handled: true, extra: { conv: args.conv, capability: args.capability } });
    return { created: false };
  }
}

export async function getDraft(env: Env, decisionId: string): Promise<CompanionDraft | null> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT decision_id, conv, capability, template_id, draft_text, scope, target_uid, status, created_by, decided_by, created_at, updated_at
         FROM ava_companion_drafts WHERE decision_id=?1`,
    ).bind(decisionId).first<{
      decision_id: string; conv: string; capability: string; template_id: string; draft_text: string;
      scope: string; target_uid: string | null; status: string; created_by: string | null;
      decided_by: string | null; created_at: number; updated_at: number;
    }>();
    if (!r) return null;
    return {
      decisionId: r.decision_id, conv: r.conv, capability: r.capability, templateId: r.template_id,
      draftText: r.draft_text, scope: (r.scope === "public" ? "public" : "private"),
      targetUid: r.target_uid, status: r.status as DraftStatus, createdBy: r.created_by,
      decidedBy: r.decided_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  } catch {
    return null;
  }
}

/**
 * Who may decide (approve/reject) a draft (bible §6.2: "group owner/admin
 * approval" for group-visible things; a private suggestion's own recipient
 * may also decide for themselves — nobody else can approve a suggestion only
 * they would ever see).
 */
export async function canDecideDraft(env: Env, draft: CompanionDraft, uid: string): Promise<boolean> {
  if (draft.scope === "private" && draft.targetUid && draft.targetUid === uid) return true;
  return await isGroupAdmin(env, draft.conv, uid);
}

export async function listPendingDrafts(env: Env, conv: string, limit = 20): Promise<CompanionDraft[]> {
  try {
    const rs = await env.DB_META.prepare(
      `SELECT decision_id, conv, capability, template_id, draft_text, scope, target_uid, status, created_by, decided_by, created_at, updated_at
         FROM ava_companion_drafts WHERE conv=?1 AND status='pending_approval' ORDER BY created_at ASC LIMIT ?2`,
    ).bind(conv, Math.max(1, Math.min(100, limit))).all<{
      decision_id: string; conv: string; capability: string; template_id: string; draft_text: string;
      scope: string; target_uid: string | null; status: string; created_by: string | null;
      decided_by: string | null; created_at: number; updated_at: number;
    }>();
    return (rs.results ?? []).map((r) => ({
      decisionId: r.decision_id, conv: r.conv, capability: r.capability, templateId: r.template_id,
      draftText: r.draft_text, scope: (r.scope === "public" ? "public" : "private"),
      targetUid: r.target_uid, status: r.status as DraftStatus, createdBy: r.created_by,
      decidedBy: r.decided_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    }));
  } catch {
    return [];
  }
}

export async function countDraftsToday(env: Env, conv: string): Promise<number> {
  try {
    const dayStart = Date.now() - DRAFT_TTL_MS;
    const cnt = await env.DB_META.prepare(
      `SELECT COUNT(*) AS n FROM ava_companion_drafts WHERE conv=?1 AND created_at >= ?2`,
    ).bind(conv, dayStart).first<{ n: number }>();
    return cnt?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * approveDraft — flips the draft to 'approved' then fires the EXISTING post
 * path (ava_lane.ts postAvaPrivate/postAvaGroup — imported by the ROUTE, not
 * here, to avoid a require cycle with ava_lane.ts → ava_thread.ts → this file
 * never needing to import routes/*; the route composes the two calls). This
 * function only owns the ledger-state transition + telemetry; the caller
 * supplies whether the post itself succeeded.
 */
export async function markDraftDecision(
  env: Env, decisionId: string, decidedBy: string, decision: "approved" | "rejected",
): Promise<{ ok: boolean }> {
  try {
    const res = await env.DB_META.prepare(
      `UPDATE ava_companion_drafts SET status=?1, decided_by=?2, updated_at=?3
       WHERE decision_id=?4 AND status='pending_approval'`,
    ).bind(decision, decidedBy, Date.now(), decisionId).run();
    return { ok: ((res as any)?.meta?.changes ?? 0) > 0 };
  } catch (err) {
    void trackException(env, err, { uid: decidedBy, route: "companion_policy.markDraftDecision", app_name: "avabrain_companion", handled: true, extra: { decision_id: decisionId, decision } });
    return { ok: false };
  }
}

export async function markDraftPosted(env: Env, decisionId: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      `UPDATE ava_companion_drafts SET status='posted', updated_at=?1 WHERE decision_id=?2 AND status='approved'`,
    ).bind(Date.now(), decisionId).run();
    await env.DB_META.prepare(
      `UPDATE ava_interventions SET status='posted', updated_at=?1 WHERE decision_id=?2 AND status='reserved'`,
    ).bind(Date.now(), decisionId).run();
  } catch { /* best-effort — a stuck row still self-heals via ava_odl.ts's 24h TTL sweep */ }
}

export async function markInterventionRejected(env: Env, decisionId: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      `UPDATE ava_interventions SET status='rejected', updated_at=?1 WHERE decision_id=?2 AND status='reserved'`,
    ).bind(Date.now(), decisionId).run();
  } catch { /* best-effort */ }
}

export async function trackPolicyBlocked(env: Env, conv: string, capability: string, reason: string): Promise<void> {
  void track(env, "server", "avabrain_group_policy_blocked", "avabrain_companion", { conv, capability, reason });
}

export async function trackConsentChanged(env: Env, uid: string, email: string | null | undefined, conv: string, prevMode: string, mode: string): Promise<void> {
  if (email) void trackUser(env, uid, email, "avabrain_consent_changed", "avabrain_companion", { conv, prev_mode: prevMode, mode });
  else void track(env, uid, "avabrain_consent_changed", "avabrain_companion", { conv, prev_mode: prevMode, mode });
}
