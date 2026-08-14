// [AI-BILLING-CORE-1] Universal AIJob reserve/settle/release wallet-metering
// contract (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md §H2/H3/H6, §J13).
//
// FLAG-GATED DARK: `aiWalletMeteringEnabled` (routes/config.ts, default FALSE).
// While off, every exported lifecycle function below is a NO-OP PASS-THROUGH —
// reserveAiJob always admits with reserved_tokens:0/metered:false, settleAiJob/
// releaseAiJob debit and release nothing — so wiring this contract into a call
// site changes NOTHING in production until the owner flips the flag. Telemetry
// still fires (with metered:false) even while dark, so adoption is observable
// before it is ever billable.
//
// STORAGE DECISION — reservation admission reuses the WalletDO's EXISTING
// generic escrow primitives (`reserve` / `consume_reserved` / `release_reservation`
// / `settle_ai_cost`, worker/src/do/wallet.ts, tag [AVA-CAMP-B1-WALLET] /
// [AI-WALLET-SPENDABLE-2]), keyed by ref = `aijob:<opId>`. That mechanism
// already gives exactly what H3 asks for: atomic per-uid admission
// (spendable/paid headroom >= amount + all other outstanding reservations,
// §58's conservative cross-policy rule), op_id-deduped idempotency, and a
// real permanent debit only at settle time with the untouched remainder
// released back to headroom. Reusing it means this file makes NO schema
// changes to wallet.ts's core primitives — it composes on top.
// (worker/src/feature_pricing.ts leans on the SAME primitives for its own,
// now-deprecated, reserveAiUsage/settleAiUsage/releaseAiUsage — see the doc
// comment there.)
//
// The one thing the generic WalletDO resv table does NOT carry is AI-specific
// billing detail (model requested/actual, usage breakdown, provider cost,
// markup, terminal status, unrecovered loss, cost provenance) — that is what
// the durable D1 ledger (worker/migrations/2026-07-24-ai-billing-ledger.sql +
// 2026-07-25-ai-billing-ledger-unrecovered.sql, table `ai_billing_ledger`,
// DB_WALLET binding) is for. It is written/updated by op_id (PK), independent
// of and reconcilable against WalletDO's own audit trail (wallet_ledger /
// wallet_transactions).
//
// MATH — all money math is done in integer MICRO-USD (USD * 1e6) to avoid
// floating-point rounding drift. See costMicroUsd / userChargeMicroUsd /
// microUsdToTokens below for the three pure steps of §H2's formula:
//   provider_cost_usd = tokens * price_per_M / 1e6
//   user_cost_usd      = provider_cost_usd * 1.20            (ceil)
//   wallet_debit_tokens = user_cost_usd * 100 tokens/USD      (ceil)
// [AI-WALLET-SPENDABLE-2] (2026-07-25) the RESERVE-time estimate above still
// uses this per-job ceil-to-whole-token pipeline (it must be conservative).
// The SETTLE-time charge no longer ceils per job — it accrues into
// WalletDO's acct.debt_micro_usd via the atomic `settle_ai_cost` op
// (do/wallet.ts, computeAiSettlement()) so a run of sub-cent jobs is billed
// at its correct CUMULATIVE price instead of each one rounding up alone.
//
// SAFETY — Guardian/moderation/safety-classifier capabilities NEVER go through
// this contract; reserveAiJob short-circuits to an unmetered success for them
// (isSafetyCapability), so a safety scan can never be blocked or billed by a
// wallet balance (H4).
//
// [AI-WALLET-SPENDABLE-2] FREE CAPABILITIES — `chat_ava` (Ask Ava) and
// `chat_thread` (#ava/@ava in Messenger) are FREE TEXT CHAT, never metered,
// REGARDLESS of `aiWalletMeteringEnabled` (Part I §2 / Part VIII §52/§65 of
// Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md — this is the exact
// bug that made every non-paying user's AI chat return a silent 402 rendered
// as "Sorry, I could not find an answer"). isFreeCapability() short-circuits
// BOTH reserveAiJob() and settleAiJob() before any config read, catalog
// lookup, or wallet call — a free capability must NEVER consult the price
// catalog and must NEVER touch the wallet.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { walletOp } from "../routes/wallet";
import { track, trackException } from "../hooks";
import { shouldFail } from "./fault_inject";

// ---------------------------------------------------------------------------
// Price catalog — versioned, in-code, server-owned. The client never chooses
// a price or submits usage; it only ever sees the wallet-token result.
// ---------------------------------------------------------------------------

export interface ModelRate {
  /** USD per 1,000,000 input tokens, expressed in MICRO-USD (USD * 1e6). */
  inPerM: number;
  /** USD per 1,000,000 output tokens, expressed in MICRO-USD. */
  outPerM: number;
  /** USD per generated image (image-generation modality), in MICRO-USD. Unset = modality not priced yet. Prefer `imageOutputPerM` for providers (OpenRouter) that bill generated images as image_output TOKENS rather than a flat per-image price. */
  imageUnitMicroUsd?: number;
  /** USD per 1,000,000 "image_output" tokens (OpenRouter's generated-image billing unit — varies by resolution/provider, NOT a flat per-image constant), in MICRO-USD. */
  imageOutputPerM?: number;
  /** USD per OCR'd page (document/OCR modality), in MICRO-USD. */
  ocrPageMicroUsd?: number;
  /** USD per second of audio/video processed, in MICRO-USD. */
  avSecondMicroUsd?: number;
  /** Date this row was last checked against the live OpenRouter listing (YYYY-MM-DD). */
  effectiveDate: string;
  /** Per-model kill switch — when true, reserveAiJob refuses this model (checked only while metering is ON). */
  disabled?: boolean;
  /** True when this is a conservative placeholder, not a verified list price — re-check before relying on it. */
  todoVerifyPrice?: boolean;
  /** Where the number came from, for the next person who re-verifies it. */
  source?: string;
}

const USD = 1_000_000; // 1 USD expressed in micro-USD, for readability at the catalog literal sites below

