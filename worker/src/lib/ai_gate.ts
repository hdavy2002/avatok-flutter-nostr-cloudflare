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

const GUARD = "@cf/meta/llama-guard-3-8b";

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
 * llama-guard a single piece of text. Returns true when SAFE.
 * Fails OPEN on classifier error (matches conversation.ts / ava_agent.ts): a
 * guard outage must not silently brick chat. A confident "unsafe" fails closed.
 */
export async function isSafe(env: Env, text: string): Promise<boolean> {
  const t = (text ?? "").trim();
  if (!t) return true;
  try {
    const out: any = await env.AI.run(GUARD, { messages: [{ role: "user", content: t }] }, aiRunOpts(env));
    const verdict = (aiText(out) || JSON.stringify(out)).toLowerCase();
    return !verdict.includes("unsafe");
  } catch {
    return true; // fail open on classifier error
  }
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

// ---- the all-in-one wrapper -------------------------------------------------

export interface GatedResult {
  answer: string;
  blocked?: boolean;
  reason?: string;          // 'ai_disabled' | 'daily_cap' | 'input_unsafe' | 'output_unsafe'
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
  },
): Promise<GatedResult> {
  const cfg = await readConfig(env);
  if (!cfg.aiEnabled) return { answer: "", blocked: true, reason: "ai_disabled" };

  // (b) intent gate — free path, no spend, no cap consumed.
  const intent = intentGate(args.userText);
  if (!intent.needsModel) return { answer: intent.cannedReply ?? "", blocked: false };

  // (a) input moderation — mandatory on every tier incl. BYO.
  const gin = await guardInput(env, args.userText);
  if (!gin.ok) return { answer: REFUSAL, blocked: true, reason: gin.reason };

  // (c) quota — BYO/premium bypass; our-keys free tier capped + committed.
  let remaining: number | undefined;
  if (!args.skipQuota) {
    const q = await enforceQuota(env, args.uid, args.tier, { premium: args.premium, commit: true });
    if (!q.allowed) {
      return {
        answer: "You've reached today's free Ava limit. Connect your own Gemini key (Settings → Ava AI) for unlimited use, or try again tomorrow.",
        blocked: true, reason: q.reason, remaining: 0,
      };
    }
    remaining = q.remaining;
  }

  // generate → output guard → regenerate once → safe refusal.
  let answer = (await args.generate()).trim();
  if (!answer) answer = "Sorry, I couldn't come up with a reply just now. Try rephrasing?";
  if (!(await isSafe(env, answer))) {
    answer = (await args.generate("Keep the reply respectful, safe, and appropriate.")).trim();
    if (!answer || !(await isSafe(env, answer))) {
      return { answer: REFUSAL, blocked: true, reason: "output_unsafe", remaining };
    }
  }
  return { answer, blocked: false, remaining };
}
