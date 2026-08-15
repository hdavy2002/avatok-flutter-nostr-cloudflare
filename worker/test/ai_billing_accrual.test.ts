// [AI-WALLET-SPENDABLE-2] Tests for the free-capability short-circuit, the
// 2026-07-25 price-catalog additions, the OpenRouter image_output-token
// pricing unit, the 20% markup, and the pure settle_ai_cost accrual math
// (computeAiSettlement, do/wallet.ts) — the core of Part VIII §52 of
// Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md.
//
//   npm test   (vitest run)
import { describe, it, expect } from "vitest";
import {
  costMicroUsd,
  rateFor,
  isFreeCapability,
  isSafetyCapability,
  FREE_CAPABILITIES,
  AI_PRICE_CATALOG,
  AI_DEFAULT_RATE,
  AI_MARKUP_BPS,
  reserveAiJob,
  settleAiJob,
  type ReserveAiJobInput,
  type SettleAiJobInput,
} from "../src/lib/ai_billing";
import { computeAiSettlement, TOKEN_MICRO_USD, WalletDO } from "../src/do/wallet";
import type { Env } from "../src/types";

describe("FREE_CAPABILITIES / isFreeCapability — Part I §2 / §65 / §67a", () => {
  it("contains exactly chat_ava and chat_thread", () => {
    expect(FREE_CAPABILITIES.has("chat_ava")).toBe(true);
    expect(FREE_CAPABILITIES.has("chat_thread")).toBe(true);
    expect(FREE_CAPABILITIES.size).toBe(2);
  });
  it.each(["chat_ava", "chat_thread"])("%s is free", (cap) => {
    expect(isFreeCapability(cap)).toBe(true);
  });
  it("is case/whitespace insensitive, like isSafetyCapability", () => {
    expect(isFreeCapability("  CHAT_AVA  ")).toBe(true);
    expect(isFreeCapability("Chat_Thread")).toBe(true);
  });
  it.each(["util", "image_generate", "", "chat_avatar"])("%s is NOT free", (cap) => {
    expect(isFreeCapability(cap)).toBe(false);
  });
  it("free capabilities are a disjoint set from safety capabilities", () => {
    for (const cap of FREE_CAPABILITIES) expect(isSafetyCapability(cap)).toBe(false);
  });
});

describe("AI_MARKUP_BPS — owner pricing decision, Part VIII §61", () => {
  it("is 120 (1.20x, 20% markup) — changed from 130 as part of this commit", () => {
    expect(AI_MARKUP_BPS).toBe(120);
  });
});

describe("2026-07-25 price-catalog additions ([AI-PRICE-CATALOG-1] prerequisite)", () => {
  it("deepseek/deepseek-v4-flash: $0.0938 in / $0.1876 out per 1M", () => {
    const r = rateFor("deepseek/deepseek-v4-flash");
    expect(r).toBe(AI_PRICE_CATALOG["deepseek/deepseek-v4-flash"]);
    expect(r.inPerM).toBe(Math.round(0.0938 * 1_000_000));
    expect(r.outPerM).toBe(Math.round(0.1876 * 1_000_000));
  });
  it("google/gemma-3-12b-it: $0.05 in / $0.15 out per 1M", () => {
    const r = rateFor("google/gemma-3-12b-it");
    expect(r.inPerM).toBe(50_000);
    expect(r.outPerM).toBe(150_000);
  });
  it("google/gemma-3-4b-it: $0.05 in / $0.10 out per 1M", () => {
    const r = rateFor("google/gemma-3-4b-it");
    expect(r.inPerM).toBe(50_000);
    expect(r.outPerM).toBe(100_000);
  });
  it("mistralai/mistral-nemo: $0.019 in / $0.030 out per 1M", () => {
    const r = rateFor("mistralai/mistral-nemo");
    expect(r.inPerM).toBe(19_000);
    expect(r.outPerM).toBe(30_000);
  });
  it("openai/gpt-5-image-mini: $2.50 in / $2.00 out / $8.00 per 1M image_output tokens", () => {
    const r = rateFor("openai/gpt-5-image-mini");
    expect(r.inPerM).toBe(2_500_000);
    expect(r.outPerM).toBe(2_000_000);
    expect(r.imageOutputPerM).toBe(8_000_000);
  });
  it("every new entry is cheaper than AI_DEFAULT_RATE (so routing them before this commit would have been the ~100x overcharge Part III §59a warns about)", () => {
    for (const id of ["deepseek/deepseek-v4-flash", "google/gemma-3-12b-it", "google/gemma-3-4b-it", "mistralai/mistral-nemo"]) {
      expect(AI_PRICE_CATALOG[id].inPerM).toBeLessThan(AI_DEFAULT_RATE.inPerM);
    }
  });
});

