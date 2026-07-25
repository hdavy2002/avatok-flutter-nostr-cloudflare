// ai_gate.ts — the cheap, mandatory gate every Ava inference flows through
// (Phase 2 — BYO-AI Proxy + Moderation Gate).
//
// Responsibilities (clean, composable functions P3 can call):
//   (a) MODERATION — llama-guard on the INPUT and on the OUTPUT. Mandatory on
//       BOTH tiers (BYO key included). Mirrors do/conversation.ts + do/ava_agent.ts:
//       `@cf/meta/llama-guard-3-8b`, "unsafe" verdict ⇒ block/refuse, regenerate
//       once. Fails OPEN on a classifier *error* (never block a user because the
//       guard model itself errored), but fails CLOSED on a confident "unsafe".
//   (b) INTENT GATE — a cheap heuristic: does this turn actually need the model /
//       a tool? Trivial acks ("ok", "thanks", an empty/emoji-only line) get a
//       canned reply with zero model spend.
//   (c) TIER ENFORCEMENT — daily cap for non-BYO free users (ai_quota), and the
//       `webSearchEnabled` / `fileAnalysisEnabled` premium flags. BYO bypasses
//       the cap; premium (openChatUncapped) bypasses the cap.
//
// The actual model call lives in routes/ava_gemini.ts (BYO → Google Gemini REST;
// our-keys → Workers-AI Gemma). The gate is model-agnostic: callers pass in a
// `generate(extraSteer?)` closure and the gate wraps it with input/output guard +
// regenerate-once. This lets P3's AvaAgentDO route its existing Gemma generation
// THROUGH the gate with a one-line change (see INTEGRATION-NOTES Phase 2).

import type { Env } from "../types";
import { aiText } from "../util";
import { readConfig } from "../routes/config";
import * as quota from "./ai_quota";
import { isFreeCapability } from "./ai_billing"; // [AVA-FREE-BUDGET-1] chat_ava/chat_thread never reserve or settle

const GUARD = "@cf/meta/llama-guard-3-8b";

/**
 * Classify a raw provider/model error (a thrown Error, a string, or a Gemini
 * error envelope) into a TRUTHFUL, user-facing message — so a failure surfaces
 * the real reason instead of a bare "I couldn't generate a response".
 *
 *   - "quota"  → the AI provider key hit its usage/rate limit (HTTP 429 /
 *     RESOURCE_EXHAUSTED / "exceeded your current quota"). This is an outage on
 *     OUR side, NOT the user's subscription, so we must NOT tell them their plan
 *     expired — we say "at capacity, try again shortly".
 *   - "safety" → the model refused on content-policy grounds. Reads as a refusal.
 *   - "other"  → message is null; the caller keeps its own generic fallback.
 *
 * NOTE: the per-tier daily IMAGE/CHAT allowance ("you've used all N today —
 * upgrade") is enforced separately via enforceAllowance/ai_quota and is the
 * correct place for plan-limit wording. This helper is only for hard provider
 * errors that would otherwise be swallowed.
 */
export function friendlyAiError(raw: unknown): { kind: "quota" | "safety" | "other"; message: string | null } {
  const s = String((raw as any)?.message ?? raw ?? "").toLowerCase();
  if (/\b429\b|quota|resource_exhausted|rate.?limit|too many requests|exceeded your current|billing details/.test(s)) {
    return {
      kind: "quota",
      message:
        "Ava's AI is at capacity right now — it has hit its current usage limit. " +
        "This usually clears within a few minutes, so please try again shortly.",
    };
  }
  if (/safety|blocked|prohibited|recitation|harm_category|content policy|policy_violation/.test(s)) {
    return {
      kind: "safety",
      message: "I can't help with that particular request. Try rephrasing it or a different idea.",
    };
  }
  return { kind: "other", message: null };
}

/**
 * Options for every `env.AI.run(...)` call. When AI_GATEWAY_ID is configured we
 * route Workers-AI inference through the Cloudflare AI Gateway for per-request
 * cost logging, caching, and a hard spend cap. Passing `uid` tags the request
 * with per-user metadata so the gateway dashboard can break spend down by user.
 * No-op (undefined) when no gateway is configured.
 */
export function aiRunOpts(env: Env, uid?: string): any {
  const id = env.AI_GATEWAY_ID;
  if (!id) return undefined;
  const gateway: any = { id };
  if (uid) gateway.metadata = { uid };
  return { gateway };
}

// ---- (a) moderation ---------------------------------------------------------

