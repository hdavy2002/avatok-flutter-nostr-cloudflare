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
// generic escrow primitives (`reserve` / `consume_reserved` / `release_reservation`,
// worker/src/do/wallet.ts, tag [AVA-CAMP-B1-WALLET]), keyed by ref =
// `aijob:<opId>`. That mechanism already gives exactly what H3 asks for:
// atomic per-uid admission (balance >= amount + all other outstanding
// reservations), op_id-deduped idempotency, and a real permanent debit only at
// consume time with the untouched remainder released back to headroom. Reusing
// it means this file makes ZERO changes to wallet.ts — the reservation layer is
// additive by construction, not by promise. (worker/src/feature_pricing.ts
// already leans on the same three ops for its own reserveAiUsage/settleAiUsage/
// releaseAiUsage — this file is a parallel, flag-gated, richer-catalog contract
// for the ChatAVA + util lanes; see the doc comment added to feature_pricing.ts.)
//
// The one thing the generic WalletDO resv table does NOT carry is AI-specific
// billing detail (model requested/actual, usage breakdown, provider cost,
// markup, terminal status) — that is what the durable D1 ledger
// (worker/migrations/2026-07-24-ai-billing-ledger.sql, table
// `ai_billing_ledger`, DB_WALLET binding) is for. It is written/updated by
// op_id (PK), independent of and reconcilable against WalletDO's own audit
// trail (wallet_ledger / wallet_transactions).
//
// MATH — all money math is done in integer MICRO-USD (USD * 1e6) to avoid
// floating-point rounding drift. See costMicroUsd / userChargeMicroUsd /
// microUsdToTokens below for the three pure steps of §H2's formula:
//   provider_cost_usd = tokens * price_per_M / 1e6
//   user_cost_usd      = provider_cost_usd * 1.30            (ceil)
//   wallet_debit_tokens = user_cost_usd * 100 tokens/USD      (ceil)
//
// SAFETY — Guardian/moderation/safety-classifier capabilities NEVER go through
// this contract; reserveAiJob short-circuits to an unmetered success for them
// (isSafetyCapability), so a safety scan can never be blocked or billed by a
// wallet balance (H4).
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
  /** USD per generated image (image-generation modality), in MICRO-USD. Unset = modality not priced yet. */
  imageUnitMicroUsd?: number;
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
};

/** Conservative default for any model not in the catalog — deliberately expensive so an unpriced model never under-charges. */
export const AI_DEFAULT_RATE: ModelRate = {
  inPerM: 5 * USD, outPerM: 15 * USD, effectiveDate: "2026-07-24",
  source: "conservative default (AI_DEFAULT_RATE, worker/src/lib/ai_billing.ts)",
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
  images?: number;    // image-generation units
  ocrPages?: number;   // OCR page units
  avSeconds?: number;  // audio/video seconds
}

/** cost_micro_usd = tokens * price_per_M_micro / 1e6 (+ any priced modality units). Pure, integer-safe, floors (never over-estimates provider cost). */
export function costMicroUsd(model: string, usage: UsageUnits): number {
  const r = rateFor(model);
  const inTok = Math.max(0, Math.trunc(usage.inputTokens || 0));
  const outTok = Math.max(0, Math.trunc(usage.outputTokens || 0));
  const images = Math.max(0, Math.trunc(usage.images || 0));
  const ocrPages = Math.max(0, Math.trunc(usage.ocrPages || 0));
  const avSeconds = Math.max(0, Math.trunc(usage.avSeconds || 0));
  let total = 0;
  total += Math.floor((inTok * r.inPerM) / 1_000_000);
  total += Math.floor((outTok * r.outPerM) / 1_000_000);
  if (images && r.imageUnitMicroUsd) total += images * r.imageUnitMicroUsd;
  if (ocrPages && r.ocrPageMicroUsd) total += ocrPages * r.ocrPageMicroUsd;
  if (avSeconds && r.avSecondMicroUsd) total += avSeconds * r.avSecondMicroUsd;
  return total;
}

/** AI_MARKUP as basis-points-of-percent: 130 == 1.30x == 30% markup. Stored as an integer so ledger rows never carry a float. */
export const AI_MARKUP_BPS = 130;

/** user_cost_usd_micro = ceil(provider_cost_usd_micro * 1.30). Integer math: *130, /100, ceil. */
export function userChargeMicroUsd(providerCostMicroUsd: number): number {
  const p = Math.max(0, Math.trunc(providerCostMicroUsd));
  return Math.ceil((p * AI_MARKUP_BPS) / 100);
}

