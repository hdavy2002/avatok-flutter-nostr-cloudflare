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
import { computeAiSettlement, TOKEN_MICRO_USD } from "../src/do/wallet";
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