/**
 * Content moderation for the Ava AI paths is REMOVED (owner decision 2026-06-24,
 * Specs §2A). ChatAva (/api/ava/gemini), @ava replies, agent-to-agent, the offline
 * auto-reply, and image prompts are no longer content-checked. This is a no-op so
 * the wrappers below (guardInput/guardOutput/runGated) keep their shape and the
 * kill-switch / intent gate / daily quota all still work. The surfaces that DO
 * moderate are the shield watchdog (ava_guardian) and save-time field validation
 * (/api/moderate) — both via lib/moderation.ts (Nemotron over OpenRouter).
 */
export async function isSafe(_env: Env, _text: string): Promise<boolean> {
  return true;
}

/** Guard the user's INPUT. `{ ok:false, reason }` when the input is unsafe. */
export async function guardInput(env: Env, text: string): Promise<{ ok: boolean; reason?: string }> {
  if (await isSafe(env, text)) return { ok: true };
  return { ok: false, reason: "input_unsafe" };
}

/**
 * Guard a generated OUTPUT. `{ ok:false }` when the output is unsafe so the
 * caller can regenerate / refuse. (Pairs with `runGated` which does the
 * regenerate-once dance for you.)
 */
export async function guardOutput(env: Env, text: string): Promise<{ ok: boolean; reason?: string }> {
  if (await isSafe(env, text)) return { ok: true };
  return { ok: false, reason: "output_unsafe" };
}

// ---- (b) intent gate --------------------------------------------------------

const ACK_RE = /^(ok|okay|k|kk|thanks|thank you|thx|ty|cool|nice|great|got it|👍|🙏|👌|❤️|😊|lol|haha)[.!]*$/i;

export interface IntentVerdict {
  needsModel: boolean;     // false ⇒ skip the model entirely
  cannedReply?: string;    // a free, no-spend reply when !needsModel
}

/**
 * Cheap, deterministic "does this turn need the model?" check. Keeps trivial
 * acknowledgements from burning a turn / a model call. Conservative: anything
 * non-trivial (a question, a request, anything longer than a word or two) goes
 * to the model. P5's tool broker can extend this later (it owns tool intent).
 */
export function intentGate(userText: string): IntentVerdict {
  const t = (userText ?? "").replace(/^@ava!?\s*/i, "").replace(/^@ava\s+\(?private\)?\s*/i, "").trim();
  if (!t) return { needsModel: false, cannedReply: "I'm here — what would you like to ask?" };
  if (ACK_RE.test(t)) return { needsModel: false, cannedReply: "You're welcome! 😊" };
  return { needsModel: true };
}

// ---- (c) tier enforcement ---------------------------------------------------

export type AiTier = "byo" | "ourkeys";

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;          // 'daily_cap' when blocked
  remaining?: number;       // turns left today (capped tier only)
  limit?: number;
}

/**
 * Enforce the daily turn cap. BYO and premium (openChatUncapped) bypass it.
 * For the capped our-keys free tier this checks the counter, and — when
 * `commit` is true — increments it. Returns whether the turn is allowed.
 *
 * Pattern: call once with `commit:false` to pre-flight; or once with `commit:true`
 * to atomically (best-effort) reserve a turn. ava_gemini calls it with commit:true
 * after the input guard passes and the intent gate says the model is needed.
 */
export async function enforceQuota(
  env: Env,
  uid: string,
  tier: AiTier,
  opts: { premium?: boolean; commit?: boolean } = {},
): Promise<QuotaDecision> {
  if (tier === "byo" || opts.premium) return { allowed: true };
  const cfg = await readConfig(env);
  if (cfg.openChatUncapped) return { allowed: true };
  const limit = Number(cfg.dailyAvaTurnLimit) || 25;

  const state = await quota.check(env, uid, limit);
  if (state.exceeded) {
    return { allowed: false, reason: "daily_cap", remaining: 0, limit };
  }
  if (opts.commit) {
    const after = await quota.increment(env, uid, limit);
    return { allowed: true, remaining: after.remaining, limit };
  }
  return { allowed: true, remaining: state.remaining, limit };
}

/** Is web search available to this turn? Premium-only flag (config). */
export async function webSearchAllowed(env: Env, tier: AiTier, premium?: boolean): Promise<boolean> {
  const cfg = await readConfig(env);
  return cfg.webSearchEnabled && (tier === "byo" || !!premium);
}

/** Is file analysis available to this turn? Premium-only flag (config). */
export async function fileAnalysisAllowed(env: Env, tier: AiTier, premium?: boolean): Promise<boolean> {
  const cfg = await readConfig(env);
  return cfg.fileAnalysisEnabled && (tier === "byo" || !!premium);
}