export const AI_PRICE_CATALOG: Record<string, ModelRate> = {
  // Verified 2026-07-24 (https://openrouter.ai/moonshotai/kimi-k3-20260715): $3 / $15 per 1M, 1M context.
  "moonshotai/kimi-k3": {
    inPerM: 3 * USD, outPerM: 15 * USD, effectiveDate: "2026-07-24",
    source: "https://openrouter.ai/moonshotai/kimi-k3-20260715",
  },
  // Verified 2026-07-24 (https://openrouter.ai/google/gemini-2.5-flash-lite): $0.10 / $0.40 per 1M.
  // Matches the existing AI_MODEL_RATES entry in worker/src/feature_pricing.ts exactly.
  "google/gemini-2.5-flash-lite": {
    inPerM: Math.round(0.10 * USD), outPerM: Math.round(0.40 * USD), effectiveDate: "2026-07-24",
    source: "https://openrouter.ai/google/gemini-2.5-flash-lite",
  },
  // TODO(verify): "google/gemini-3.5-flash" has no confirmed live OpenRouter listing as
  // of this change (2026-07-24) — this is a PLACEHOLDER, conservatively set to match the
  // sibling "google/gemini-3-flash-preview" entry already priced in feature_pricing.ts
  // ($0.50/$3 per 1M). Re-verify against the real listing before this id is ever selected
  // by a live model router.
  "google/gemini-3.5-flash": {
    inPerM: Math.round(0.5 * USD), outPerM: 3 * USD, effectiveDate: "2026-07-24",
    todoVerifyPrice: true, source: "TODO: no confirmed OpenRouter listing yet; placeholder matches gemini-3-flash-preview",
  },
  // Verified 2026-07-24 (https://openrouter.ai/z-ai/glm-5.2): listing showed a "46% off"
  // PROMO price of $0.7546 / $2.372 per 1M (list/non-promo price is higher). Billing at the
  // promo/effective price OpenRouter actually charges today. z-ai/glm-5.2 is the live
  // default OpenRouter model for ChatAVA (ava_gemini.ts openRouterModel()), so this rate
  // matters — todoVerifyPrice is set because promo pricing is exactly the kind of drift H1
  // warns must not be hardcoded forever; re-check once the promo window is known to end.
  "z-ai/glm-5.2": {
    inPerM: Math.round(0.7546 * USD), outPerM: Math.round(2.372 * USD), effectiveDate: "2026-07-24",
    todoVerifyPrice: true, source: "https://openrouter.ai/z-ai/glm-5.2 (promo price — re-verify after the promo window ends)",
  },
  // [AI-WALLET-SPENDABLE-2 / AI-PRICE-CATALOG-1] Verified 2026-07-25 — added in
  // the SAME commit that routes to it (Part III §59a: routing a model before
  // cataloguing it bills at the ~100x-expensive AI_DEFAULT_RATE fallback).
  "deepseek/deepseek-v4-flash": {
    inPerM: Math.round(0.0938 * USD), outPerM: Math.round(0.1876 * USD), effectiveDate: "2026-07-25",
    source: "verified 2026-07-25 for [AI-WALLET-SPENDABLE-2] catalog prerequisite (free-chat lane candidate, Part II §11a)",
  },
  "google/gemma-3-12b-it": {
    inPerM: Math.round(0.05 * USD), outPerM: Math.round(0.15 * USD), effectiveDate: "2026-07-25",
    source: "verified 2026-07-25 for [AI-WALLET-SPENDABLE-2] catalog prerequisite (vision-capable lane candidate)",
  },
  "google/gemma-3-4b-it": {
    inPerM: Math.round(0.05 * USD), outPerM: Math.round(0.10 * USD), effectiveDate: "2026-07-25",
    source: "verified 2026-07-25 for [AI-WALLET-SPENDABLE-2] catalog prerequisite",
  },
  "mistralai/mistral-nemo": {
    inPerM: Math.round(0.019 * USD), outPerM: Math.round(0.030 * USD), effectiveDate: "2026-07-25",
    source: "verified 2026-07-25 for [AI-WALLET-SPENDABLE-2] catalog prerequisite",
  },
  // OpenRouter lists $0.0015/audio minute. Billing math uses integer
  // micro-USD per second: 0.0015 USD * 1e6 / 60 = 25.
  "openai/whisper-large-v3": {
    inPerM: 0, outPerM: 0, avSecondMicroUsd: 25,
    effectiveDate: "2026-07-25",
    source: "https://openrouter.ai/openai/whisper-large-v3/pricing ($0.0015/minute)",
  },
  // Image generation — OpenRouter bills generated images as `image_output`
  // TOKENS, not a flat per-image constant (see UsageUnits.imageOutputTokens /
  // imageOutputPerM below); the count MUST be read from the provider's own
  // reported usage at settle time, never hardcoded tokens-per-image.
  "openai/gpt-5-image-mini": {
    inPerM: Math.round(2.50 * USD), outPerM: Math.round(2.00 * USD), imageOutputPerM: Math.round(8.00 * USD),
    effectiveDate: "2026-07-25", source: "verified 2026-07-25 for [AI-WALLET-SPENDABLE-2] catalog prerequisite (image-generation lane candidate)",
  },
};

/**
 * Conservative default for any model not in the catalog — deliberately
 * expensive so an unpriced model's RESERVE never under-reserves headroom.
 * [AI-WALLET-SPENDABLE-2 / §65] This rate MUST NEVER be used to actually BILL
 * a user (that would be the exact ~100x overcharge Part III §59a warns
 * about). It is the reserve-time estimator only. The CHARGE always prefers
 * provider-reported `usage.cost` (ground truth); when neither that nor a
 * catalog entry exists at settle time, the result is delivered free (charge
 * zero) and `AI_PRICE_UNKNOWN` is alerted as platform loss — see
 * settleAiJob() below. AI_DEFAULT_RATE is never read on that path.
 */
export const AI_DEFAULT_RATE: ModelRate = {
  inPerM: 5 * USD, outPerM: 15 * USD, effectiveDate: "2026-07-24",
  source: "conservative RESERVE-ONLY default (AI_DEFAULT_RATE, worker/src/lib/ai_billing.ts) — never used to settle a charge",
};

export function rateFor(model: string): ModelRate {
  const exact = AI_PRICE_CATALOG[String(model || "").trim()];
  return exact ?? AI_DEFAULT_RATE;
}

// ---------------------------------------------------------------------------
// Pure money math — integer micro-USD throughout, no floats. Kept as small,
// independently testable functions per the task's "tests can cover them
// later" requirement.
// ---------------------------------------------------------------------------

export interface UsageUnits {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;    // image-generation units (COUNT of images — only used to derive a RESERVE ceiling; never the charge)
  /** [AI-WALLET-SPENDABLE-2] OpenRouter-reported generated-image "image_output"
   * tokens — the REAL billing unit for image generation on that provider.
   * Read this straight off the provider's own usage payload at settle time;
   * do NOT hardcode a tokens-per-image constant (it varies by resolution and
   * provider). Priced via ModelRate.imageOutputPerM. */
  imageOutputTokens?: number;
  ocrPages?: number;   // OCR page units
  avSeconds?: number;  // audio/video seconds
}