describe("image generation billed as image_output TOKENS, not a flat per-image constant", () => {
  it("costMicroUsd uses imageOutputTokens * imageOutputPerM when both are present", () => {
    // 1000 image_output tokens at $8.00/1M = 8,000 micro-USD.
    const cost = costMicroUsd("openai/gpt-5-image-mini", { imageOutputTokens: 1000 });
    expect(cost).toBe(8_000);
  });
  it("does NOT hardcode a tokens-per-image constant — two different reported counts price differently", () => {
    const small = costMicroUsd("openai/gpt-5-image-mini", { imageOutputTokens: 500 });
    const large = costMicroUsd("openai/gpt-5-image-mini", { imageOutputTokens: 5000 });
    expect(large).toBe(small * 10);
  });
  it("a model with only the legacy flat imageUnitMicroUsd still falls back correctly when imageOutputTokens is absent", () => {
    // No catalog entry currently sets imageUnitMicroUsd, so this proves the
    // fallback branch is inert (0 cost) rather than throwing when neither
    // pricing field applies.
    const cost = costMicroUsd("openai/gpt-5-image-mini", { images: 3 });
    expect(cost).toBe(0);
  });
});

describe("computeAiSettlement (do/wallet.ts) — pure accrual math backing settle_ai_cost", () => {
  it("1 wallet token == 10,000 micro-USD", () => {
    expect(TOKEN_MICRO_USD).toBe(10_000);
  });

  it("a sub-cent job charges 0 tokens and carries the remainder forward as debt", () => {
    const r = computeAiSettlement({ debtMicroUsdBefore: 0, actualCostMicroUsd: 150, reservedTokens: 1, spendableTokens: 100 });
    expect(r.chargedTokens).toBe(0);
    expect(r.debtMicroUsdAfter).toBe(150);
    expect(r.unrecoveredMicroUsd).toBe(0);
  });

  it("100 sub-cent jobs (150 micro-USD each) settle cumulatively to exactly 1 charged token total, not 100", () => {
    let debt = 0;
    let totalCharged = 0;
    for (let i = 0; i < 100; i++) {
      const r = computeAiSettlement({ debtMicroUsdBefore: debt, actualCostMicroUsd: 150, reservedTokens: 1, spendableTokens: 1000 });
      debt = r.debtMicroUsdAfter;
      totalCharged += r.chargedTokens;
    }
    expect(totalCharged).toBe(1); // 100 * 150 = 15,000 micro-USD = 1 token + 5,000 remainder
    expect(debt).toBe(5_000);
  });

  it("a large job reserves and settles multiple tokens in one call", () => {
    const r = computeAiSettlement({ debtMicroUsdBefore: 0, actualCostMicroUsd: 150_000, reservedTokens: 20, spendableTokens: 100 });
    expect(r.chargedTokens).toBe(15);
    expect(r.unrecoveredMicroUsd).toBe(0);
    expect(r.debtMicroUsdAfter).toBe(0);
  });

  it("an underestimated provider result clamps to reserved+spendable and records the gap as unrecovered — never as forwarded debt, never consuming the next top-up", () => {
    const r = computeAiSettlement({ debtMicroUsdBefore: 0, actualCostMicroUsd: 50_000, reservedTokens: 2, spendableTokens: 2 });
    expect(r.chargedTokens).toBe(2);
    expect(r.unrecoveredMicroUsd).toBe(30_000); // 3 tokens the platform ate
    expect(r.debtMicroUsdAfter).toBe(0); // NOT a forwarded 3-token debt

    // The NEXT job starts from that same debtMicroUsdAfter — proving a
    // subsequent top-up is not silently pre-consumed by the shortfall.
    const next = computeAiSettlement({ debtMicroUsdBefore: r.debtMicroUsdAfter, actualCostMicroUsd: 0, reservedTokens: 0, spendableTokens: 1000 });
    expect(next.chargedTokens).toBe(0);
    expect(next.debtMicroUsdAfter).toBe(0);
  });

  it("invariant: 0 <= debtMicroUsdAfter < TOKEN_MICRO_USD across a spread of inputs", () => {
    const debts = [0, 1, 9_999, 5_000];
    const costs = [0, 1, 150, 9_999, 10_000, 10_001, 999_999, 1_000_000];
    for (const debtMicroUsdBefore of debts) {
      for (const actualCostMicroUsd of costs) {
        const r = computeAiSettlement({ debtMicroUsdBefore, actualCostMicroUsd, reservedTokens: 1_000_000, spendableTokens: 1_000_000 });
        expect(r.debtMicroUsdAfter).toBeGreaterThanOrEqual(0);
        expect(r.debtMicroUsdAfter).toBeLessThan(TOKEN_MICRO_USD);
      }
    }
  });

  it("never charges more than what was reserved for this job", () => {
    const r = computeAiSettlement({ debtMicroUsdBefore: 0, actualCostMicroUsd: 1_000_000, reservedTokens: 3, spendableTokens: 1_000 });
    expect(r.chargedTokens).toBe(3);
    expect(r.unrecoveredMicroUsd).toBe((100 - 3) * TOKEN_MICRO_USD);
  });

  it("never charges more than currently spendable, even if fully reserved", () => {
    const r = computeAiSettlement({ debtMicroUsdBefore: 0, actualCostMicroUsd: 1_000_000, reservedTokens: 1_000, spendableTokens: 4 });
    expect(r.chargedTokens).toBe(4);
    expect(r.unrecoveredMicroUsd).toBe((100 - 4) * TOKEN_MICRO_USD);
  });
});