// ---- (d) free-text-lane budgets [AVA-FREE-BUDGET-1] -------------------------
//
// Text chat (`chat_ava` — Ask Ava/composer, `chat_thread` — #ava/@ava, routed to
// deepseek/deepseek-v4-flash) is structurally free: ai_billing.isFreeCapability()
// makes reserveAiJob/settleAiJob a permanent no-op for these two capabilities,
// even with aiWalletMeteringEnabled=true (report §12b). That is a BILLING
// decision, not a COST bound — report §19b: a turn cap alone does not bound
// spend once the model has a 1,048,576-token context (200 capped turns of
// pasted documents could reach ~200M input tokens/day, ~$19/day from one
// account). The functions below are the actual cost/abuse bound for the free
// lane: a per-turn input ceiling, plus a per-account daily input/output/cost
// budget, UTC-day reset. The existing turn cap (enforceQuota/dailyAvaTurnLimit)
// remains a SECONDARY anti-script limit on top of these.
//
// STORAGE: reuses ai_quota.ts's precedent — one KV key per uid per UTC day,
// TTL so a day's counter self-evicts, best-effort/fail-open — rather than
// inventing a new store shape. Same technique, a different counter (token/cost
// usage instead of a turn count). ai_quota.ts itself is owned by a different
// change in this wave, so this is a parallel key, not a shared one.

const FREE_BUDGET_TTL_SECONDS = 2 * 24 * 60 * 60; // survives the UTC-day boundary, then self-evicts (mirrors ai_quota.ts)

function freeBudgetDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
function freeBudgetKvKey(uid: string, day = freeBudgetDayKey()): string {
  return `free_text_budget:${uid}:${day}`;
}

export interface FreeTextUsage {
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

async function readFreeTextUsage(env: Env, uid: string): Promise<FreeTextUsage> {
  try {
    const raw = await env.TOKENS.get(freeBudgetKvKey(uid));
    if (!raw) return { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
    const j = JSON.parse(raw);
    return {
      inputTokens: Math.max(0, Number(j?.inputTokens) || 0),
      outputTokens: Math.max(0, Number(j?.outputTokens) || 0),
      costMicroUsd: Math.max(0, Number(j?.costMicroUsd) || 0),
    };
  } catch { return { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }; }
}

/**
 * Rough, fast token estimate for the free-text budget — this codebase has no
 * tokenizer on the hot path, and an estimate is all a PRE-FLIGHT check needs
 * (report §65: the estimator bounds the reserve/pre-flight, it is never the
 * authority for a charge — this lane never charges at all). ~4 chars/token is
 * the standard rough ratio for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Math.max(0, (text ?? "").length) / 4);
}

// DeepSeek V4 Flash's own published OpenRouter pricing (report §11a), used
// ONLY for the INTERNAL platform-cost budget below — never for user billing;
// free capabilities never consult a price catalog at all (report §65 / Part X).
// Hardcoded here rather than read from ai_billing.ts's AI_PRICE_CATALOG because
// that catalog does not carry a deepseek/deepseek-v4-flash entry yet
// ([AI-PRICE-CATALOG-1] is a separate, later work item) — falling through to
// AI_DEFAULT_RATE ($5/$15 per 1M, ~50-100x too high) would exhaust this budget
// almost immediately on real free-chat traffic. Re-point this at the catalog
// once AI-PRICE-CATALOG-1 lands so there is one source of truth.
const DEEPSEEK_IN_PER_M_MICRO_USD = 93_800;   // $0.0938 / 1M input tokens
const DEEPSEEK_OUT_PER_M_MICRO_USD = 187_600; // $0.1876 / 1M output tokens

function freeTextCostMicroUsd(inputTokens: number, outputTokens: number): number {
  const inTok = Math.max(0, Math.trunc(inputTokens));
  const outTok = Math.max(0, Math.trunc(outputTokens));
  return Math.ceil((inTok * DEEPSEEK_IN_PER_M_MICRO_USD) / 1_000_000)
       + Math.ceil((outTok * DEEPSEEK_OUT_PER_M_MICRO_USD) / 1_000_000);
}

/**
 * Add usage to uid's free-text daily counters. Call for EVERY model-ish call a
 * free turn makes — generation, guardInput, isSafe, and any regenerate —
 * even though NONE of them are ever wallet-billed (report §19a: "a free turn
 * is 3-4 model calls, not one"; §55: "count safety/moderation model calls and
 * retries against the internal platform-cost budget"). Best-effort; never
 * throws — a counter-write failure must never block or corrupt a turn.
 */
export async function recordFreeTextUsage(
  env: Env,
  uid: string,
  usage: { inputTokens?: number; outputTokens?: number },
): Promise<void> {
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens ?? 0));
  if (!inputTokens && !outputTokens) return;
  const costMicroUsd = freeTextCostMicroUsd(inputTokens, outputTokens);
  try {
    const cur = await readFreeTextUsage(env, uid);
    const next: FreeTextUsage = {
      inputTokens: cur.inputTokens + inputTokens,
      outputTokens: cur.outputTokens + outputTokens,
      costMicroUsd: cur.costMicroUsd + costMicroUsd,
    };
    await env.TOKENS.put(freeBudgetKvKey(uid), JSON.stringify(next), { expirationTtl: FREE_BUDGET_TTL_SECONDS });
  } catch { /* fail open — never block a turn on a counter write */ }
}