/** cost_micro_usd = tokens * price_per_M_micro / 1e6 (+ any priced modality units). Pure, integer-safe, floors (never over-estimates provider cost). */
export function costMicroUsd(model: string, usage: UsageUnits): number {
  const r = rateFor(model);
  const inTok = Math.max(0, Math.trunc(usage.inputTokens || 0));
  const outTok = Math.max(0, Math.trunc(usage.outputTokens || 0));
  const images = Math.max(0, Math.trunc(usage.images || 0));
  const imageOutputTokens = Math.max(0, Math.trunc(usage.imageOutputTokens || 0));
  const ocrPages = Math.max(0, Math.trunc(usage.ocrPages || 0));
  const avSeconds = Math.max(0, Math.trunc(usage.avSeconds || 0));
  let total = 0;
  total += Math.floor((inTok * r.inPerM) / 1_000_000);
  total += Math.floor((outTok * r.outPerM) / 1_000_000);
  if (imageOutputTokens && r.imageOutputPerM) total += Math.floor((imageOutputTokens * r.imageOutputPerM) / 1_000_000);
  else if (images && r.imageUnitMicroUsd) total += images * r.imageUnitMicroUsd; // legacy flat-per-image fallback for providers that DO bill a flat unit
  if (ocrPages && r.ocrPageMicroUsd) total += ocrPages * r.ocrPageMicroUsd;
  if (avSeconds && r.avSecondMicroUsd) total += avSeconds * r.avSecondMicroUsd;
  return total;
}

/** AI_MARKUP as basis-points-of-percent: 120 == 1.20x == 20% markup (owner pricing decision, Part VIII §61 — usage-priced AI provider work is charged at actual cost + 20%; FEATURE_COSTS fixed retail prices are unaffected). Stored as an integer so ledger rows never carry a float. */
export const AI_MARKUP_BPS = 120;

/** user_cost_usd_micro = ceil(provider_cost_usd_micro * 1.20). Integer math: *120, /100, ceil. */
export function userChargeMicroUsd(providerCostMicroUsd: number): number {
  const p = Math.max(0, Math.trunc(providerCostMicroUsd));
  return Math.ceil((p * AI_MARKUP_BPS) / 100);
}

/** Provider-cost basis: 1 USD = 100 wallet tokens (matches wallet.ts TOKENS_PER_USD).
 *  This is COST accounting only — provider invoices are in USD. The user-facing
 *  price of a token is \u20b91 (near-parity: 1 US cent = \u20b90.964). */
export const AI_TOKENS_PER_USD = 100;

/** 1 wallet token == $0.01 == 10,000 micro-USD. Mirrors do/wallet.ts's TOKEN_MICRO_USD (defined independently there — the DO module intentionally does not import this file). */
export const TOKEN_MICRO_USD = 1_000_000 / AI_TOKENS_PER_USD;

/** wallet_debit_tokens = ceil(user_cost_usd_micro * 100 / 1e6). Never under-recovers due to fractional cents. Used for the RESERVE-time whole-token estimate; the SETTLE-time charge instead accrues via WalletDO's settle_ai_cost (see reserveAiJob/settleAiJob below). */
export function microUsdToTokens(userCostMicroUsd: number): number {
  const c = Math.max(0, Math.trunc(userCostMicroUsd));
  return Math.max(0, Math.ceil((c * AI_TOKENS_PER_USD) / 1_000_000));
}

export interface CostEstimate {
  providerCostMicroUsd: number;
  userChargeMicroUsd: number;
  tokens: number;
}

/** Full estimate pipeline: usage -> provider cost -> marked-up user charge -> wallet tokens. Pure. Used for the worst-case RESERVE estimate. */
export function estimateTokens(model: string, usage: UsageUnits): CostEstimate {
  const providerCostMicroUsd = costMicroUsd(model, usage);
  const userCostMicroUsd = userChargeMicroUsd(providerCostMicroUsd);
  return { providerCostMicroUsd, userChargeMicroUsd: userCostMicroUsd, tokens: microUsdToTokens(userCostMicroUsd) };
}

/** Settlement math: prefer the provider's OWN reported cost (OpenRouter usage.cost, in micro-USD) when present — that is ground truth over our catalog estimate (§H3 step 6 / §65). Falls back to the catalog-computed cost from actual usage when the provider didn't report one. */
export function settleTokens(model: string, usage: UsageUnits, providerCostUsdMicroOverride?: number): CostEstimate {
  const hasOverride = Number.isFinite(providerCostUsdMicroOverride) && (providerCostUsdMicroOverride as number) >= 0;
  const providerCostMicroUsd = hasOverride ? Math.trunc(providerCostUsdMicroOverride as number) : costMicroUsd(model, usage);
  const userCostMicroUsd = userChargeMicroUsd(providerCostMicroUsd);
  return { providerCostMicroUsd, userChargeMicroUsd: userCostMicroUsd, tokens: microUsdToTokens(userCostMicroUsd) };
}

/** Conservative chars/3 input-token estimator for the worst-case reserve, per the H3/integration-wave spec ("prompt chars/3 + configured max output"). */
export function estimateInputTokensFromChars(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / 3);
}

// ---------------------------------------------------------------------------
// Capability classification — safety/guardian NEVER metered (H4); free-text
// chat NEVER metered (Part I §2 / Part VIII §52/§65, [AI-WALLET-SPENDABLE-2]).
// ---------------------------------------------------------------------------

export type AiModality = "text" | "image" | "audio" | "video" | "ocr";

const SAFETY_CAPABILITIES = new Set(["safety", "safety_score", "guardian", "moderation", "content_moderation"]);

/** Guardian/safety scans must NEVER be metered — this is the single decision point every reserve call routes through. */
export function isSafetyCapability(capability: string): boolean {
  return SAFETY_CAPABILITIES.has(String(capability || "").trim().toLowerCase());
}

// [AI-WALLET-SPENDABLE-2] SHARED CONTRACT — worker/src/routes/config.ts
// imports isFreeCapability from here (`import { isFreeCapability } from
// "../lib/ai_billing"`). Do not rename FREE_CAPABILITIES / isFreeCapability.
//
// `chat_ava` = Ask Ava / AvaBrain (/api/ava/gemini). `chat_thread` = the
// #ava/@ava in-Messenger-thread agent. BOTH are free, plain-text chat lanes —
// never metered, REGARDLESS of `aiWalletMeteringEnabled`. This is the exact
// short-circuit that closes Part I §2's bug: a bonus-only wallet's `reserve()`
// used to read paid `balance` only, so EVERY free-tier chat message 402'd.
// The real, permanent fix is admitting on spendable funds (do/wallet.ts) —
// but free text chat should never even ATTEMPT a reservation, because it was
// never meant to cost the user anything in the first place.
const FREE_CAPABILITIES_SET = new Set(["chat_ava", "chat_thread"]);
export const FREE_CAPABILITIES: ReadonlySet<string> = FREE_CAPABILITIES_SET;