/** 1 USD = 100 wallet tokens (matches wallet.ts TOKENS_PER_USD — canonical, site-wide). */
export const AI_TOKENS_PER_USD = 100;

/** wallet_debit_tokens = ceil(user_cost_usd_micro * 100 / 1e6). Never under-recovers due to fractional cents. */
export function microUsdToTokens(userCostMicroUsd: number): number {
  const c = Math.max(0, Math.trunc(userCostMicroUsd));
  return Math.max(0, Math.ceil((c * AI_TOKENS_PER_USD) / 1_000_000));
}

export interface CostEstimate {
  providerCostMicroUsd: number;
  userChargeMicroUsd: number;
  tokens: number;
}

/** Full estimate pipeline: usage -> provider cost -> marked-up user charge -> wallet tokens. Pure. Used for BOTH the worst-case reserve estimate and the catalog-derived settle fallback. */
export function estimateTokens(model: string, usage: UsageUnits): CostEstimate {
  const providerCostMicroUsd = costMicroUsd(model, usage);
  const userCostMicroUsd = userChargeMicroUsd(providerCostMicroUsd);
  return { providerCostMicroUsd, userChargeMicroUsd: userCostMicroUsd, tokens: microUsdToTokens(userCostMicroUsd) };
}

/** Settlement math: prefer the provider's OWN reported cost (OpenRouter usage.cost, in micro-USD) when present — that is ground truth over our catalog estimate (§H3 step 6). Falls back to the catalog-computed cost from actual usage when the provider didn't report one. */
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
// Capability classification — safety/guardian NEVER metered (H4/H6).
// ---------------------------------------------------------------------------

export type AiModality = "text" | "image" | "audio" | "video" | "ocr";

const SAFETY_CAPABILITIES = new Set(["safety", "safety_score", "guardian", "moderation", "content_moderation"]);

/** Guardian/safety scans must NEVER be metered — this is the single decision point every reserve call routes through. */
export function isSafetyCapability(capability: string): boolean {
  return SAFETY_CAPABILITIES.has(String(capability || "").trim().toLowerCase());
}

