// ava_odl.ts — Phase C. The Opportunity Detection Layer orchestrator (plan §8,
// D17 dormant-by-default, D27 shadow lifecycle).
//
// odlProcess(env, {uid, conv, text, senderUid, isGroup}) runs once per
// (recipient, message) from the Guardian per-message scan site. It is the
// deterministic funnel head:
//
//   per-chat toggle → matchTriggers (regex) → Opportunity Score → Capability
//   Registry → budget gate → Governor gate → SHADOW: telemetry only, or
//   [AVA-ODL-POST-1] PRODUCTION: decision ledger → private-lane post.
//
// HARD RULES:
//   • ZERO AI calls anywhere in this path. Regex + templates + KV only. The
//     reasoner is reachable ONLY through avaReason() in later phases, behind
//     Governor + Registry (Specs/AVA-ENGINEERING-LAW.md).
//   • FAIL-SILENT: the whole function is try/catch; it can never affect
//     message delivery, Guardian, or anything user-visible.
//   • SHADOW lifecycle (D27) → NO user-visible output, ever. The PostHog
//     `ava_moment_shadow` events ARE the deliverable: would_fire + outcome
//     projections decide shadow → beta promotion (D25).
//   • PRODUCTION lifecycle ([AVA-ODL-POST-1]) → posts ONLY into the target
//     user's own private Ava lane (ava_lane.ts postAvaPrivate — structural
//     privacy, never fans out), and ONLY when odlEnabled AND
//     avaMomentsEnabled are both true in KV (both default false in prod —
//     see worker/src/routes/config.ts DEFAULTS). Every post is durably
//     reserved in `ava_interventions` (worker/migrations/ava_interventions.sql,
//     DB_META) BEFORE it happens, so a crash mid-post can never silently
//     spend budget without a trace, and a retry of the same message can never
//     double-post (F7, Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md).
//
// TELEMETRY (app_name "ava_odl"):
//   ava_odl_wake          every trigger match (the ~10–20% wake rate)
//   ava_odl_sleep         no-match messages, SAMPLED 1:100 (stay cheap)
//   ava_moment_shadow     the shadow projection event (per woke capability)
//   ava_moment_candidate  production capability reached the template step
//   ava_moment_posted     [AVA-ODL-POST-1] private-lane post acknowledged
//   ava_moment_post_failed [AVA-ODL-POST-1] reserved but InboxDO append failed

import type { Env } from "../types";
import { track } from "../hooks";
import { readConfig } from "../routes/config";
import { matchTriggers, matchedCategories, TRIGGER_BANK_VERSION } from "./ava_triggers";
import { opportunityScore } from "./ava_opportunity";
import { getCapability, CATEGORY_TO_CAPABILITY } from "./ava_capabilities";
import { checkAndSpend, spendMoment, getTrust, isMuted } from "./ava_budget";
import { governorGate } from "./ava_governor";
import { guessLang, hasTemplate, pickTemplate, fillTemplate } from "./ava_templates";
import { postAvaPrivate } from "./ava_lane";

const SLEEP_SAMPLE = 100; // 1:100 sampling for ava_odl_sleep

// ─────────────────────────────────────────────────────────────────────────────
// [AVA-ODL-POST-1] The decision ledger (F7, worker/migrations/ava_interventions.sql,
// DB_META). ONE additive table, ONE deterministic key: reserved → posted
// (InboxDO ack'd). decision_id is the PRIMARY KEY and reservation is
// INSERT OR IGNORE, so a 'reserved' row that never resolves (crash mid-post,
// InboxDO down) must eventually be DELETED, not merely relabelled — an
// 'expired' row would still occupy the PK forever and permanently block a
// retry of the identical (uid, conv, capability, text) decision. The 24h TTL
// sweep therefore DELETEs stale 'reserved' rows outright (see
// sweepExpiredInterventions below); it never touches 'posted' rows. The
// 'expired' status name lives on only as a legacy enum value that may still
// appear in old telemetry/rows written before this fix — new code never sets it.
// ─────────────────────────────────────────────────────────────────────────────