/** True for a capability that is free, plain-text chat and must NEVER touch pricing or the wallet — checked BEFORE isSafetyCapability's sibling checks in both reserveAiJob() and settleAiJob(), and before any config read, catalog lookup, or walletOp call. */
export function isFreeCapability(capability: string): boolean {
  return FREE_CAPABILITIES_SET.has(String(capability || "").trim().toLowerCase());
}

async function meteringOn(env: Env): Promise<boolean> {
  // Fail CLOSED into "not metered" (dark/no-op) on a config read error — a
  // billing outage must never turn into an unexpected wallet debit, and it
  // must also never turn into a false AI_INSUFFICIENT_TOKENS block.
  try { return (await readConfig(env)).aiWalletMeteringEnabled === true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// [§66 / AI-BUDGET-AUTH-1] Per-account unrecovered-cost hard cap. Admission is
// an atomic reserve inside the user's WalletDO; settle replaces the maximum
// exposure with actual loss and release removes it. KV is used only to dedupe a
// platform alert, never as a money/cap authority.
// ---------------------------------------------------------------------------

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
const UNRECOVERED_TTL_SECONDS = 2 * 24 * 60 * 60; // survives the UTC day boundary, then self-evicts

/** [§66] `unrecoveredDailyCapMicroUsd` — declared by routes/config.ts (owned by a sibling change in this same wave; see this file's HANDOFF note to the coordinator). 0/absent = no cap. Fails OPEN (cap disabled) on a config-read error — never block a job over an unrelated flag-read outage. */
async function unrecoveredCapMicroUsd(env: Env): Promise<number> {
  try { return Math.max(0, Number((await readConfig(env)).unrecoveredDailyCapMicroUsd ?? 0)); } catch { return 0; }
}
/** [§66] `unrecoveredPlatformAlertMicroUsd` — declared on `PlatformConfig` (routes/config.ts, gate finding B3 fix). 0/absent = alerting disabled. Fails OPEN (alert disabled) on a config-read error — never let a telemetry outage crash job settlement. */
async function unrecoveredPlatformAlertMicroUsd(env: Env): Promise<number> {
  try { return Math.max(0, Number((await readConfig(env)).unrecoveredPlatformAlertMicroUsd ?? 0)); } catch { return 0; }
}

/**
 * [§66 / B3 fix, Opus review gate 2026-07-25] PRE-FLIGHT CHECK ONLY — never a
 * reservation. Reads TODAY's SETTLED unrecovered-loss total for this account
 * and compares it to the cap. §66 defines `unrecoveredDailyCapMicroUsd` as a
 * bound on unrecovered PLATFORM LOSS ("once exceeded"); a healthy, fully-paid
 * job has ZERO loss and must be admitted on wallet headroom alone, no matter
 * how large its own worst-case marked-up ESTIMATE is. The previous version of
 * this function reserved `est.userChargeMicroUsd` — the marked-up worst-case
 * charge, not any actual loss — against this cap at admission time, so any
 * single job whose estimate exceeded the $0.05 production default was refused
 * outright regardless of balance. Image generation's deliberate
 * IMAGE_OUTPUT_TOKEN_RESERVE_CEILING over-reserve was the case most likely to
 * trip it. Fails OPEN (admit) on any wallet-read failure, matching every
 * other config/cap fail-open policy in this file — a telemetry/read outage
 * must never turn into a false AI_UNRECOVERED_LIMIT block.
 */
async function unrecoveredCapStatus(
  env: Env, uid: string, capMicroUsd: number,
): Promise<{ ok: boolean; day: string; used: number }> {
  const day = utcDayKey();
  if (capMicroUsd <= 0) return { ok: true, day, used: 0 };
  const r = await walletOp(env, uid, { op: "ai_unrecovered_status", uid, day }).catch(() => null);
  const used = Math.max(0, Number(r?.body?.amount_micro_usd ?? 0));
  return { ok: used < capMicroUsd, day, used };
}

/**
 * Record ACTUAL unrecovered loss for this job, atomically, in the per-account
 * daily authority (WalletDO's `ai_unrecovered_budget` table via the
 * `ai_unrecovered_settle` op — do/wallet.ts). This is the race-free
 * improvement over the old stale-counter read that B3 explicitly preserves:
 * even though admission no longer reserves a worst-case slot (see
 * unrecoveredCapStatus above), the SETTLE side still funnels every loss
 * through one per-uid-serialized DO write, so concurrent jobs' losses can
 * never race each other into an under-counted total.
 */
async function settleUnrecoveredExposure(
  env: Env, uid: string, opId: string, day: string | undefined, amountMicroUsd: number,
): Promise<void> {
  if (!day) return;
  await walletOp(env, uid, {
    op: "ai_unrecovered_settle", uid, request_id: opId, day,
    amount_micro_usd: Math.max(0, Math.trunc(amountMicroUsd)),
    op_id: `${opId}:unrecovered-settle`, app_name: "ai_billing",
  }).catch(() => {});
}

/**
 * Report an already-persisted loss and page once the durable D1 ledger's
 * platform total crosses the threshold. Per-account enforcement has already
 * settled atomically in WalletDO; this function is observability only.
 */
async function recordUnrecoveredLoss(
  env: Env, uid: string, lossMicroUsd: number,
  ctx: { opId: string; capability: string; model: string; costSource: string },
): Promise<void> {
  try {
    const day = utcDayKey();
    const account = await walletOp(env, uid, { op: "ai_unrecovered_status", uid, day });
    const acctTotal = Math.max(0, Number(account.body?.amount_micro_usd ?? lossMicroUsd));
    const start = Date.parse(`${day}T00:00:00.000Z`);
    const row = await env.DB_WALLET.prepare(
      `SELECT COALESCE(SUM(unrecovered_micro_usd),0) AS total
       FROM ai_billing_ledger WHERE created_at>=?1 AND created_at<?2`,
    ).bind(start, start + 86_400_000).first<any>();
    const platTotal = Math.max(0, Number(row?.total ?? lossMicroUsd));
    void track(env, uid, "ai_cost_unrecovered", "ai_billing", {
      loss_micro_usd: lossMicroUsd, account_total_today_micro_usd: acctTotal, platform_total_today_micro_usd: platTotal,
      op_id: ctx.opId, capability: ctx.capability, model: ctx.model, cost_source: ctx.costSource,
    });
    const alertThreshold = await unrecoveredPlatformAlertMicroUsd(env);
    const alertKey = `ai_unrecovered_alert_sent:${day}`;
    if (alertThreshold > 0 && platTotal >= alertThreshold && !(await env.TOKENS.get(alertKey))) {
      await env.TOKENS.put(alertKey, "1", { expirationTtl: UNRECOVERED_TTL_SECONDS });
      void trackException(env, new Error("AI platform unrecovered-cost daily alert threshold crossed"), {
        uid: "platform", route: "ai_billing.recordUnrecoveredLoss", handled: true,
        extra: { subsystem: "ai_unrecovered_platform_alert", platform_total_today_micro_usd: platTotal, alert_threshold_micro_usd: alertThreshold, day },
      });
    }
  } catch { /* best-effort — never throws out of a completed settle */ }
}

// ---------------------------------------------------------------------------
// AIJob lifecycle
// ---------------------------------------------------------------------------

export interface ReserveAiJobInput {
  uid: string;
  opId: string;
  capability: string;   // 'chat_ava' | 'chat_thread' | 'util' | ... (never a safety capability — see isSafetyCapability; chat_ava/chat_thread are FREE — see isFreeCapability)
  modality: AiModality;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  units?: Partial<Pick<UsageUnits, "images" | "ocrPages" | "avSeconds">>;
  email?: string | null;
  /** [VENICE-TOKENS-1] Optional flat reserve override, in TOKENS (never USD
   *  or micro-USD) — when a positive finite number is supplied, reserveAiJob
   *  skips the catalog/estimateTokens() worst-case computation below entirely
   *  and reserves exactly this many tokens (still floored at 1). Undefined
   *  (the default for every existing caller) preserves the catalog-estimate
   *  path byte-for-byte. Introduced for Venice media's flat per-action tariff
   *  (cfg.veniceImageTokens) — the caller (ai_media_jobs.ts's
   *  createAiMediaJob) decides WHEN to pass one; this function only honours it. */
  flatPriceTokens?: number;
}

export interface ReserveAiJobResult {
  ok: boolean;
  metered: boolean;
  reserved_tokens: number;
  ref: string;
  error?: string;
  needed?: number;
  balance?: number;
  /** UTC day of this job's atomic unrecovered-loss exposure reservation. */
  unrecovered_day?: string;
}

function jobTags(input: ReserveAiJobInput, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    op_id: input.opId, capability: input.capability, modality: input.modality, model: input.model,
    max_input_tokens: input.maxInputTokens, max_output_tokens: input.maxOutputTokens, ...extra,
  };
}

type CostSource = "provider" | "catalog" | "unknown" | "free" | "n/a";

interface LedgerRowInput {
  opId: string; uid: string; capability: string; modality: string;
  modelRequested: string; modelActual: string | null; usage: UsageUnits | null;
  providerCostMicro: number | null; markupRate: number; userChargeTokens: number;
  status: "reserved" | "settled" | "released" | "failed_billed" | "failed_unbilled";
  /** [AI-WALLET-SPENDABLE-2] Platform loss recorded on this row, if any — see worker/migrations/2026-07-25-ai-billing-ledger-unrecovered.sql. */
  unrecoveredMicroUsd?: number;
  /** [AI-WALLET-SPENDABLE-2 / §65] Where the CHARGED amount actually came from. */
  costSource?: CostSource;
}

/** Durable D1 write, keyed by op_id (PK) — never the balance authority, only the AI-specific billing detail + terminal status for support/reconciliation. Best-effort: a ledger write failure must never unwind an already-applied wallet mutation, so this only ever logs an exception, never throws. */
async function writeLedgerRow(env: Env, row: LedgerRowInput): Promise<void> {
  const now = Date.now();
  try {
    await env.DB_WALLET.prepare(
      `INSERT INTO ai_billing_ledger
         (op_id, uid, capability, modality, model_requested, model_actual, usage_json, provider_cost_micro, markup_rate, user_charge_tokens, status, unrecovered_micro_usd, cost_source, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)
       ON CONFLICT(op_id) DO UPDATE SET
         model_actual=excluded.model_actual, usage_json=excluded.usage_json,
         provider_cost_micro=excluded.provider_cost_micro, user_charge_tokens=excluded.user_charge_tokens,
         status=excluded.status, unrecovered_micro_usd=excluded.unrecovered_micro_usd,
         cost_source=excluded.cost_source, updated_at=excluded.updated_at`,
    ).bind(
      row.opId, row.uid, row.capability, row.modality, row.modelRequested, row.modelActual,
      row.usage ? JSON.stringify(row.usage) : null, row.providerCostMicro, row.markupRate,
      row.userChargeTokens, row.status, Math.max(0, Math.trunc(row.unrecoveredMicroUsd || 0)), row.costSource || "n/a", now,
    ).run();
  } catch (e) {
    void trackException(env, e, {
      uid: row.uid, route: "ai_billing.writeLedgerRow", method: "DB_WALLET.prepare", handled: true,
      extra: { subsystem: "ai_billing_ledger", op_id: row.opId, status: row.status },
    });
  }
}

/** [§66] Deliberately conservative RESERVE-time ceiling for image-generation
 * jobs, in "image_output" tokens per image — OpenRouter does not expose
 * tokens-per-image ahead of time (it varies by resolution and provider), so
 * this is an intentional OVER-reserve: the unused headroom is refunded
 * automatically at settle, since settle_ai_cost only ever consumes what
 * actually turns out to be due from the provider's REAL reported usage.
 * Re-tune from empirical P99 once measured; until then, erring generous is
 * the safe direction — under-reserving and eating the gap is the failure
 * mode §66 exists to close. */
const IMAGE_OUTPUT_TOKEN_RESERVE_CEILING = 4096;

/** [§55] Reservation TTL bounds. Chat/util-scale jobs resolve within one HTTP
 * request, so a short TTL bounds a crashed Worker's headroom lockout to
 * minutes, not the old blanket 6-hour window (§59c — a user WITH tokens
 * getting 402s for up to 6 hours because reserve() scheduled no alarm at
 * all). Media jobs (image/audio/video/ocr) get a longer ceiling for their
 * declared job deadline + settlement grace, capped at 60 minutes, until
 * per-job deadlines are threaded through from the caller. */
const CHAT_RESERVATION_TTL_MS = 5 * 60_000;       // 5 minutes
const MEDIA_JOB_RESERVATION_TTL_MS = 60 * 60_000; // 60 minutes (ceiling)
function reservationTtlMsFor(modality: AiModality): number {
  return modality === "text" ? CHAT_RESERVATION_TTL_MS : MEDIA_JOB_RESERVATION_TTL_MS;
}

/** Best-effort read of this account's current sub-cent debt remainder (do/wallet.ts acct.debt_micro_usd), via the `balance` op. Never throws; 0 on any failure. */
async function currentDebtMicroUsd(env: Env, uid: string): Promise<number> {
  try {
    const r = await walletOp(env, uid, { op: "balance", uid });
    return Math.max(0, Number(r.body?.debt_micro_usd ?? 0));
  } catch { return 0; }
}

/**
 * Reserve the worst-case wallet amount for one AI job, atomically, before any
 * provider call is made (§H3 steps 1-4). Idempotent on opId: a re-reserve with
 * the same opId replays the WalletDO's stored result for `${opId}:reserve`
 * rather than reserving twice (WalletDO `ops` table dedupe).
 *
 * When `aiWalletMeteringEnabled` is OFF, `capability` is a safety capability,
 * or `capability` is a FREE capability (chat_ava/chat_thread — regardless of
 * the metering flag), this ALWAYS returns {ok:true, metered:false,
 * reserved_tokens:0} — the caller should proceed to the provider call
 * unconditionally, with ZERO wallet touches.
 */
export async function reserveAiJob(env: Env, input: ReserveAiJobInput): Promise<ReserveAiJobResult> {
  const ref = `aijob:${input.opId}`;
  // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=ai_reserve is set.
  if (shouldFail(env, "ai_reserve")) throw new Error("fault_inject:ai_reserve");

  if (isSafetyCapability(input.capability)) {
    return { ok: true, metered: false, reserved_tokens: 0, ref };
  }
  // [AI-WALLET-SPENDABLE-2 / §65 / §67a] Free capabilities NEVER touch
  // pricing, metering config, or the wallet — regardless of
  // aiWalletMeteringEnabled. Checked BEFORE meteringOn() so a config-read
  // outage can never turn free chat into a blocked request.
  if (isFreeCapability(input.capability)) {
    void track(env, input.uid, "ai_job_requested", "ai_billing", jobTags(input, { metered: false, free_capability: true }));
    return { ok: true, metered: false, reserved_tokens: 0, ref };
  }

  const metered = await meteringOn(env);
  void track(env, input.uid, "ai_job_requested", "ai_billing", jobTags(input, { metered }));
  if (!metered) {
    return { ok: true, metered: false, reserved_tokens: 0, ref };
  }

  const usage: UsageUnits = {
    inputTokens: Math.max(0, Math.trunc(input.maxInputTokens || 0)),
    outputTokens: Math.max(0, Math.trunc(input.maxOutputTokens || 0)),
    ocrPages: input.units?.ocrPages, avSeconds: input.units?.avSeconds,
  };
  // [§66] Image generation is the LEAST trustworthy worst-case (OpenRouter
  // doesn't expose tokens-per-image ahead of time) — over-reserve
  // deliberately via the conservative ceiling rather than under-reserve and
  // eat the gap. The unused headroom is refunded automatically at settle.
  if (input.modality === "image" && (input.units?.images ?? 0) > 0) {
    usage.imageOutputTokens = (input.units?.images ?? 0) * IMAGE_OUTPUT_TOKEN_RESERVE_CEILING;
  } else {
    usage.images = input.units?.images;
  }
  const est = estimateTokens(input.model, usage);

  // [§66 / B3 fix] Admission is a PRE-FLIGHT CHECK against today's already-
  // SETTLED unrecovered loss for this account, never a reservation of this
  // job's own worst-case marked-up ESTIMATE. A healthy, fully-paid job has
  // ZERO settled loss and is admitted here purely on that basis; the actual
  // wallet-headroom check (which DOES look at this job's estimate, correctly)
  // happens below at the `reserve` walletOp call.
  const capMicroUsd = await unrecoveredCapMicroUsd(env);
  const capStatus = await unrecoveredCapStatus(env, input.uid, capMicroUsd);
  if (!capStatus.ok) {
    void track(env, input.uid, "ai_job_blocked_unrecovered_limit", "ai_billing", jobTags(input, {
      used_today_micro_usd: capStatus.used, cap_micro_usd: capMicroUsd,
    }));
    return {
      ok: false, metered: true, reserved_tokens: 0, ref,
      error: "AI_UNRECOVERED_LIMIT", unrecovered_day: capStatus.day,
    };
  }

  // [§59a/§60b] Reserve whole-token headroom from EXISTING debt + this job's
  // own worst-case marked-up estimate, not just this job's estimate alone — a
  // string of near-zero-cost jobs can leave up to 1 token of live debt
  // outstanding, and the NEXT reservation must have enough headroom to cover
  // both, or settle_ai_cost will under-reserve-driven under-collect it as
  // unrecovered platform loss for no reason.
  const debtMicroUsd = await currentDebtMicroUsd(env, input.uid);
  // [VENICE-TOKENS-1] Flat reserve override: a caller-supplied flat tariff
  // (Venice's cfg.veniceImageTokens today) replaces the catalog-derived
  // worst-case estimate entirely — it deliberately does NOT fold in existing
  // sub-cent debt (est.userChargeMicroUsd/debtMicroUsd above), since a flat
  // per-action price is not an estimate and must not silently grow. `est` is
  // still computed above so this branch costs nothing structurally; when
  // flatPriceTokens is absent (every pre-existing caller) this is exactly the
  // prior computation, unchanged.
  const amount = input.flatPriceTokens != null && Number.isFinite(input.flatPriceTokens) && input.flatPriceTokens > 0
    ? Math.max(1, Math.trunc(input.flatPriceTokens))
    : Math.max(1, Math.ceil((debtMicroUsd + est.userChargeMicroUsd) / TOKEN_MICRO_USD));
  const expiresAt = Date.now() + reservationTtlMsFor(input.modality);

  const reserved = await walletOp(env, input.uid, {
    op: "reserve", uid: input.uid, amount, ref, allow_free: true, op_id: `${input.opId}:reserve`,
    app_name: `ai_${input.capability}`, expires_at: expiresAt,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.reserveAiJob", method: "walletOp.reserve", handled: true, extra: { op_id: input.opId, capability: input.capability } });
    return null;
  });

  if (!reserved || reserved.status === 402 || reserved.body?.ok !== true) {
    // [B3 fix] Nothing was reserved against the unrecovered cap above (only
    // checked, never reserved), so there is nothing to release here.
    const needed = amount;
    const balance = Number(reserved?.body?.available ?? 0);
    void track(env, input.uid, "ai_job_blocked_insufficient_tokens", "ai_billing", jobTags(input, { needed, balance }));
    return {
      ok: false, metered: true, reserved_tokens: 0, ref,
      error: "AI_INSUFFICIENT_TOKENS", needed, balance, unrecovered_day: capStatus.day,
    };
  }

  const reservedTokens = Number(reserved.body?.reservedTotal ?? amount);
  void track(env, input.uid, "ai_budget_reserved", "ai_billing", jobTags(input, { reserved_tokens: reservedTokens, idempotency_key: input.opId }));
  await writeLedgerRow(env, {
    opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
    modelRequested: input.model, modelActual: null, usage, providerCostMicro: null,
    markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "reserved", costSource: "n/a",
  });
  return {
    ok: true, metered: true, reserved_tokens: reservedTokens, ref,
    unrecovered_day: capStatus.day,
  };
}

export interface SettleAiJobInput {
  opId: string;
  uid: string;
  capability: string;
  modality: AiModality;
  modelRequested: string;
  modelActual: string;
  usage: UsageUnits;
  /** Prefer this straight from the provider's own usage.cost (OpenRouter), in micro-USD, over the catalog estimate. */
  providerCostUsdMicro?: number;
  email?: string | null;
}

export interface SettleAiJobResult {
  ok: boolean;
  metered: boolean;
  charged_tokens: number;
  provider_cost_micro_usd: number;
  /** [AI-WALLET-SPENDABLE-2] acct.debt_micro_usd immediately before this settlement. */
  debt_micro_usd_before: number;
  /** [AI-WALLET-SPENDABLE-2] acct.debt_micro_usd immediately after — always in [0, TOKEN_MICRO_USD). */
  debt_micro_usd_after: number;
  /** [AI-WALLET-SPENDABLE-2 / §66] Platform loss for THIS settlement — never hidden user debt, never consumes a future top-up. */
  unrecovered_micro_usd: number;
  /** [§65] Where the charged amount came from: 'provider' (ground truth), 'catalog' (estimate), 'unknown' (neither — charged 0, AI_PRICE_UNKNOWN alerted), 'free' (a FREE_CAPABILITIES job), or 'n/a' (unmetered). */
  cost_source: CostSource;
  error?: string;
}

function jobTagsSettle(input: SettleAiJobInput, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    op_id: input.opId, capability: input.capability, modality: input.modality,
    model_requested: input.modelRequested, model_actual: input.modelActual,
    input_tokens: input.usage.inputTokens ?? 0, output_tokens: input.usage.outputTokens ?? 0, ...extra,
  };
}

