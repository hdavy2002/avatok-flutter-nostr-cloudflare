// ava_group.ts — [AVABRAIN-COMPANION-2] Group Companion mode + effective
// policy + draft approval endpoints (Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md
// §6.2, §6.3, §P2).
//
//   GET  /api/ava/group/mode?conv=ID          → current mode (any member)
//   POST /api/ava/group/mode                  → set mode (owner/admin only)
//                                                {conv, mode: 'off'|'assistant'|'companion'}
//   GET  /api/ava/group/policy/<conv>          → effective policy for clients:
//                                                {mode, drafts_today, budget,
//                                                 cooldown_remaining_s}
//   POST /api/ava/group/draft/<id>/approve     → approve a pending draft; fires
//                                                the EXISTING post path
//                                                (ava_lane.ts postAvaPrivate/
//                                                postAvaGroup) — no second sender.
//   POST /api/ava/group/draft/<id>/reject      → reject a pending draft (terminal)
//
// These are NEW, additive endpoints — they intentionally do NOT replace
// messaging.ts's /api/conversations/ava/state (which the pre-existing client
// toggle UI already calls); mode/state itself is the SAME
// ava_group_state row (worker/src/lib/ava_group_policy.ts), so writing mode
// through either endpoint has identical effect. This file adds the
// bible-mandated draft/approval + effective-policy surface that did not exist
// before [AVABRAIN-COMPANION-2].
//
// Role checks mirror messaging.ts's convRoleOf query shape rather than
// importing it (unexported there — same convention ava_group_policy.ts's
// isGroupAdmin/memberRole already documents).

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { emailFor } from "../lib/identity";
import { track, trackException } from "../hooks";
import { readConfig } from "./config";
import { postAvaMessage } from "./ava_thread";
import { postAvaPrivate, postAvaGroup } from "../lib/ava_lane";
import {
  getGroupState, setGroupState, type GroupAvaMode,
} from "../lib/ava_group_policy";
import {
  getDraft, canDecideDraft, markDraftDecision,
  markDraftPosted, markInterventionRejected, countDraftsToday, trackConsentChanged,
  listPendingDrafts,
} from "../lib/companion_policy";

async function convRoleOf(env: Env, conv: string, uid: string): Promise<string | null> {
  try {
    const r = await env.DB_META
      .prepare("SELECT role FROM conversation_members WHERE conv_id=?1 AND uid=?2")
      .bind(conv, uid).first<{ role: string }>();
    return r?.role ?? null;
  } catch {
    return null;
  }
}