// FNV-1a (32-bit) → hex. Same pattern as worker/src/lib/brain_ingest.ts and
// worker/src/do/inbox.ts's local fnv1aHex: synchronous (no crypto.subtle
// await on the hot ODL path), deterministic, collision-resistant ENOUGH for
// an idempotency key — not cryptographic, and doesn't need to be.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * decision_id — deterministic, NOT random (F7: "retry by decision_id, never a
 * fresh random id"). odlProcess has no message/event id at its call site
 * (ava_guardian.ts passes only {uid, conv, text, senderUid, isGroup}), so the
 * triggering TEXT stands in for "trigger event id": the same (uid, conv,
 * capability, text) always yields the same decision, so a retried odlProcess
 * call for the SAME message hits the same row (INSERT OR IGNORE no-ops, no
 * double spend, no double post). See the migration header for the accepted
 * trade-off this implies.
 */
function decisionIdFor(uid: string, conv: string, capId: string, text: string): string {
  return `${fnv1aHex(`${uid}|${conv}|${capId}`)}_${fnv1aHex(text)}`;
}

const INTERVENTION_TTL_MS = 24 * 60 * 60 * 1000; // F7: 24h reserved→expired
const SWEEP_SAMPLE = 50; // lazy TTL sweep — only 1:50 wakes pay the extra D1 write, and only when the ledger is actually in use

/**
 * Lazy TTL sweep (F7: "do the sweep lazily at the top of odlProcess — cheap
 * DELETE with a LIMIT"). Sampled + best-effort: a late sweep just means a
 * crash-stuck 'reserved' row sits a little longer before being reclaimed.
 * DELETEs — does NOT relabel to 'expired' — because decision_id is the
 * PRIMARY KEY and reservation is INSERT OR IGNORE (decisionIdFor): if a
 * stale row were merely marked 'expired' it would still occupy the PK, so a
 * crash-stuck reservation (or a repeated identical trigger for the same
 * uid/conv/capability/text) could NEVER re-reserve and could never post
 * again. DELETE frees the PK so the same decision can be retried cleanly.
 * 'posted' rows are never touched (status = 'reserved' in the WHERE below).
 * Only runs once the ledger can actually contain rows (both flags on), so it
 * is a complete no-op — not even a D1 call — everywhere the feature is dark.
 */
async function sweepExpiredInterventions(env: Env): Promise<void> {
  if (Math.floor(Math.random() * SWEEP_SAMPLE) !== 0) return; // cheap check FIRST — no I/O on 49/50 calls
  try {
    const cfg: any = await readConfig(env);
    if (cfg.odlEnabled !== true || cfg.avaMomentsEnabled !== true) return; // ledger can't be growing while dark
    const cutoff = Date.now() - INTERVENTION_TTL_MS;
    await env.DB_META.prepare(
      `DELETE FROM ava_interventions
       WHERE decision_id IN (
         SELECT decision_id FROM ava_interventions
         WHERE status = 'reserved' AND created_at < ?1
         LIMIT 50
       )`,
    ).bind(cutoff).run();
  } catch { /* best-effort — never affects the funnel */ }
}

export interface OdlInput {
  uid: string;        // the RECIPIENT whose Ava is evaluating (per-account)
  conv: string;
  text: string;
  senderUid: string;
  isGroup?: boolean;
}

export interface OdlResult {
  woke: boolean;
  capability?: string;
  opportunity?: number;
  would_fire?: boolean;
  reason?: string;
  // Populated ONLY for lifecycle "production" capabilities (meeting,
  // reminder — [AVA-ODL-POST-1]); shadow capabilities never set it.
  templateText?: string;
}

/**
 * odlProcess — the whole ODL, fail-silent, zero AI. Safe to call detached
 * (`void odlProcess(...)`) from any per-message site.
 */