/**
 * Settle a reservation against ACTUAL provider usage (§H3 steps 6-8; §65 for
 * the fail-closed-on-billing-not-availability rule): debits exactly the
 * marked-up actual cost via ONE atomic WalletDO `settle_ai_cost` call
 * (idempotent by opId via `${opId}:settle`), folding it into the running
 * sub-cent `debt_micro_usd` remainder rather than ceiling every job
 * independently, and releases whatever remains reserved back to headroom in
 * the SAME DO round trip (closing the old two-call race window between
 * consume_reserved and release_reservation). Writes the terminal ledger row.
 * Safe to call more than once for the same opId — the WalletDO dedupe makes
 * a repeat call a no-op replay, not a double charge/double debt.
 *
 * Free capabilities (chat_ava/chat_thread) and unmetered reservations return
 * immediately with ZERO wallet touches.
 */
export async function settleAiJob(env: Env, reservation: ReserveAiJobResult, input: SettleAiJobInput): Promise<SettleAiJobResult> {
  // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=ai_settle is set.
  if (shouldFail(env, "ai_settle")) throw new Error("fault_inject:ai_settle");

  // [AI-WALLET-SPENDABLE-2 / §65 / §67a] Mirrors isSafetyCapability's
  // short-circuit exactly, and works regardless of aiWalletMeteringEnabled.
  // A free capability must never consult the price catalog.
  if (isFreeCapability(input.capability)) {
    void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, { metered: false, charged_tokens: 0, free_capability: true }));
    return {
      ok: true, metered: false, charged_tokens: 0, provider_cost_micro_usd: 0,
      debt_micro_usd_before: 0, debt_micro_usd_after: 0, unrecovered_micro_usd: 0, cost_source: "free",
    };
  }
  if (!reservation.metered) {
    void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, { metered: false, charged_tokens: 0 }));
    return {
      ok: true, metered: false, charged_tokens: 0, provider_cost_micro_usd: 0,
      debt_micro_usd_before: 0, debt_micro_usd_after: 0, unrecovered_micro_usd: 0, cost_source: "n/a",
    };
  }

  // [§65] Provider usage.cost is GROUND TRUTH whenever present — no catalog
  // entry is needed for it to settle correctly. The catalog is the
  // estimator for the RESERVE, never the authority for the CHARGE. Only when
  // NEITHER a provider cost NOR a catalog entry exists do we fail the
  // *billing* (never the *answer*, never the availability).
  const model = input.modelActual || input.modelRequested;
  const hasProviderCost = Number.isFinite(input.providerCostUsdMicro) && (input.providerCostUsdMicro as number) >= 0;
  const hasCatalogEntry = Object.prototype.hasOwnProperty.call(AI_PRICE_CATALOG, String(model || "").trim());
  const costSource: CostSource = hasProviderCost ? "provider" : hasCatalogEntry ? "catalog" : "unknown";

  if (costSource === "unknown") {
    // Never bill from AI_DEFAULT_RATE, and never fail the user's
    // ALREADY-COMPLETED answer over our own bookkeeping gap (§65). Release
    // the full reservation, charge zero, alert the loss.
    await walletOp(env, input.uid, {
      op: "release_reservation", uid: input.uid, ref: reservation.ref, op_id: `${input.opId}:release`, app_name: `ai_${input.capability}`,
    }).catch((e) => {
      void trackException(env, e, { uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.release_reservation", handled: true, extra: { op_id: input.opId, capability: input.capability } });
    });
    // [B3 fix] No unrecovered-cap reservation was made at admission time, so
    // there is nothing to release here — a zero-charge AI_PRICE_UNKNOWN
    // outcome is (correctly) zero settled loss too, so no settle call either.
    void track(env, input.uid, "ai_price_unknown", "ai_billing", jobTagsSettle(input, { reserved: reservation.reserved_tokens }));
    void trackException(env, new Error("AI_PRICE_UNKNOWN: metered capability settled with no catalog entry and no provider cost"), {
      uid: input.uid, route: "ai_billing.settleAiJob", handled: true,
      extra: { subsystem: "ai_price_unknown", op_id: input.opId, capability: input.capability, model },
    });
    void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, { charged_tokens: 0, cost_source: "unknown" }));
    await writeLedgerRow(env, {
      opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
      modelRequested: input.modelRequested, modelActual: input.modelActual, usage: input.usage,
      providerCostMicro: 0, markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "settled",
      unrecoveredMicroUsd: 0, costSource: "unknown",
    });
    return {
      ok: true, metered: true, charged_tokens: 0, provider_cost_micro_usd: 0,
      debt_micro_usd_before: 0, debt_micro_usd_after: 0, unrecovered_micro_usd: 0, cost_source: "unknown",
    };
  }

  const settle = settleTokens(model, input.usage, input.providerCostUsdMicro);
  const providerCostMicroUsd = settle.providerCostMicroUsd;
  const userChargeMicroUsdAmount = settle.userChargeMicroUsd;

  const settled = await walletOp(env, input.uid, {
    op: "settle_ai_cost", uid: input.uid, ref: reservation.ref, op_id: `${input.opId}:settle`,
    app_name: `ai_${input.capability}`, capability: input.capability, actual_cost_micro_usd: userChargeMicroUsdAmount,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.settle_ai_cost", handled: true, extra: { op_id: input.opId, capability: input.capability } });
    return null;
  });

  if (!settled || settled.status !== 200 || settled.body?.ok !== true) {
    // The provider already ran but no user debit was applied: this is real
    // platform exposure, not zero. Preserve it in the hard-cap authority.
    await settleUnrecoveredExposure(
      env, input.uid, input.opId, reservation.unrecovered_day, userChargeMicroUsdAmount,
    );
    void track(env, input.uid, "ai_job_failed_unbilled", "ai_billing", jobTagsSettle(input, { reason: "settlement_failed" }));
    void trackException(env, new Error("ai_billing settlement mismatch: settle_ai_cost did not return ok"), {
      uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.settle_ai_cost", handled: true,
      extra: { op_id: input.opId, capability: input.capability },
    });
    await writeLedgerRow(env, {
      opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
      modelRequested: input.modelRequested, modelActual: input.modelActual, usage: input.usage,
      providerCostMicro: providerCostMicroUsd, markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "failed_unbilled",
      unrecoveredMicroUsd: userChargeMicroUsdAmount, costSource: costSource,
    });
    await recordUnrecoveredLoss(env, input.uid, userChargeMicroUsdAmount, {
      opId: input.opId, capability: input.capability, model, costSource,
    });
    return {
      ok: false, metered: true, charged_tokens: 0, provider_cost_micro_usd: providerCostMicroUsd,
      debt_micro_usd_before: 0, debt_micro_usd_after: 0,
      unrecovered_micro_usd: userChargeMicroUsdAmount, cost_source: costSource, error: "settlement_failed",
    };
  }

  const body = settled.body;
  const chargedTokens = Number(body?.charged_tokens ?? 0);
  const unrecoveredMicroUsd = Number(body?.unrecovered_micro_usd ?? 0);
  const debtBefore = Number(body?.debt_micro_usd_before ?? 0);
  const debtAfter = Number(body?.debt_micro_usd_after ?? 0);

  void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, {
    charged_tokens: chargedTokens, provider_cost_micro_usd: providerCostMicroUsd, markup_bps: AI_MARKUP_BPS,
    cost_source: costSource, unrecovered_micro_usd: unrecoveredMicroUsd,
  }));
  void track(env, input.uid, "ai_budget_released", "ai_billing", jobTagsSettle(input, {
    reserved: reservation.reserved_tokens, used: chargedTokens, released: Math.max(0, reservation.reserved_tokens - chargedTokens), reason: "settled",
  }));
  await writeLedgerRow(env, {
    opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
    modelRequested: input.modelRequested, modelActual: input.modelActual, usage: input.usage,
    providerCostMicro: providerCostMicroUsd, markupRate: AI_MARKUP_BPS, userChargeTokens: chargedTokens, status: "settled",
    unrecoveredMicroUsd, costSource,
  });
  // [B3 fix] Only a NON-ZERO actual loss is worth a settled-loss write — a
  // healthy job that charged in full has zero loss and must not consume a
  // write (or count toward tomorrow's totals) at all.
  if (unrecoveredMicroUsd > 0) {
    await settleUnrecoveredExposure(
      env, input.uid, input.opId, reservation.unrecovered_day, unrecoveredMicroUsd,
    );
    await recordUnrecoveredLoss(env, input.uid, unrecoveredMicroUsd, {
      opId: input.opId, capability: input.capability, model, costSource,
    });
  }
  return {
    ok: true, metered: true, charged_tokens: chargedTokens, provider_cost_micro_usd: providerCostMicroUsd,
    debt_micro_usd_before: debtBefore, debt_micro_usd_after: debtAfter, unrecovered_micro_usd: unrecoveredMicroUsd, cost_source: costSource,
  };
}