export type FreeTextBudgetReason = "input_too_large" | "daily_ai_budget_exhausted";

export interface FreeTextBudgetDecision {
  allowed: boolean;
  reason?: FreeTextBudgetReason;
  usage?: FreeTextUsage;
}

/**
 * Pre-flight check for the free text lane (report §19b/§55) — call BEFORE
 * guardInput/generate/isSafe run. Rejects an oversized single turn with
 * `input_too_large`, or a turn once the account's UTC-day input/output/cost
 * budget is exhausted with `daily_ai_budget_exhausted`. NEVER returns a
 * wallet/paywall reason — the free text lane has no wallet involvement at all
 * (that was Part I §2c/§7's root failure: a billing rejection rendered to the
 * user as "Sorry, I could not find an answer").
 */
export async function checkFreeTextBudget(
  env: Env,
  uid: string,
  inputTokens: number,
): Promise<FreeTextBudgetDecision> {
  const cfg = await readConfig(env);
  const maxInput = Number(cfg.freeTextMaxInputTokens) || 32_000;
  if (inputTokens > maxInput) return { allowed: false, reason: "input_too_large" };

  const dailyIn = Number(cfg.freeTextDailyInputTokens) || 2_000_000;
  const dailyOut = Number(cfg.freeTextDailyOutputTokens) || 200_000;
  const dailyCost = Number(cfg.freeTextDailyCostMicroUsd) || 50_000;

  const usage = await readFreeTextUsage(env, uid);
  if (
    usage.inputTokens + inputTokens > dailyIn
    || usage.outputTokens >= dailyOut
    || usage.costMicroUsd >= dailyCost
  ) {
    return { allowed: false, reason: "daily_ai_budget_exhausted", usage };
  }
  return { allowed: true, usage };
}

/** User-facing copy for a free-budget rejection — never mentions a wallet, a paywall, Gemini, or BYO keys. */
export const FREE_BUDGET_MESSAGE: Record<FreeTextBudgetReason, string> = {
  input_too_large:
    "That message is too long for a quick chat reply — try trimming it, or share it as a file for Ava to go through.",
  daily_ai_budget_exhausted:
    "You've reached today's free Ava chat limit. It's a generous daily allowance and resets at midnight UTC — try again then.",
};

// ---- the all-in-one wrapper -------------------------------------------------

export interface GatedResult {
  answer: string;
  blocked?: boolean;
  reason?: string;          // 'ai_disabled' | 'daily_cap' | 'input_unsafe' | 'output_unsafe' | 'input_too_large' | 'daily_ai_budget_exhausted'
  remaining?: number;       // turns left today (capped tier)
}

const REFUSAL = "I can't help with that one. Let's keep things safe — ask me something else?";

/**
 * runGated — the single entry point that wraps a model call with the full gate:
 * master kill-switch → intent gate → input guard → quota → generate → output
 * guard (regenerate once → safe refusal).
 *
 * `generate(steer?)` is the caller's model closure: BYO calls Google Gemini,
 * our-keys calls Workers-AI Gemma, P3 calls its own AvaAgentDO.generate. `steer`
 * is an optional extra instruction appended on the regenerate pass ("keep it
 * safe/respectful"). The gate is model-agnostic.
 */