export async function odlProcess(env: Env, input: OdlInput): Promise<OdlResult> {
  try {
    // 0. Lazy TTL sweep for the decision ledger (F7) — sampled, best-effort,
    //    a complete no-op (not even a KV read) on 49/50 calls and a no-op D1
    //    call whenever the feature is dark. See sweepExpiredInterventions().
    void sweepExpiredInterventions(env);

    const uid = String(input.uid ?? "");
    const conv = String(input.conv ?? "");
    const text = String(input.text ?? "");
    const senderUid = String(input.senderUid ?? "");
    if (!uid || !conv || !text.trim()) return { woke: false, reason: "no_input" };
    if (uid === senderUid) return { woke: false, reason: "own_message" }; // Ava evaluates for recipients

    // 1. Per-chat "Ava in this chat" toggle (D29). KV `avatoggle:<uid>:<conv>`,
    //    "0" = OFF → no wake, no telemetry, nothing. (The header-switch agent's
    //    InboxDO conv-state is the UI source of truth; this KV mirror is the
    //    cheap server-side read until that state is directly reachable here.)
    try {
      const t = await env.TOKENS.get(`avatoggle:${uid}:${conv}`);
      if (t === "0") return { woke: false, reason: "toggle_off" };
    } catch { /* fail-open toward evaluate (shadow = no user impact) */ }

    // 2. THE trigger bank (regex only, D23/D31). No match → Ava keeps sleeping.
    const matches = matchTriggers(text);
    if (!matches.length) {
      if (Math.floor(Math.random() * SLEEP_SAMPLE) === 0) {
        void track(env, uid, "ava_odl_sleep", "ava_odl", {
          conv, is_group: !!input.isGroup, msg_len: text.length,
          sampled: SLEEP_SAMPLE, bank_version: TRIGGER_BANK_VERSION,
        });
      }
      return { woke: false, reason: "no_trigger" };
    }

    // 3. Deterministic scoring + capability resolution (first category wins —
    //    the bank is ordered by priority; Constitution 3: at most ONE suggestion).
    const cats = matchedCategories(matches);
    const category = cats[0];
    const opportunity = opportunityScore(text, matches, { isGroup: input.isGroup });
    const lang = guessLang(text);
    const capId = CATEGORY_TO_CAPABILITY[category];
    const cap = await getCapability(env, capId);
    if (!cap || cap.lifecycle === "deprecated" || cap.lifecycle === "deleted") {
      return { woke: false, reason: "no_capability" };
    }

    void track(env, uid, "ava_odl_wake", "ava_odl", {
      conv, is_group: !!input.isGroup, capability: cap.id, lifecycle: cap.lifecycle,
      trigger_category: category, trigger_patterns: matches.slice(0, 6).map((m) => m.pattern),
      categories: cats, opportunity, lang_guess: lang,
      bank_version: TRIGGER_BANK_VERSION, msg_len: text.length,
    });

    // 4. Gates, cheapest first. Each records WHY it would block — in shadow the
    //    verdict feeds telemetry; nothing user-visible happens either way.
    let gateReason: string | null = null;

    // 4a. Capability kill switch (flag blob; explicitly false = OFF). `cfg` is
    //     hoisted so step 6 (production post path) reuses this same read
    //     instead of hitting KV a second time for avaMomentsEnabled.
    let cfg: any = {};
    try {
      cfg = await readConfig(env);
      if (cfg[cap.kill_switch] === false) gateReason = "kill_switch";
    } catch { /* fail-open */ }

    // 4b. Trust ledger — a 30-day conv mute means dismissed = dropped (Const. 10).
    if (!gateReason) {
      const trust = await getTrust(env, uid, conv);
      if (isMuted(trust)) gateReason = "trust_muted";
    }

    // 4c. Budget Manager — per-user daily evals + per-capability daily limit.
    let userEvalsToday = 0;
    if (!gateReason) {
      const spend = await checkAndSpend(env, { uid, capabilityId: cap.id, capDailyLimit: cap.daily_limit });
      userEvalsToday = spend.userEvalsToday;
      if (!spend.allowed) gateReason = spend.reason;
    }

    // 4d. Global AI Governor (Guardian is never gated here — Constitution 12).
    if (!gateReason) {
      const gov = await governorGate(env, cap, opportunity);
      if (!gov.allowed) gateReason = gov.reason;
    }

    // 4e. Opportunity floor (Constitution 1: threshold AND min-opportunity).
    if (!gateReason && opportunity < cap.min_opportunity) gateReason = "below_min_opportunity";

    let wouldFire = !gateReason;

    // 4f. Account-wide unsolicited-Moments budget (Constitution 2: 500/day).
    //     Spent only when everything else says fire — a would-be Moment.
    if (wouldFire) {
      const m = await spendMoment(env, { uid, capabilityId: cap.id });
      if (!m.allowed) { wouldFire = false; gateReason = "moments_budget"; }
    }

    const templateAvailable = hasTemplate(cap.id, lang);

    // 5. SHADOW (v1: all 8 capabilities): telemetry only, NO user output.
    //    These events project acceptance before any user ever sees a Moment (D27).
    if (cap.lifecycle !== "production") {
      void track(env, uid, "ava_moment_shadow", "ava_odl", {
        conv, is_group: !!input.isGroup,
        capability: cap.id, lifecycle: cap.lifecycle, cost_class: cap.cost_class,
        opportunity, min_opportunity: cap.min_opportunity,
        trigger_category: category, would_fire: wouldFire, gate_reason: gateReason,
        template_available: templateAvailable, lang_guess: lang,
        user_evals_today: userEvalsToday, bank_version: TRIGGER_BANK_VERSION,
      });
      return { woke: true, capability: cap.id, opportunity, would_fire: wouldFire, reason: gateReason ?? undefined };
    }

    // 6. PRODUCTION lifecycle ([AVA-ODL-POST-1]: `meeting`/`reminder` in v1 —
    //    ava_capabilities.ts). Templates first (Constitution 7). Reachable at
    //    all ONLY when odlEnabled is true (guaranteed — ava_guardian.ts never
    //    calls odlProcess otherwise) AND avaMomentsEnabled is true (checked
    //    below, default false in prod) AND the capability's own kill_switch
    //    isn't explicitly false (4a). Every one of those stays dark by
    //    default, so this whole block is unreached in production today.
    if (!wouldFire) return { woke: true, capability: cap.id, opportunity, would_fire: false, reason: gateReason ?? undefined };
    const tpl = pickTemplate(cap.id, lang);
    const templateText = tpl ? fillTemplate(tpl.text, {}) : undefined;
    void track(env, uid, "ava_moment_candidate", "ava_odl", {
      conv, is_group: !!input.isGroup, capability: cap.id, opportunity,
      trigger_category: category, lang_guess: lang, template_used: !!tpl,
    });

    // 6a. avaMomentsEnabled — the master "may Ava post anything user-visible"
    //     switch (default false in prod). False → behave exactly like
    //     shadow-with-a-template (unchanged from before this issue): return
    //     templateText for callers that want it, post NOTHING, write NO
    //     ledger row (nothing was reserved toward a post that cannot happen).
    if (cfg.avaMomentsEnabled !== true) {
      return { woke: true, capability: cap.id, opportunity, would_fire: true, templateText };
    }
    if (!tpl || !templateText) {
      return { woke: true, capability: cap.id, opportunity, would_fire: true, reason: "no_template", templateText };
    }

    // 6b. Decision ledger (F7, worker/migrations/ava_interventions.sql). The
    //     Moments-budget unit for THIS wake was already spent at 4f — that
    //     spend location is UNCHANGED by this issue (see the migration
    //     header for why: shadow-mode budget accounting must stay
    //     byte-for-byte identical so D25 acceptance-rate projections stay
    //     comparable pre/post promotion). What's new is durability: this
    //     INSERT records that already-spent unit against a specific,
    //     deterministic decision — reserved BEFORE the private-lane post, so
    //     a crash right after this line always leaves an inspectable
    //     'reserved' row instead of a silently lost charge. decision_id is
    //     deterministic (decisionIdFor), so a retried odlProcess call for the
    //     SAME message hits the SAME row via INSERT OR IGNORE and stops
    //     below — no second spend, no second post.
    const decisionId = decisionIdFor(uid, conv, cap.id, text);
    const convHash = fnv1aHex(conv);
    let reservedHere = false;
    try {
      const ins = await env.DB_META.prepare(
        `INSERT OR IGNORE INTO ava_interventions
           (decision_id, uid, conv_hash, capability, policy_version, budget_reserved, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 'reserved', ?6, ?6)`,
      ).bind(decisionId, uid, convHash, cap.id, TRIGGER_BANK_VERSION, Date.now()).run();
      reservedHere = ((ins as any)?.meta?.changes ?? 0) > 0;
    } catch {
      // D1 unavailable — fail CLOSED on posting (no durable record = no
      // post). The Moments-budget unit spent at 4f is not refunded here
      // (soft budget by design — see ava_budget.ts header); it is the same
      // trade-off shadow mode has always made.
      return { woke: true, capability: cap.id, opportunity, would_fire: true, templateText };
    }
    if (!reservedHere) {
      // A row for this EXACT decision already exists — posted, or still
      // 'reserved' and in-flight / crash-stuck (the latter self-heals via
      // the 24h sweep DELETE above, which frees the PK for a future retry
      // rather than leaving it permanently blocked). F7: "a retry must not
      // double-post." Stop.
      return { woke: true, capability: cap.id, opportunity, would_fire: true, reason: "already_decided", templateText };
    }

    // 6c. Render + post via the SAME private-lane helper Guardian warnings
    //     and doc-actions already use (ava_lane.ts postAvaPrivate → the
    //     private:true postAvaMessage path) — structural privacy: the row is
    //     written ONLY to uid's own InboxDO, nobody else's. `moment` carries
    //     kind:'ava_moment' + capability + decision_id in `meta` so a future
    //     client card renderer can key off it; today's client has no such
    //     renderer and simply shows the lilac "Ava" text bubble — graceful
    //     degradation, not a forced client upgrade (bible §5).
    const postRes = await postAvaPrivate(env, {
      uid, conv, text: templateText,
      moment: { kind: "ava_moment", capability: cap.id, decision_id: decisionId },
      capability: cap.id,
      source: "odl",
    });

    if (postRes.ok) {
      try {
        await env.DB_META.prepare(
          `UPDATE ava_interventions SET status = 'posted', updated_at = ?1 WHERE decision_id = ?2 AND status = 'reserved'`,
        ).bind(Date.now(), decisionId).run();
      } catch { /* best-effort — a stuck 'reserved' row still self-heals via the 24h TTL sweep */ }
      void track(env, uid, "ava_moment_posted", "ava_odl", {
        decision_id: decisionId, capability: cap.id, conv_hash: convHash,
        opportunity, trigger_category: category, lang_guess: lang,
      });
    } else {
      // F7: "on failure leave 'reserved'" — do NOT flip to 'rejected' or
      // 'expired' here. The row is the durable proof this decision spent
      // budget without producing a card; the 24h sweep DELETEs it (freeing
      // decision_id's PK) if nothing ever resolves it, so a crash-stuck
      // reservation can eventually be retried instead of blocking forever.
      // v1 does not auto-retry the post (no queue exists for that here) — a
      // retried odlProcess call for this same message will see
      // reservedHere=false above and stop, by design.
      void track(env, uid, "ava_moment_post_failed", "ava_odl", {
        decision_id: decisionId, capability: cap.id, conv_hash: convHash,
        opportunity, trigger_category: category, lang_guess: lang, error: postRes.error ?? null,
      });
    }

    return { woke: true, capability: cap.id, opportunity, would_fire: true, templateText };
  } catch {
    // FAIL-SILENT — the ODL may never surface an error to any caller.
    return { woke: false, reason: "error" };
  }
}