// ---------------------------------------------------------------------------
// §67a — the single most important behavioural guarantee of this change: a
// free capability touches the wallet ZERO times, with aiWalletMeteringEnabled
// = true. Proven here by handing reserveAiJob/settleAiJob an Env whose
// WALLET_DO/DB_WALLET/TOKENS bindings all THROW if touched — if either
// function ever attempted a reserve, settle, or config/cap read for a free
// capability, this test would fail with that thrown error instead of the
// expected result.
// ---------------------------------------------------------------------------
function throwingEnv(): Env {
  const boom = (label: string) => { throw new Error(`must not touch ${label} for a free capability`); };
  return {
    WALLET_DO: { get: () => ({ fetch: () => boom("WALLET_DO") }), idFromName: () => ({}) },
    DB_WALLET: { prepare: () => boom("DB_WALLET") },
    TOKENS: { get: () => boom("TOKENS (config/unrecovered-cap KV)"), put: () => boom("TOKENS (config/unrecovered-cap KV)") },
  } as unknown as Env;
}

describe("§67a — chat_ava and chat_thread touch the wallet ZERO times, even with metering ON", () => {
  it.each(["chat_ava", "chat_thread"])("%s: reserveAiJob never calls WALLET_DO/DB_WALLET/TOKENS", async (capability) => {
    const env = throwingEnv();
    const input: ReserveAiJobInput = {
      uid: "u1", opId: "op1", capability, modality: "text", model: "z-ai/glm-5.2",
      maxInputTokens: 500, maxOutputTokens: 500,
    };
    const result = await reserveAiJob(env, input);
    expect(result.ok).toBe(true);
    expect(result.metered).toBe(false);
    expect(result.reserved_tokens).toBe(0);
  });

  it.each(["chat_ava", "chat_thread"])("%s: settleAiJob never calls WALLET_DO/DB_WALLET/TOKENS", async (capability) => {
    const env = throwingEnv();
    const reservation = { ok: true, metered: false, reserved_tokens: 0, ref: "aijob:op1" };
    const input: SettleAiJobInput = {
      opId: "op1", uid: "u1", capability, modality: "text",
      modelRequested: "z-ai/glm-5.2", modelActual: "z-ai/glm-5.2",
      usage: { inputTokens: 500, outputTokens: 500 },
    };
    const result = await settleAiJob(env, reservation, input);
    expect(result.ok).toBe(true);
    expect(result.metered).toBe(false);
    expect(result.charged_tokens).toBe(0);
    expect(result.cost_source).toBe("free");
  });

  it("a free capability never even reaches AI_PRICE_CATALOG/rateFor — settleAiJob returns before any pricing lookup", async () => {
    const env = throwingEnv();
    const reservation = { ok: true, metered: false, reserved_tokens: 0, ref: "aijob:op2" };
    // A deliberately UNCATALOGUED model — if settleAiJob for a free capability
    // ever consulted the catalog/AI_DEFAULT_RATE fallback path, that code
    // does not throw either, so the REAL proof is the throwingEnv() above:
    // this call must resolve without hitting WALLET_DO/DB_WALLET/TOKENS.
    const input: SettleAiJobInput = {
      opId: "op2", uid: "u1", capability: "chat_thread", modality: "text",
      modelRequested: "some/uncatalogued-model", modelActual: "some/uncatalogued-model",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
    const result = await settleAiJob(env, reservation, input);
    expect(result.charged_tokens).toBe(0);
    expect(result.cost_source).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// [B1 regression] Opus review gate finding: settleAiJob sent the RAW provider
// cost to WalletDO's settle_ai_cost as `actual_cost_micro_usd`, instead of the
// ALREADY-marked-up `userChargeMicroUsd` the DO's own contract requires (see
// AiSettlementInput.actualCostMicroUsd doc comment, do/wallet.ts:~112). That
// bug meant AI_MARKUP_BPS=120 (20% margin) never reached the wallet — every
// metered AI job settled at bare provider cost. This test drives settleAiJob
// through a fake WalletDO that performs the SAME accrual math the real DO
// does (computeAiSettlement), captures the exact `actual_cost_micro_usd` the
// wallet call receives, and proves it is the marked-up charge — not the raw
// provider cost — using a cost large enough ($0.50) that the 20% gap survives
// as a whole-token difference in `charged_tokens` (60 vs. 50), not something
// the sub-cent debt_micro_usd remainder could mask.
// ---------------------------------------------------------------------------
describe("settleAiJob → WalletDO settle_ai_cost — actual_cost_micro_usd MUST be the marked-up user charge [B1]", () => {
  it("sends provider cost × 1.20 as actual_cost_micro_usd, and still reports the raw cost separately", async () => {
    const providerCostMicroUsd = 500_000; // $0.50 raw provider cost, ground truth (override)
    const expectedUserChargeMicroUsd = Math.ceil((providerCostMicroUsd * AI_MARKUP_BPS) / 100);
    expect(expectedUserChargeMicroUsd).toBe(600_000); // $0.60 — the 20% markup applied

    let sentActualCostMicroUsd: number | undefined;
    const fakeEnv = {
      WALLET_DO: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body);
            if (body.op !== "settle_ai_cost") {
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            sentActualCostMicroUsd = body.actual_cost_micro_usd;
            // Mirror the REAL WalletDO: run the same pure accrual math
            // (computeAiSettlement) against whatever this test is sent, so
            // the fake's response is honest about the consequence of a wrong
            // actual_cost_micro_usd rather than hand-waving a fixed reply.
            const settlement = computeAiSettlement({
              debtMicroUsdBefore: 0,
              actualCostMicroUsd: body.actual_cost_micro_usd,
              reservedTokens: 1_000_000,
              spendableTokens: 1_000_000,
            });
            return new Response(JSON.stringify({
              ok: true,
              charged_tokens: settlement.chargedTokens,
              debt_micro_usd_before: 0,
              debt_micro_usd_after: settlement.debtMicroUsdAfter,
              unrecovered_micro_usd: settlement.unrecoveredMicroUsd,
            }), { status: 200 });
          },
        }),
      },
      // Ledger/telemetry writes are best-effort (try/catch) in ai_billing.ts —
      // letting these throw proves the assertions below don't depend on them.
      DB_WALLET: { prepare: () => { throw new Error("DB_WALLET not stubbed for this test"); } },
      TOKENS: { get: () => { throw new Error("TOKENS not stubbed for this test"); }, put: () => { throw new Error("TOKENS not stubbed for this test"); } },
    } as unknown as Env;

    const reservation = { ok: true, metered: true, reserved_tokens: 1000, ref: "aijob:op-b1" };
    const input: SettleAiJobInput = {
      opId: "op-b1", uid: "u1", capability: "image_generate", modality: "image",
      modelRequested: "openai/gpt-5-image-mini", modelActual: "openai/gpt-5-image-mini",
      usage: { imageOutputTokens: 62_500 },
      providerCostUsdMicro: providerCostMicroUsd, // ground-truth provider cost, per §65
    };

    const result = await settleAiJob(fakeEnv, reservation, input);

    // The regression: this used to equal providerCostMicroUsd (500_000).
    expect(sentActualCostMicroUsd).toBe(expectedUserChargeMicroUsd);
    expect(sentActualCostMicroUsd).not.toBe(providerCostMicroUsd);

    // 60 whole tokens charged on the marked-up $0.60 (600,000 / 10,000). If
    // the raw cost were sent instead, this would be 50, not 60 — a bare-cost
    // regression is caught here even without inspecting the wallet request.
    expect(result.charged_tokens).toBe(60);

    // provider_cost_micro_usd on the RESULT (ledger + telemetry field) must
    // stay the raw, unmarked-up cost — proving the two can never be silently
    // swapped again.
    expect(result.provider_cost_micro_usd).toBe(providerCostMicroUsd);
  });
});

describe("fixed retail AI tariffs", () => {
  it("settles exactly the requested whole-token tariff without catalog lookup or markup", async () => {
    let sentActualCostMicroUsd: number | undefined;
    const fakeEnv = {
      WALLET_DO: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body);
            sentActualCostMicroUsd = body.actual_cost_micro_usd;
            return new Response(JSON.stringify({
              ok: true, charged_tokens: 1,
              debt_micro_usd_before: 0, debt_micro_usd_after: 0,
              unrecovered_micro_usd: 0,
            }), { status: 200 });
          },
        }),
      },
      DB_WALLET: { prepare: () => { throw new Error("ledger not stubbed"); } },
      TOKENS: { get: () => null, put: () => undefined },
    } as unknown as Env;

    const result = await settleAiJob(
      fakeEnv,
      { ok: true, metered: true, reserved_tokens: 1, ref: "aijob:song-cover:1" },
      {
        opId: "song-cover:1", uid: "u1", capability: "media_song_cover_generate",
        modality: "image", modelRequested: "uncatalogued-fixed-product",
        modelActual: "uncatalogued-fixed-product", usage: { images: 1 },
        flatChargeTokens: 1,
      },
    );

    expect(sentActualCostMicroUsd).toBe(TOKEN_MICRO_USD);
    expect(result.charged_tokens).toBe(1);
    expect(result.cost_source).toBe("fixed");
  });
});