async function meteringOn(env: Env): Promise<boolean> {
  // Fail CLOSED into "not metered" (dark/no-op) on a config read error — a
  // billing outage must never turn into an unexpected wallet debit, and it
  // must also never turn into a false AI_INSUFFICIENT_TOKENS block.
  try { return (await readConfig(env)).aiWalletMeteringEnabled === true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// AIJob lifecycle
// ---------------------------------------------------------------------------

export interface ReserveAiJobInput {
  uid: string;
  opId: string;
  capability: string;   // 'chat_ava' | 'util' | ... (never a safety capability — see isSafetyCapability)
  modality: AiModality;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  units?: Partial<Pick<UsageUnits, "images" | "ocrPages" | "avSeconds">>;
  email?: string | null;
}

export interface ReserveAiJobResult {
  ok: boolean;
  metered: boolean;
  reserved_tokens: number;
  ref: string;
  error?: string;
  needed?: number;
  balance?: number;
}

function jobTags(input: ReserveAiJobInput, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    op_id: input.opId, capability: input.capability, modality: input.modality, model: input.model,
    max_input_tokens: input.maxInputTokens, max_output_tokens: input.maxOutputTokens, ...extra,
  };
}

interface LedgerRowInput {
  opId: string; uid: string; capability: string; modality: string;
  modelRequested: string; modelActual: string | null; usage: UsageUnits | null;
  providerCostMicro: number | null; markupRate: number; userChargeTokens: number;
  status: "reserved" | "settled" | "released" | "failed_billed" | "failed_unbilled";
}

/** Durable D1 write, keyed by op_id (PK) — never the balance authority, only the AI-specific billing detail + terminal status for support/reconciliation. Best-effort: a ledger write failure must never unwind an already-applied wallet mutation, so this only ever logs an exception, never throws. */
async function writeLedgerRow(env: Env, row: LedgerRowInput): Promise<void> {
  const now = Date.now();
  try {
    await env.DB_WALLET.prepare(
      `INSERT INTO ai_billing_ledger
         (op_id, uid, capability, modality, model_requested, model_actual, usage_json, provider_cost_micro, markup_rate, user_charge_tokens, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
       ON CONFLICT(op_id) DO UPDATE SET
         model_actual=excluded.model_actual, usage_json=excluded.usage_json,
         provider_cost_micro=excluded.provider_cost_micro, user_charge_tokens=excluded.user_charge_tokens,
         status=excluded.status, updated_at=excluded.updated_at`,
    ).bind(
      row.opId, row.uid, row.capability, row.modality, row.modelRequested, row.modelActual,
      row.usage ? JSON.stringify(row.usage) : null, row.providerCostMicro, row.markupRate,
      row.userChargeTokens, row.status, now,
    ).run();
  } catch (e) {
    void trackException(env, e, {
      uid: row.uid, route: "ai_billing.writeLedgerRow", method: "DB_WALLET.prepare", handled: true,
      extra: { subsystem: "ai_billing_ledger", op_id: row.opId, status: row.status },
    });
  }
}

/**
 * Reserve the worst-case wallet amount for one AI job, atomically, before any
 * provider call is made (§H3 steps 1-4). Idempotent on opId: a re-reserve with
 * the same opId replays the WalletDO's stored result for `${opId}:reserve`
 * rather than reserving twice (WalletDO `ops` table dedupe).
 *
 * When `aiWalletMeteringEnabled` is OFF, or `capability` is a safety
 * capability, this ALWAYS returns {ok:true, metered:false, reserved_tokens:0}
 * — the caller should proceed to the provider call unconditionally.
 */
export async function reserveAiJob(env: Env, input: ReserveAiJobInput): Promise<ReserveAiJobResult> {
  const ref = `aijob:${input.opId}`;
  // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=ai_reserve is set.
  if (shouldFail(env, "ai_reserve")) throw new Error("fault_inject:ai_reserve");

  if (isSafetyCapability(input.capability)) {
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
    images: input.units?.images, ocrPages: input.units?.ocrPages, avSeconds: input.units?.avSeconds,
  };
  const est = estimateTokens(input.model, usage);
  const amount = Math.max(1, est.tokens);

  const reserved = await walletOp(env, input.uid, {
    op: "reserve", uid: input.uid, amount, ref, op_id: `${input.opId}:reserve`, app_name: `ai_${input.capability}`,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.reserveAiJob", method: "walletOp.reserve", handled: true, extra: { op_id: input.opId, capability: input.capability } });
    return null;
  });

  if (!reserved || reserved.status === 402 || reserved.body?.ok !== true) {
    const needed = amount;
    const balance = Number(reserved?.body?.available ?? 0);
    void track(env, input.uid, "ai_job_blocked_insufficient_tokens", "ai_billing", jobTags(input, { needed, balance }));
    return { ok: false, metered: true, reserved_tokens: 0, ref, error: "AI_INSUFFICIENT_TOKENS", needed, balance };
  }

  const reservedTokens = Number(reserved.body?.reservedTotal ?? amount);
  void track(env, input.uid, "ai_budget_reserved", "ai_billing", jobTags(input, { reserved_tokens: reservedTokens, idempotency_key: input.opId }));
  await writeLedgerRow(env, {
    opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
    modelRequested: input.model, modelActual: null, usage, providerCostMicro: null,
    markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "reserved",
  });
  return { ok: true, metered: true, reserved_tokens: reservedTokens, ref };
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
 * Settle a reservation against ACTUAL provider usage (§H3 steps 6-8): debits
 * exactly the marked-up actual cost, ONCE (idempotent by opId via WalletDO's
 * `${opId}:settle` op_id), and releases whatever remains reserved back to
 * headroom. Writes the terminal ledger row. Safe to call more than once for
 * the same opId — the WalletDO dedupe makes a repeat call a no-op replay, not
 * a double charge.
 */
export async function settleAiJob(env: Env, reservation: ReserveAiJobResult, input: SettleAiJobInput): Promise<SettleAiJobResult> {
  // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=ai_settle is set.
  if (shouldFail(env, "ai_settle")) throw new Error("fault_inject:ai_settle");
  if (!reservation.metered) {
    void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, { metered: false, charged_tokens: 0 }));
    return { ok: true, metered: false, charged_tokens: 0, provider_cost_micro_usd: 0 };
  }

  const settle = settleTokens(input.modelActual || input.modelRequested, input.usage, input.providerCostUsdMicro);
  // Never over-consume the reservation — mirrors the WalletDO's own clamp in
  // consumeReserved(), kept here too so the ledger's recorded charge can never
  // exceed what was actually reserved even if the estimate/settle math disagree.
  const consumeAmount = Math.max(0, Math.min(settle.tokens, reservation.reserved_tokens));

  // WalletDO's consume_reserved requires amount>0 (400 otherwise) — a genuine
  // zero-cost completion (e.g. empty output) must NOT be treated as a
  // settlement failure. Skip the call entirely and go straight to a full
  // release when there is nothing to charge.
  const settled = consumeAmount > 0
    ? await walletOp(env, input.uid, {
        op: "consume_reserved", uid: input.uid, ref: reservation.ref, amount: consumeAmount,
        op_id: `${input.opId}:settle`, app_name: `ai_${input.capability}`,
      }).catch((e) => {
        void trackException(env, e, { uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.consume_reserved", handled: true, extra: { op_id: input.opId, capability: input.capability } });
        return null;
      })
    : { status: 200, body: { ok: true, consumed: 0 } };

  // Always release whatever remains reserved, regardless of settle outcome —
  // reserve() never touched bal.balance, so this only frees headroom for other
  // reservations; it never refunds anything already consumed. Idempotent by opId.
  await walletOp(env, input.uid, {
    op: "release_reservation", uid: input.uid, ref: reservation.ref, op_id: `${input.opId}:release`, app_name: `ai_${input.capability}`,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.release_reservation", handled: true, extra: { op_id: input.opId, capability: input.capability } });
  });

  if (!settled || settled.status !== 200 || settled.body?.ok !== true) {
    void track(env, input.uid, "ai_job_failed_unbilled", "ai_billing", jobTagsSettle(input, { reason: "settlement_failed" }));
    void trackException(env, new Error("ai_billing settlement mismatch: consume_reserved did not return ok"), {
      uid: input.uid, route: "ai_billing.settleAiJob", method: "walletOp.consume_reserved", handled: true,
      extra: { op_id: input.opId, capability: input.capability, expected_tokens: consumeAmount },
    });
    await writeLedgerRow(env, {
      opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
      modelRequested: input.modelRequested, modelActual: input.modelActual, usage: input.usage,
      providerCostMicro: settle.providerCostMicroUsd, markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "failed_unbilled",
    });
    return { ok: false, metered: true, charged_tokens: 0, provider_cost_micro_usd: settle.providerCostMicroUsd, error: "settlement_failed" };
  }

  const chargedTokens = Number(settled.body?.consumed ?? consumeAmount);
  const released = Math.max(0, reservation.reserved_tokens - chargedTokens);
  void track(env, input.uid, "ai_job_completed", "ai_billing", jobTagsSettle(input, {
    charged_tokens: chargedTokens, provider_cost_micro_usd: settle.providerCostMicroUsd, markup_bps: AI_MARKUP_BPS,
  }));
  void track(env, input.uid, "ai_budget_released", "ai_billing", jobTagsSettle(input, {
    reserved: reservation.reserved_tokens, used: chargedTokens, released, reason: "settled",
  }));
  await writeLedgerRow(env, {
    opId: input.opId, uid: input.uid, capability: input.capability, modality: input.modality,
    modelRequested: input.modelRequested, modelActual: input.modelActual, usage: input.usage,
    providerCostMicro: settle.providerCostMicroUsd, markupRate: AI_MARKUP_BPS, userChargeTokens: chargedTokens, status: "settled",
  });
  return { ok: true, metered: true, charged_tokens: chargedTokens, provider_cost_micro_usd: settle.providerCostMicroUsd };
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
 * Idempotent by opId.
 */
export async function releaseAiJob(env: Env, reservation: ReserveAiJobResult, input: ReleaseAiJobInput): Promise<void> {
  if (!reservation.metered) return;

  await walletOp(env, input.uid, {
    op: "release_reservation", uid: input.uid, ref: reservation.ref, op_id: `${input.opId}:release-failed`, app_name: `ai_${input.capability}`,
  }).catch((e) => {
    void trackException(env, e, { uid: input.uid, route: "ai_billing.releaseAiJob", method: "walletOp.release_reservation", handled: true, extra: { op_id: input.opId, capability: input.capability, reason: input.reason } });
  });

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
    markupRate: AI_MARKUP_BPS, userChargeTokens: 0, status: "released",
  });
}