export interface ReleaseAiJobInput {
  uid: string;
  opId: string;
  capability: string;
  reason: string; // e.g. "provider_error" | "moderation_block" | "client_cancel" | "worker_timeout"
}

/**
 * Full, unbilled release of a reservation (§H4 "failed, cancelled, or
 * provider-rejected jobs release unused reservations"). No wallet debit
 * happens here — this is for jobs that produced NO billable usage at all.
 * Idempotent by opId. Free capabilities and unmetered reservations return
 * immediately with zero wallet touches (reservation.metered is already false
 * for both).
 */
export async function releaseAiJob(env: Env, reservation: ReserveAiJobResult, input: ReleaseAiJobInput): Promise<void> {
  if (!reservation.metered) return;

  await walletOp(env, input.uid, {
    op: "release_reservation", uid: input.uid, ref: reservation.ref, op_id: `${input.opId}:release-failed`, app_name: `ai_${input.capability}`,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.releaseAiJob", method: "walletOp.release_reservation", handled: true, extra: { op_id: input.opId, capability: input.capability, reason: input.reason } });
  });
  // [B3 fix] No unrecovered-cap reservation was made at admission time, so
  // there is nothing to release here — a released job produced no billable
  // usage, hence zero settled loss.

  void track(env, input.uid, "ai_budget_released", "ai_billing", {
    op_id: input.opId, capability: input.capability, reserved: reservation.reserved_tokens, used: 0,
    released: reservation.reserved_tokens, reason: input.reason,
  });
  void track(env, input.uid, "ai_job_failed_unbilled", "ai_billing", {
    op_id: input.opId, capability: input.capability, reason: input.reason,
  });
  await writeLedgerRow(env, {
    opId: input.opId, uid: input.uid, capability: input.capability, modality: "text",
    modelRequested: "", modelActual: null, usage: null, providerCostMicro: 0,
    markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "released", unrecoveredMicroUsd: 0, costSource: "n/a",
  });
}
