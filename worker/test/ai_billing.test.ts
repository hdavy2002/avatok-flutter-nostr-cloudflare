// [TEST-AI-BILLING-1] Pure-function unit tests for the AI wallet-metering money
// math (worker/src/lib/ai_billing.ts). Covers §H2's formula end-to-end with the
// spec's own worked example, plus the integer-rounding edges that matter most
// for a billing system: zero usage, sub-token markup, unknown-model fallback,
// and the safety-capability exemption.
//
//   npm test   (vitest run)
import { describe, it, expect } from "vitest";
import {
  costMicroUsd,
  userChargeMicroUsd,
  microUsdToTokens,
  estimateTokens,
  settleTokens,
  rateFor,
  isSafetyCapability,
  estimateInputTokensFromChars,
  AI_PRICE_CATALOG,
  AI_DEFAULT_RATE,
  AI_MARKUP_BPS,
  AI_TOKENS_PER_USD,
} from "../src/lib/ai_billing";

describe("costMicroUsd", () => {
  it("kimi-k3, 100k in / 10k out = $0.45 provider cost (spec §H2 example)", () => {
    expect(costMicroUsd("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 })).toBe(450_000);
  });
  it("zero usage costs nothing", () => {
    expect(costMicroUsd("moonshotai/kimi-k3", {})).toBe(0);
    expect(costMicroUsd("moonshotai/kimi-k3", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
  it("negative/garbage usage is clamped to zero, never negative cost", () => {
    expect(costMicroUsd("moonshotai/kimi-k3", { inputTokens: -500, outputTokens: -1 })).toBe(0);
  });
  it("floors fractional micro-USD (never over-estimates provider cost)", () => {
    // gemini-2.5-flash-lite: inPerM = 100_000 micro-USD/1M tokens. 7 tokens -> 0.7 micro-USD -> floors to 0.
    expect(costMicroUsd("google/gemini-2.5-flash-lite", { inputTokens: 7 })).toBe(0);
  });
});

describe("userChargeMicroUsd — 30% markup, ceil", () => {
  it("kimi-k3 example: $0.45 provider -> $0.585 user charge", () => {
    expect(userChargeMicroUsd(450_000)).toBe(585_000);
  });
  it("zero cost -> zero charge", () => {
    expect(userChargeMicroUsd(0)).toBe(0);
  });
  it("ceil edge: 1 micro-USD provider cost -> ceil(1.3) = 2 micro-USD user charge", () => {
    expect(userChargeMicroUsd(1)).toBe(2);
  });
  it("negative input is clamped to zero before markup", () => {
    expect(userChargeMicroUsd(-100)).toBe(0);
  });
});

describe("microUsdToTokens — 100 tokens/USD, ceil (never under-recovers)", () => {
  it("kimi-k3 example: $0.585 user charge -> 59 tokens", () => {
    expect(microUsdToTokens(585_000)).toBe(59);
  });
  it("zero charge -> zero tokens", () => {
    expect(microUsdToTokens(0)).toBe(0);
  });
  it("ceil edge: 2 micro-USD -> ceil(0.0002) = 1 token, never 0", () => {
    expect(microUsdToTokens(2)).toBe(1);
  });
});

describe("estimateTokens — full pipeline, spec §H2 worked example", () => {
  it("kimi-k3 100k in / 10k out settles to 59 wallet tokens", () => {
    const est = estimateTokens("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 });
    expect(est).toEqual({ providerCostMicroUsd: 450_000, userChargeMicroUsd: 585_000, tokens: 59 });
  });
  it("zero usage -> zero everything", () => {
    expect(estimateTokens("moonshotai/kimi-k3", {})).toEqual({ providerCostMicroUsd: 0, userChargeMicroUsd: 0, tokens: 0 });
  });
});

describe("settleTokens — prefers the provider's own reported cost over the catalog estimate", () => {
  it("uses providerCostUsdMicroOverride when present, ignoring usage-derived catalog cost", () => {
    const settled = settleTokens("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 }, 100_000);
    // override (100_000) instead of the catalog-computed 450_000
    expect(settled.providerCostMicroUsd).toBe(100_000);
    expect(settled.userChargeMicroUsd).toBe(userChargeMicroUsd(100_000));
    expect(settled.tokens).toBe(microUsdToTokens(userChargeMicroUsd(100_000)));
  });
  it("falls back to the catalog estimate when no override is given", () => {
    const settled = settleTokens("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 });
    expect(settled).toEqual({ providerCostMicroUsd: 450_000, userChargeMicroUsd: 585_000, tokens: 59 });
  });
  it("ignores a negative override and falls back to the catalog cost", () => {
    const settled = settleTokens("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 }, -5);
    expect(settled.providerCostMicroUsd).toBe(450_000);
  });
  it("ignores a non-finite override (NaN/Infinity)", () => {
    const settled = settleTokens("moonshotai/kimi-k3", { inputTokens: 100_000, outputTokens: 10_000 }, NaN);
    expect(settled.providerCostMicroUsd).toBe(450_000);
  });
});

describe("catalog lookup", () => {
  it("known model returns its own catalog rate", () => {
    expect(rateFor("moonshotai/kimi-k3")).toBe(AI_PRICE_CATALOG["moonshotai/kimi-k3"]);
  });
  it("unknown model falls back to the conservative AI_DEFAULT_RATE", () => {
    expect(rateFor("some/unpriced-model-nobody-added")).toBe(AI_DEFAULT_RATE);
  });
  it("empty/whitespace model id also falls back to the default rate", () => {
    expect(rateFor("")).toBe(AI_DEFAULT_RATE);
    expect(rateFor("   ")).toBe(AI_DEFAULT_RATE);
  });
  it("the default rate is at least as expensive as every catalog entry (never under-charges an unpriced model)", () => {
    for (const rate of Object.values(AI_PRICE_CATALOG)) {
      expect(AI_DEFAULT_RATE.inPerM).toBeGreaterThanOrEqual(rate.inPerM);
    }
  });
});

describe("isSafetyCapability — guardian/moderation NEVER metered (H4)", () => {
  it.each(["safety", "safety_score", "guardian", "moderation", "content_moderation"])("%s is a safety capability", (cap) => {
    expect(isSafetyCapability(cap)).toBe(true);
  });
  it("is case/whitespace insensitive", () => {
    expect(isSafetyCapability("  GUARDIAN  ")).toBe(true);
    expect(isSafetyCapability("Safety_Score")).toBe(true);
  });
  it.each(["chat_ava", "util", "", "safety_scoreboard"])("%s is NOT a safety capability", (cap) => {
    expect(isSafetyCapability(cap)).toBe(false);
  });
});

describe("estimateInputTokensFromChars — conservative chars/3 estimator", () => {
  it("rounds up", () => {
    expect(estimateInputTokensFromChars(1)).toBe(1);
    expect(estimateInputTokensFromChars(3)).toBe(1);
    expect(estimateInputTokensFromChars(4)).toBe(2);
  });
  it("never negative", () => {
    expect(estimateInputTokensFromChars(-100)).toBe(0);
  });
});

describe("constants sanity", () => {
  it("markup is 130 bps (1.30x, 30% markup)", () => {
    expect(AI_MARKUP_BPS).toBe(130);
  });
  it("100 wallet tokens per USD", () => {
    expect(AI_TOKENS_PER_USD).toBe(100);
  });
});