async function convIsGroup(env: Env, conv: string): Promise<boolean> {
  try {
    const r = await env.DB_META
      .prepare("SELECT kind FROM conversations WHERE id=?1").bind(conv).first<{ kind: string }>();
    return r?.kind === "group";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ava/group/mode?conv=ID — any current member may read the mode.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupModeGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const conv = new URL(req.url).searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await convRoleOf(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);
  const state = await getGroupState(env, conv);
  return json({ conv, mode: state.mode, updated_by: state.updatedBy, updated_at: state.updatedAt });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ava/group/mode  { conv, mode } — owner/admin only. Same disclosure
// idiom as messaging.ts's convAvaGroupStatePut (I1: every member must SEE a
// system notice when Companion mode changes) — posted via the EXISTING
// AvaAgentDO fan-out (postAvaMessage private:false), never a bespoke sender.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupModePost(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b?.conv || "");
  const mode = String(b?.mode || "");
  if (!conv || (mode !== "off" && mode !== "assistant" && mode !== "companion")) {
    return json({ error: "conv and mode(off|assistant|companion) required" }, 400);
  }
  if (!(await convIsGroup(env, conv))) return json({ error: "not a group" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner" && myRole !== "admin") return json({ error: "forbidden" }, 403);

  const before = await getGroupState(env, conv);
  const next = await setGroupState(env, conv, { mode: mode as GroupAvaMode }, ctx.uid);

  if (before.mode !== next.mode) {
    const email = await emailFor(env, ctx.uid).catch(() => null);
    void trackConsentChanged(env, ctx.uid, email, conv, before.mode, next.mode);
    const notice = next.mode === "companion"
      ? "Ava Companion mode is now ON for this group. Ava may privately suggest things to individual members and — within this group's own daily limit and cooldown — occasionally propose a group post, always shown as a draft for a group admin (or, for private suggestions, the member themself) to approve before anything is ever sent. Any member can mute Ava for themselves in group settings."
      : next.mode === "assistant"
        ? "Ava Companion mode is now OFF for this group. Ava will only respond when directly mentioned (@ava)."
        : "Ava is now fully OFF for this group — no observation, suggestions, drafts, or memory.";
    try {
      await postAvaMessage(env, { ownerUid: ctx.uid, conv, text: notice, private: false, source: "group_companion_disclosure" });
    } catch { /* best-effort — the state change itself already succeeded */ }
  }

  return json({ conv, mode: next.mode, updated_by: next.updatedBy, updated_at: next.updatedAt });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ava/group/policy/<conv> — effective policy for clients (draft-card
// UI needs this to decide whether to show a "Companion is on" affordance and
// how close the group is to its daily draft budget/cooldown).
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupPolicyGet(req: Request, env: Env, conv: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await convRoleOf(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);

  const state = await getGroupState(env, conv);
  const draftsToday = await countDraftsToday(env, conv);

  // cooldown_remaining_s: how long until companion_policy.ts's evaluate()
  // would stop returning "draft_cooldown" for a NEW draft in this conv —
  // informational only (clients poll this to render "Ava can suggest again in
  // Ns"); ava_odl.ts always re-checks the real gate server-side at generation
  // time, so a stale read here can never let a draft skip the cooldown.
  const cfg: any = await readConfig(env).catch(() => ({}));
  const cooldownS = Number(cfg.companionGroupCooldownSec ?? 300);
  const dailyBudget = Number(cfg.companionGroupDailyBudget ?? 10);

  let cooldownRemainingS = 0;
  try {
    const last = await env.DB_META.prepare(
      `SELECT created_at FROM ava_companion_drafts WHERE conv=?1 ORDER BY created_at DESC LIMIT 1`,
    ).bind(conv).first<{ created_at: number }>();
    if (last?.created_at) {
      const elapsedS = (Date.now() - last.created_at) / 1000;
      cooldownRemainingS = Math.max(0, Math.ceil(cooldownS - elapsedS));
    }
  } catch { /* best-effort */ }

  return json({
    conv,
    mode: state.mode,
    drafts_today: draftsToday,
    budget: { drafts_daily: dailyBudget, public_daily: state.budgetTokensDaily, public_cooldown_s: state.cooldownS },
    cooldown_remaining_s: cooldownRemainingS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ava/group/draft/<id>/approve — the ONLY path (besides the reject
// endpoint) that resolves a pending_approval draft. Fires the EXISTING post
// path (ava_lane.ts) — never a new sender.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupDraftApprove(req: Request, env: Env, decisionId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!decisionId) return json({ error: "decision id required" }, 400);

  const draft = await getDraft(env, decisionId);
  if (!draft) return json({ error: "draft not found" }, 404);
  if (draft.status !== "pending_approval") return json({ error: `draft already ${draft.status}` }, 409);
  if (!(await canDecideDraft(env, draft, ctx.uid))) return json({ error: "forbidden" }, 403);

  const marked = await markDraftDecision(env, decisionId, ctx.uid, "approved");
  if (!marked.ok) return json({ error: "could not approve (already decided?)" }, 409);

  try {
    const postRes = draft.scope === "private" && draft.targetUid
      ? await postAvaPrivate(env, {
          uid: draft.targetUid, conv: draft.conv, text: draft.draftText,
          moment: { kind: "ava_moment", capability: draft.capability, decision_id: decisionId, provenance: "current_message" },
          capability: draft.capability, source: "companion_draft_approved",
        })
      : await postAvaGroup(env, {
          conv: draft.conv, text: draft.draftText, decisionId, capability: draft.capability,
          moment: { kind: "ava_moment", capability: draft.capability, decision_id: decisionId, provenance: "current_message" },
        });

    if (postRes.ok) {
      await markDraftPosted(env, decisionId);
      const email = await emailFor(env, ctx.uid).catch(() => null);
      void track(env, ctx.uid, "avabrain_companion_draft_approved", "avabrain_companion", {
        decision_id: decisionId, conv: draft.conv, capability: draft.capability, scope: draft.scope, email: email ?? undefined,
      });
      return json({ ok: true, decision_id: decisionId, status: "posted" });
    }
    void trackException(env, new Error(postRes.error || "post_failed"), {
      uid: ctx.uid, route: "ava_group.avaGroupDraftApprove", app_name: "avabrain_companion", handled: true,
      extra: { decision_id: decisionId, conv: draft.conv },
    });
    return json({ ok: false, decision_id: decisionId, status: "approved", error: "post_failed_will_not_retry_automatically" }, 502);
  } catch (err) {
    void trackException(env, err, { uid: ctx.uid, route: "ava_group.avaGroupDraftApprove", app_name: "avabrain_companion", handled: true, extra: { decision_id: decisionId } });
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ava/group/draft/<id>/reject — terminal. Never posts.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupDraftReject(req: Request, env: Env, decisionId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!decisionId) return json({ error: "decision id required" }, 400);

  const draft = await getDraft(env, decisionId);
  if (!draft) return json({ error: "draft not found" }, 404);
  if (draft.status !== "pending_approval") return json({ error: `draft already ${draft.status}` }, 409);
  if (!(await canDecideDraft(env, draft, ctx.uid))) return json({ error: "forbidden" }, 403);

  const marked = await markDraftDecision(env, decisionId, ctx.uid, "rejected");
  if (!marked.ok) return json({ error: "could not reject (already decided?)" }, 409);
  await markInterventionRejected(env, decisionId);

  const email = await emailFor(env, ctx.uid).catch(() => null);
  void track(env, ctx.uid, "avabrain_companion_draft_rejected", "avabrain_companion", {
    decision_id: decisionId, conv: draft.conv, capability: draft.capability, scope: draft.scope, email: email ?? undefined,
  });

  return json({ ok: true, decision_id: decisionId, status: "rejected" });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ava/group/drafts/<conv> — member-only pending-draft list for the
// draft-card UI. Private-scope drafts are filtered server-side to their own
// target_uid only (a member must never see another member's private
// suggestion); public drafts are visible to any member, with a per-row
// can_decide computed via the SAME authz as approve/reject (canDecideDraft).
// ─────────────────────────────────────────────────────────────────────────────
export async function avaGroupDraftsGet(req: Request, env: Env, conv: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await convRoleOf(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);

  const pending = await listPendingDrafts(env, conv);
  const visible = pending.filter((d) => d.scope === "public" || d.targetUid === ctx.uid);

  const drafts = await Promise.all(visible.map(async (d) => ({
    decision_id: d.decisionId,
    capability: d.capability,
    template_id: d.templateId,
    draft_text: d.draftText,
    scope: d.scope,
    target_uid: d.targetUid,
    created_at: d.createdAt,
    can_decide: await canDecideDraft(env, d, ctx.uid),
  })));

  return json({ drafts });
}