export async function runGated(
  env: Env,
  args: {
    uid: string;
    tier: AiTier;
    premium?: boolean;
    userText: string;
    generate: (steer?: string) => Promise<string>;
    // Skip the daily-cap commit (e.g. a server-initiated turn). Default false.
    skipQuota?: boolean;
    // [AVA-FREE-BUDGET-1] Capability tag (e.g. 'chat_ava' | 'chat_thread') and a
    // measured/estimated INPUT token count for this turn's prompt. When the
    // capability is free (ai_billing.isFreeCapability), runGated enforces the
    // per-turn ceiling + daily input/output/cost budgets BEFORE any guard/model
    // call runs, and records actual usage from every guard/generate/regenerate
    // call against the same UTC-day counters afterward. Non-free capabilities
    // (capability omitted, or not in FREE_CAPABILITIES) are completely
    // unaffected — this is additive to wallet metering, never a replacement.
    capability?: string;
    inputTokens?: number;
  },
): Promise<GatedResult> {
  const cfg = await readConfig(env);
  if (!cfg.aiEnabled) return { answer: "", blocked: true, reason: "ai_disabled" };

  // (b) intent gate — free path, no spend, no cap consumed, no budget touched.
  const intent = intentGate(args.userText);
  if (!intent.needsModel) return { answer: intent.cannedReply ?? "", blocked: false };

  const free = !!args.capability && isFreeCapability(args.capability);
  const turnInputTokens = args.inputTokens ?? estimateTokens(args.userText);

  // [AVA-FREE-BUDGET-1] free-lane budget gate — BEFORE guardInput/generate
  // (report §55). Never a wallet/paywall reason: the free text lane has no
  // wallet path to fail on (Part I §2c/§7).
  if (free) {
    const decision = await checkFreeTextBudget(env, args.uid, turnInputTokens);
    if (!decision.allowed) {
      return { answer: FREE_BUDGET_MESSAGE[decision.reason as FreeTextBudgetReason], blocked: true, reason: decision.reason };
    }
  }

  // Running tally of this turn's platform-cost usage (free lane only) — every
  // guard/generate/regenerate call below adds to it, then it is recorded once
  // at every exit point (report §19a: "a free turn is 3-4 model calls").
  let freeInTokens = 0;
  let freeOutTokens = 0;
  const trackFree = (inTok: number, outTok: number): void => {
    freeInTokens += Math.max(0, inTok);
    freeOutTokens += Math.max(0, outTok);
  };
  const flushFreeUsage = async (): Promise<void> => {
    if (!free) return;
    await recordFreeTextUsage(env, args.uid, { inputTokens: freeInTokens, outputTokens: freeOutTokens });
  };

  // (a) input moderation — mandatory on every tier incl. BYO. Counts as one
  // model-ish call against the free-lane platform-cost budget even though
  // isSafe() is currently a no-op (content moderation removed 2026-06-24 — see
  // isSafe's own doc comment above); accounting stays correct if/when it is
  // revived, and costs nothing extra today.
  const gin = await guardInput(env, args.userText);
  if (free) trackFree(turnInputTokens, 0);
  if (!gin.ok) {
    await flushFreeUsage();
    return { answer: REFUSAL, blocked: true, reason: gin.reason };
  }

  // (c) quota — BYO/premium bypass; our-keys free tier capped + committed.
  // This is now the SECONDARY anti-script turn limit (report §55/§19b) — the
  // budgets above are the real cost bound for the free lane.
  let remaining: number | undefined;
  if (!args.skipQuota) {
    const q = await enforceQuota(env, args.uid, args.tier, { premium: args.premium, commit: true });
    if (!q.allowed) {
      await flushFreeUsage();
      return {
        answer: "You've reached today's Ava chat limit for now. It resets at midnight UTC — try again after that.",
        blocked: true, reason: q.reason, remaining: 0,
      };
    }
    remaining = q.remaining;
  }

  // generate → output guard → regenerate once → safe refusal.
  let answer = (await args.generate()).trim();
  if (free) trackFree(turnInputTokens, estimateTokens(answer));
  if (!answer) answer = "Sorry, I couldn't come up with a reply just now. Try rephrasing?";
  const safe1 = await isSafe(env, answer);
  if (free) trackFree(estimateTokens(answer), 0); // isSafe reads the answer as its input
  if (!safe1) {
    answer = (await args.generate("Keep the reply respectful, safe, and appropriate.")).trim();
    if (free) trackFree(turnInputTokens, estimateTokens(answer)); // regenerate = a full second generation
    const safe2 = answer ? await isSafe(env, answer) : false;
    if (free) trackFree(estimateTokens(answer), 0); // second isSafe pass
    if (!answer || !safe2) {
      await flushFreeUsage();
      return { answer: REFUSAL, blocked: true, reason: "output_unsafe", remaining };
    }
  }
  await flushFreeUsage();
  return { answer, blocked: false, remaining };
}