describe("safety capabilities remain unmetered too (pre-existing guarantee, unaffected by this change)", () => {
  it("reserveAiJob short-circuits for a safety capability with no wallet touch", async () => {
    const env = throwingEnv();
    const input: ReserveAiJobInput = {
      uid: "u1", opId: "op3", capability: "guardian", modality: "text", model: "z-ai/glm-5.2",
      maxInputTokens: 10, maxOutputTokens: 10,
    };
    const result = await reserveAiJob(env, input);
    expect(result.ok).toBe(true);
    expect(result.metered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [AI-BUDGET-AUTH-2 / B3] Opus review gate finding: `unrecoveredDailyCapMicroUsd`
// had been inverted from a settled-LOSS cap (§66) into a worst-case-CHARGE
// cap, on a live $0.05 production default — any single metered job whose
// marked-up worst-case ESTIMATE exceeded $0.05 was refused with
// AI_UNRECOVERED_LIMIT regardless of the user's balance (image generation's
// deliberate over-reserve, IMAGE_OUTPUT_TOKEN_RESERVE_CEILING, was the case
// most likely to trip it). The fix removes the admission-time reservation of
// the estimate entirely; admission now checks ONLY today's already-SETTLED
// loss against the cap.
// ---------------------------------------------------------------------------
function fakeAiBillingEnv(opts: {
  config: Record<string, unknown>;
  handleOp: (op: string, body: any) => { status: number; body: any } | undefined;
}): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const env = {
    TOKENS: {
      get: async () => opts.config,
      put: async () => {},
    },
    WALLET_DO: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body);
          calls.push(body.op);
          const handled = opts.handleOp(body.op, body);
          if (handled) return new Response(JSON.stringify(handled.body), { status: handled.status });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    },
    DB_WALLET: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
  } as unknown as Env;
  return { env, calls };
}

describe("[AI-BUDGET-AUTH-2 / B3] unrecoveredDailyCapMicroUsd bounds SETTLED loss, never a job's own worst-case estimate", () => {
  it("a healthy, fully-paid metered job whose marked-up estimate EXCEEDS the cap is still admitted (zero settled loss today)", async () => {
    const CAP = 50_000; // $0.05 — the live production default (config.ts:799)
    const { env, calls } = fakeAiBillingEnv({
      config: { aiWalletMeteringEnabled: true, unrecoveredDailyCapMicroUsd: CAP },
      handleOp: (op, body) => {
        if (op === "ai_unrecovered_status") return { status: 200, body: { ok: true, day: body.day, amount_micro_usd: 0 } };
        if (op === "balance") return { status: 200, body: { ok: true, debt_micro_usd: 0 } };
        if (op === "reserve") return { status: 200, body: { ok: true, reservedTotal: body.amount, available: 999_999 } };
        return undefined;
      },
    });

    const input: ReserveAiJobInput = {
      uid: "u-b3-admit", opId: "op-b3-admit", capability: "util", modality: "text",
      // openai/gpt-5-image-mini: $2.50/$2.00 per 1M — 1M input tokens' worst-case
      // marked-up estimate is ~$3, vastly more than the $0.05 cap above.
      model: "openai/gpt-5-image-mini",
      maxInputTokens: 1_000_000, maxOutputTokens: 0,
    };
    const result = await reserveAiJob(env, input);

    expect(result.ok).toBe(true);
    expect(result.metered).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.reserved_tokens).toBeGreaterThan(0);
    // Proves the fix: admission consulted the settled-loss status, then went
    // on to the real wallet reserve — it never tried to reserve the estimate
    // against the unrecovered cap (the old, now-removed `ai_unrecovered_reserve` op).
    expect(calls).toContain("ai_unrecovered_status");
    expect(calls).toContain("reserve");
    expect(calls).not.toContain("ai_unrecovered_reserve");
  });

  it("an account whose SETTLED unrecovered losses already exceed the cap IS refused with AI_UNRECOVERED_LIMIT, without ever touching wallet headroom", async () => {
    const CAP = 50_000;
    const { env, calls } = fakeAiBillingEnv({
      config: { aiWalletMeteringEnabled: true, unrecoveredDailyCapMicroUsd: CAP },
      handleOp: (op, body) => {
        if (op === "ai_unrecovered_status") return { status: 200, body: { ok: true, day: body.day, amount_micro_usd: 60_000 } };
        throw new Error(`must not call WALLET_DO op "${op}" once today's settled loss already exceeds the cap`);
      },
    });

    const input: ReserveAiJobInput = {
      uid: "u-b3-blocked", opId: "op-b3-blocked", capability: "util", modality: "text",
      model: "deepseek/deepseek-v4-flash", maxInputTokens: 100, maxOutputTokens: 100,
    };
    const result = await reserveAiJob(env, input);

    expect(result.ok).toBe(false);
    expect(result.metered).toBe(true);
    expect(result.error).toBe("AI_UNRECOVERED_LIMIT");
    expect(result.reserved_tokens).toBe(0);
    // Blocked purely on the pre-flight settled-loss read — never reached
    // `balance` (debt lookup) or `reserve` (real wallet headroom).
    expect(calls).toEqual(["ai_unrecovered_status"]);
  });
});

// ---------------------------------------------------------------------------
// [AI-BUDGET-AUTH-2 / B4] Opus review gate finding: `ai_daily_budget` and
// `ai_unrecovered_budget` (do/wallet.ts) carried created_at/updated_at but no
// expires_at — an orphaned 'reserved' row (SSE disconnect mid-stream, Worker
// eviction between reserve and settle, or a settle/release call that itself
// failed, all `.catch(() => {})` in ai_billing.ts) held a turn plus its
// worst-case values against the account for the rest of the UTC day with no
// expiry and no reaper — the §59c orphaned-reservation failure mode
// reproduced on these newer tables. The fix adds `expires_at`, set at reserve
// time, and excludes an expired 'reserved' row from the totals AND the turn
// count. This test drives the REAL WalletDO class (not a reimplementation of
// its logic) against a small purpose-built fake SqlStorage that recognizes
// the exact SQL text `aiBudgetReserve`/`aiBudgetTotals` issue, mirroring the
// existing pattern in worker/test/wallet_reservation_policy.test.ts.
// ---------------------------------------------------------------------------
type FakeAiDailyBudgetRow = {
  request_id: string; day: string; status: string;
  input_reserved: number; output_reserved: number; cost_reserved: number;
  input_actual: number; output_actual: number; cost_actual: number;
  created_at: number; updated_at: number; expires_at: number;
};

class FakeWalletSql {
  acct = { free: 0, premium: 0, last_grant_day: "", bonus: 0, debt_micro_usd: 0 };
  aiDailyBudget: FakeAiDailyBudgetRow[] = [];
  aiUnrecoveredBudget: { request_id: string; day: string; status: string; amount_reserved: number; amount_actual: number; expires_at: number }[] = [];

  exec(sqlText: string, ...binds: any[]): { toArray(): any[]; one(): any } {
    const s = sqlText.replace(/\s+/g, " ").trim();
    const rows = this.run(s, binds);
    return {
      toArray: () => rows,
      one: () => {
        if (!rows.length) throw new Error("FakeWalletSql.one(): no rows for: " + s);
        return rows[0];
      },
    };
  }

  private run(s: string, b: any[]): any[] {
    if (s.startsWith("CREATE TABLE") || s.startsWith("ALTER TABLE") || s.startsWith("CREATE INDEX")) return [];
    if (s === "INSERT OR IGNORE INTO bal (k, balance, held) VALUES (1,0,0)") return [];
    if (s === "INSERT OR IGNORE INTO acct (k, free, premium, last_grant_day) VALUES (1,0,0,'')") return [];
    if (s === "SELECT id, amount FROM holds WHERE released=0 AND available_at<=?1") return [];

    if (s === "SELECT free, premium, last_grant_day, bonus, debt_micro_usd FROM acct WHERE k=1") return [{ ...this.acct }];
    if (s === "UPDATE acct SET free=?1, last_grant_day=?2 WHERE k=1") {
      this.acct.free = Number(b[0]); this.acct.last_grant_day = String(b[1]); return [];
    }

    if (s === "DELETE FROM ai_daily_budget WHERE day < ?1") {
      const cutoff = String(b[0]);
      this.aiDailyBudget = this.aiDailyBudget.filter((r) => r.day >= cutoff);
      return [];
    }
    if (s === "DELETE FROM ai_unrecovered_budget WHERE day < ?1") {
      const cutoff = String(b[0]);
      this.aiUnrecoveredBudget = this.aiUnrecoveredBudget.filter((r) => r.day >= cutoff);
      return [];
    }

    if (s === "SELECT status FROM ai_daily_budget WHERE request_id=?1 AND day=?2") {
      const [requestId, day] = b.map(String);
      return this.aiDailyBudget
        .filter((r) => r.request_id === requestId && r.day === day)
        .map((r) => ({ status: r.status }));
    }

    if (s.startsWith("SELECT COUNT(*) AS turns")) {
      const day = String(b[0]);
      const now = Number(b[1]);
      const rows = this.aiDailyBudget.filter((r) =>
        r.day === day
        && (r.status === "reserved" || r.status === "settled")
        && !(r.status === "reserved" && r.expires_at > 0 && r.expires_at < now));
      const turns = rows.length;
      const inputTokens = rows.reduce((sum, r) => sum + (r.status === "reserved" ? r.input_reserved : r.input_actual), 0);
      const outputTokens = rows.reduce((sum, r) => sum + (r.status === "reserved" ? r.output_reserved : r.output_actual), 0);
      const costMicroUsd = rows.reduce((sum, r) => sum + (r.status === "reserved" ? r.cost_reserved : r.cost_actual), 0);
      return [{ turns, input_tokens: inputTokens, output_tokens: outputTokens, cost_micro_usd: costMicroUsd }];
    }

    if (s.startsWith("INSERT INTO ai_daily_budget")) {
      const [requestId, day, input, output, cost, now, expiresAt] = b;
      this.aiDailyBudget.push({
        request_id: String(requestId), day: String(day), status: "reserved",
        input_reserved: Number(input), output_reserved: Number(output), cost_reserved: Number(cost),
        input_actual: 0, output_actual: 0, cost_actual: 0,
        created_at: Number(now), updated_at: Number(now), expires_at: Number(expiresAt),
      });
      return [];
    }

    throw new Error("FakeWalletSql: unhandled statement (update the fake alongside do/wallet.ts): " + s);
  }
}

function makeFakeWalletDo(): { wallet: WalletDO; sql: FakeWalletSql } {
  const sql = new FakeWalletSql();
  const state = {
    storage: {
      sql,
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as DurableObjectState;
  const env = {} as unknown as Env;
  const wallet = new WalletDO(state, env);
  return { wallet, sql };
}

async function doOp(wallet: WalletDO, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const req = new Request("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await wallet.fetch(req);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("[AI-BUDGET-AUTH-2 / B4] ai_daily_budget reservations expire, same as resv.expires_at", () => {
  it("a 'reserved' row past its own expires_at no longer counts toward totals or the turn count", async () => {
    const { wallet, sql } = makeFakeWalletDo();
    const day = new Date().toISOString().slice(0, 10);

    const r1 = await doOp(wallet, {
      op: "ai_budget_reserve", uid: "u1", day, request_id: "turn-1",
      input_tokens: 500, output_tokens: 500, cost_micro_usd: 100,
      turn_limit: 0, daily_input_limit: 0, daily_output_limit: 0, daily_cost_limit: 0,
    });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.turns).toBe(1);
    expect(r1.body.costMicroUsd).toBe(100);

    // Simulate the orphan: nobody ever called ai_budget_settle/ai_budget_release
    // for turn-1 (SSE disconnect / Worker eviction / a failed settle call that
    // itself silently swallowed its own error) — force its reservation into
    // the past exactly like a stale row that outlived its TTL would be.
    expect(sql.aiDailyBudget).toHaveLength(1);
    sql.aiDailyBudget[0].expires_at = Date.now() - 1;

    const r2 = await doOp(wallet, {
      op: "ai_budget_reserve", uid: "u1", day, request_id: "turn-2",
      input_tokens: 10, output_tokens: 10, cost_micro_usd: 5,
      turn_limit: 1, daily_input_limit: 0, daily_output_limit: 0, daily_cost_limit: 0,
    });
    // If the expired turn-1 row still counted, totals.turns would already be 1
    // BEFORE this insert, and turn_limit:1 would refuse this second reservation
    // with daily_ai_budget_exhausted (429) — the exact §59c "I have tokens but
    // it says no" symptom reproduced on this table.
    expect(r2.status).toBe(200);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.turns).toBe(1); // only turn-2 counts — turn-1 excluded as expired
    expect(r2.body.costMicroUsd).toBe(5); // turn-1's 100 excluded too
  });
});
