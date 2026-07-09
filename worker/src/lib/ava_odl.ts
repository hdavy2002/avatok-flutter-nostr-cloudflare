// ava_odl.ts — Phase C. The Opportunity Detection Layer orchestrator (plan §8,
// D17 dormant-by-default, D27 shadow lifecycle).
//
// odlProcess(env, {uid, conv, text, senderUid, isGroup}) runs once per
// (recipient, message) from the Guardian per-message scan site. It is the
// deterministic funnel head:
//
//   per-chat toggle → matchTriggers (regex) → Opportunity Score → Capability
//   Registry → budget gate → Governor gate → SHADOW: telemetry only.
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
//
// TELEMETRY (app_name "ava_odl"):
//   ava_odl_wake          every trigger match (the ~10–20% wake rate)
//   ava_odl_sleep         no-match messages, SAMPLED 1:100 (stay cheap)
//   ava_moment_shadow     the shadow projection event (per woke capability)

import type { Env } from "../types";
import { track } from "../hooks";
import { readConfig } from "../routes/config";
import { matchTriggers, matchedCategories, TRIGGER_BANK_VERSION } from "./ava_triggers";
import { opportunityScore } from "./ava_opportunity";
import { getCapability, CATEGORY_TO_CAPABILITY } from "./ava_capabilities";
import { checkAndSpend, spendMoment, getTrust, isMuted } from "./ava_budget";
import { governorGate } from "./ava_governor";
import { guessLang, hasTemplate, pickTemplate, fillTemplate } from "./ava_templates";

const SLEEP_SAMPLE = 100; // 1:100 sampling for ava_odl_sleep

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
  // Populated ONLY for lifecycle "production" capabilities (none in v1) — the
  // future posting path picks this up; shadow never sets it.
  templateText?: string;
}

/**
 * odlProcess — the whole ODL, fail-silent, zero AI. Safe to call detached
 * (`void odlProcess(...)`) from any per-message site.
 */
export async function odlProcess(env: Env, input: OdlInput): Promise<OdlResult> {
  try {
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

    // 4a. Capability kill switch (flag blob; explicitly false = OFF).
    try {
      const cfg: any = await readConfig(env);
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

    // 6. PRODUCTION lifecycle (NONE in v1 — reached only after a D25-gated
    //    promotion). Templates first (Constitution 7); the actual private-lane
    //    post lands with the posting phase — until then production behaves like
    //    shadow-with-a-template so promotion is a pure registry flip.
    if (!wouldFire) return { woke: true, capability: cap.id, opportunity, would_fire: false, reason: gateReason ?? undefined };
    const tpl = pickTemplate(cap.id, lang);
    const templateText = tpl ? fillTemplate(tpl.text, {}) : undefined;
    void track(env, uid, "ava_moment_candidate", "ava_odl", {
      conv, is_group: !!input.isGroup, capability: cap.id, opportunity,
      trigger_category: category, lang_guess: lang, template_used: !!tpl,
    });
    // (future) postAvaMessage private Moment goes here — deliberately NOT wired
    // in Phase C/D: no capability is production, and posting needs its own review.
    return { woke: true, capability: cap.id, opportunity, would_fire: true, templateText };
  } catch {
    // FAIL-SILENT — the ODL may never surface an error to any caller.
    return { woke: false, reason: "error" };
  }
}
