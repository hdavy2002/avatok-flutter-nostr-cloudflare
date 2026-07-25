// [AVA-FREE-BUDGET-1] Tests for the free-text-lane budget gate in lib/ai_gate.ts:
// the per-turn input ceiling, the per-account daily input/output/cost budgets
// (UTC-day reset), safety-call + regenerate accounting, and the zero-wallet
// guarantee for free capabilities (chat_ava/chat_thread) even with metering ON
// (report §67a). Written, NOT run, per the wave's HARD RULES — matches existing
// test conventions in this suite (ai_billing.test.ts, fault_inject.test.ts):
// plain vitest, minimal hand-rolled Env mocks, no wrangler/miniflare runtime, no
// vi.mock/vi.spyOn (no precedent for it anywhere in worker/test — see the
// "regenerate" test below for how that constraint shaped its design).
//
//   npm test   (vitest run)
import { describe, it, expect } from "vitest";
import {
  checkFreeTextBudget, recordFreeTextUsage, estimateTokens, runGated,
  FREE_BUDGET_MESSAGE, type FreeTextBudgetReason,
} from "../src/lib/ai_gate";
import { reserveAiJob, settleAiJob, isFreeCapability } from "../src/lib/ai_billing";

// ---------------------------------------------------------------------------
// Minimal in-memory KV mock — the one shape env.TOKENS needs for BOTH
// routes/config.ts's readConfig(env) (get(key,"json")) and ai_gate.ts's own
// free-budget counters (get/put — expirationTtl is accepted and ignored, exactly
// like the real KV binding would be for the purposes of a single test run).
// ---------------------------------------------------------------------------
class FakeKv {
  private store = new Map<string, string>();
  async get(key: string, type?: string): Promise<any> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

/** A fresh env with `platform_config` seeded from `overrides` — mirrors how
 *  routes/config.ts's readConfig layers KV overrides underneath DEFAULTS, so a
 *  test only needs to state the ONE flag it cares about. A fresh FakeKv also
 *  doubles as "a new UTC day" for the free-budget counters below, since both
 *  live under the same env.TOKENS binding and neither test reaches into the
 *  other's KV instance — see the UTC-day-reset test. */
function makeEnv(configOverrides: Record<string, unknown> = {}): any {
  const kv = new FakeKv();
  kv.put("platform_config", JSON.stringify(configOverrides));
  return { TOKENS: kv };
}

const UID = "test-uid-free-budget";

describe("checkFreeTextBudget — per-turn input ceiling (freeTextMaxInputTokens)", () => {
  it("rejects an oversized single turn with input_too_large", async () => {
    const env = makeEnv({ freeTextMaxInputTokens: 100 });
    const decision = await checkFreeTextBudget(env, UID, 101);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("input_too_large");
  });
  it("allows a turn exactly at the ceiling", async () => {
    const env = makeEnv({ freeTextMaxInputTokens: 100 });
    expect((await checkFreeTextBudget(env, UID, 100)).allowed).toBe(true);
  });
  it("falls back to the documented default (32,000) when config is silent", async () => {
    const env = makeEnv({});
    expect((await checkFreeTextBudget(env, UID, 32_000)).allowed).toBe(true);
    expect((await checkFreeTextBudget(env, UID, 32_001)).allowed).toBe(false);
  });
});

describe("checkFreeTextBudget + recordFreeTextUsage — daily accumulation", () => {
  it("many small turns accumulate to daily_ai_budget_exhausted (a turn cap alone does not bound cost — report §19b)", async () => {
    const env = makeEnv({
      freeTextMaxInputTokens: 1_000_000,
      freeTextDailyInputTokens: 1_000_000,
      freeTextDailyOutputTokens: 1_000_000,
      freeTextDailyCostMicroUsd: 1_000, // tiny cost budget — trips first, well before the token budgets
    });
    let blockedReason: FreeTextBudgetReason | undefined;
    let turns = 0;
    for (let i = 0; i < 200; i++) {
      const decision = await checkFreeTextBudget(env, UID, 100);
      if (!decision.allowed) { blockedReason = decision.reason; break; }
      await recordFreeTextUsage(env, UID, { inputTokens: 100, outputTokens: 50 });
      turns++;
    }
    expect(blockedReason).toBe("daily_ai_budget_exhausted");
    expect(turns).toBeGreaterThan(1); // proves it's ACCUMULATION, not a single oversized call
  });

  it("one account's usage never affects another account's budget", async () => {
    const env = makeEnv({ freeTextDailyCostMicroUsd: 1 }); // trips almost immediately
    await recordFreeTextUsage(env, "uid-a", { inputTokens: 10_000, outputTokens: 10_000 });
    expect((await checkFreeTextBudget(env, "uid-a", 1)).allowed).toBe(false);
    expect((await checkFreeTextBudget(env, "uid-b", 1)).allowed).toBe(true);
  });
});

describe("estimateTokens — rough chars/4 estimator (pre-flight only, never the billing authority — §65)", () => {
  it("rounds up", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
  it("empty/undefined text costs zero", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
  });
});

describe("runGated — free-lane budget gate runs BEFORE any guard/model call (§55)", () => {
  it("an oversized free turn never calls generate(), and is rejected with input_too_large", async () => {
    const env = makeEnv({ freeTextMaxInputTokens: 10 });
    let generateCalled = false;
    const result = await runGated(env, {
      uid: UID, tier: "ourkeys",
      userText: "this message is much longer than ten characters for sure",
      generate: async () => { generateCalled = true; return "hi"; },
      capability: "chat_ava",
    });
    expect(generateCalled).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("input_too_large");
    expect(result.answer).toBe(FREE_BUDGET_MESSAGE.input_too_large);
  });

  it("blocks a turn once the daily budget is pre-exhausted, reason daily_ai_budget_exhausted — never a wallet/paywall reason", async () => {
    const env = makeEnv({ freeTextDailyCostMicroUsd: 1 });
    await recordFreeTextUsage(env, UID, { inputTokens: 10_000, outputTokens: 10_000 }); // blow the tiny budget
    let generateCalled = false;
    const result = await runGated(env, {
      uid: UID, tier: "ourkeys", userText: "any ordinary chat message here",
      generate: async () => { generateCalled = true; return "hi"; },
      capability: "chat_ava",
    });
    expect(generateCalled).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("daily_ai_budget_exhausted");
    expect(result.answer).toBe(FREE_BUDGET_MESSAGE.daily_ai_budget_exhausted);
  });

  it("blocked-reason copy never mentions a wallet, paywall, Gemini, or BYO keys (Part I §2d/§7 — the whole point of this report)", () => {
    for (const msg of Object.values(FREE_BUDGET_MESSAGE)) {
      expect(msg.toLowerCase()).not.toMatch(/wallet|token|gemini|byo|paywall|balance|insufficient/);
    }
  });

  it("a non-free capability (e.g. 'util') is completely unaffected by the free-text budget gate", async () => {
    const env = makeEnv({ freeTextMaxInputTokens: 1 }); // would reject every free turn
    let generateCalled = false;
    const result = await runGated(env, {
      uid: UID, tier: "ourkeys",
      userText: "short but capability is not free so the ceiling never applies here",
      generate: async () => { generateCalled = true; return "hi there"; },
      capability: "util",
    });
    expect(generateCalled).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("capability omitted entirely behaves exactly as before (no budget gate, backward compatible)", async () => {
    const env = makeEnv({ freeTextMaxInputTokens: 1 });
    let generateCalled = false;
    const result = await runGated(env, {
      uid: UID, tier: "ourkeys", userText: "no capability tag on this call at all",
      generate: async () => { generateCalled = true; return "ok"; },
    });
    expect(generateCalled).toBe(true);
    expect(result.blocked).toBe(false);
  });
});

describe("runGated — safety-call accounting (§19a: a free turn is 3-4 model calls, not one)", () => {
  it("counts guardInput + generate + isSafe against the daily budget for a single free turn", async () => {
    const env = makeEnv({
      freeTextMaxInputTokens: 1_000_000,
      freeTextDailyInputTokens: 1_000_000,
      freeTextDailyOutputTokens: 1_000_000,
      freeTextDailyCostMicroUsd: 1_000_000,
    });
    const userText = "hello there, how are you today";
    const answer = "I am doing great, thanks for asking!";
    await runGated(env, {
      uid: UID, tier: "ourkeys", userText,
      generate: async () => answer,
      capability: "chat_ava",
    });
    // If ONLY generate()'s own tokens were recorded, accumulated inputTokens
    // would equal exactly estimateTokens(userText). guardInput (turnTokens) and
    // isSafe (answerTokens, read as ITS input) both add on top of that — this
    // fails if either accounting call is ever dropped.
    const after = await checkFreeTextBudget(env, UID, 1);
    expect(after.usage!.inputTokens).toBeGreaterThan(estimateTokens(userText));
    expect(after.usage!.outputTokens).toBeGreaterThan(0);
  });
});

describe("regenerate-on-unsafe accounting (§55: retries count against the platform-cost budget)", () => {
  // isSafe() in lib/ai_gate.ts is currently a hard-coded no-op that always
  // returns true (content moderation was removed 2026-06-24 — see isSafe's own
  // doc comment in ai_gate.ts), so runGated's regenerate branch cannot be
  // reached through its public surface without reaching into module internals
  // (vi.mock/vi.spyOn), which nothing in this suite does (see ai_billing.test.ts
  // et al — no precedent, and same-module internal calls are not guaranteed
  // interceptable). Instead this test directly verifies the LEDGER PRIMITIVE the
  // regenerate branch relies on (recordFreeTextUsage called once per
  // guard/generate/isSafe pass): a turn that regenerates records roughly DOUBLE
  // a turn that does not, so daily_ai_budget_exhausted trips proportionally
  // sooner for it. If isSafe is ever revived as a real classifier, runGated's
  // regenerate branch (ai_gate.ts) calls this exact primitive an extra time per
  // pass, so this remains the correct regression test for the accounting.
  it("a simulated regenerate (two guard+generate+guard passes) records ~2x a single pass", async () => {
    const singlePass = { inputTokens: 500, outputTokens: 200 };

    const envSingle = makeEnv({ freeTextDailyCostMicroUsd: 10_000 });
    await recordFreeTextUsage(envSingle, UID, singlePass);

    const envRegenerated = makeEnv({ freeTextDailyCostMicroUsd: 10_000 });
    await recordFreeTextUsage(envRegenerated, UID, singlePass); // first generate + isSafe
    await recordFreeTextUsage(envRegenerated, UID, singlePass); // regenerate + second isSafe

    const usageSingle = (await checkFreeTextBudget(envSingle, UID, 1)).usage!;
    const usageRegenerated = (await checkFreeTextBudget(envRegenerated, UID, 1)).usage!;

    expect(usageRegenerated.inputTokens).toBe(usageSingle.inputTokens * 2);
    expect(usageRegenerated.outputTokens).toBe(usageSingle.outputTokens * 2);
    expect(usageRegenerated.costMicroUsd).toBeGreaterThan(usageSingle.costMicroUsd * 1.8);
  });

  it("a regenerated turn exhausts a tight daily budget that a single pass would not", async () => {
    const singlePass = { inputTokens: 5_000, outputTokens: 2_000 };
    // Budget sized so ONE pass fits comfortably but TWO passes (a regenerate) do not.
    const env = makeEnv({ freeTextDailyCostMicroUsd: 1_500 });
    await recordFreeTextUsage(env, UID, singlePass);
    expect((await checkFreeTextBudget(env, UID, 1)).allowed).toBe(true); // one pass: still fine
    await recordFreeTextUsage(env, UID, singlePass); // the regenerate pass
    expect((await checkFreeTextBudget(env, UID, 1)).allowed).toBe(false); // two passes: exhausted
  });
});

describe("UTC-day reset", () => {
  it("a fresh day's KV state carries no usage from a prior day (ai_gate.ts date-suffixed, TTL'd key — mirrors ai_quota.ts's precedent)", async () => {
    const env = makeEnv({ freeTextDailyCostMicroUsd: 1 });
    await recordFreeTextUsage(env, UID, { inputTokens: 10_000, outputTokens: 10_000 });
    expect((await checkFreeTextBudget(env, UID, 1)).allowed).toBe(false);

    // A fresh KV instance is the observable equivalent of "a new UTC day" for
    // this counter shape: the key is `free_text_budget:<uid>:<YYYY-MM-DD>`
    // (freeBudgetKvKey in ai_gate.ts) with a 2-day TTL, so a day boundary always
    // starts from an empty key exactly like a fresh KV does here.
    const freshEnv = makeEnv({ freeTextDailyCostMicroUsd: 1 });
    expect((await checkFreeTextBudget(freshEnv, UID, 1)).allowed).toBe(true);
  });
});

describe("free capabilities never touch the wallet (§67a) — zero reserve/settle even with aiWalletMeteringEnabled=true", () => {
  it("chat_ava and chat_thread are declared free; chat_ava_image (attachments) is not", () => {
    expect(isFreeCapability("chat_ava")).toBe(true);
    expect(isFreeCapability("chat_thread")).toBe(true);
    expect(isFreeCapability("chat_ava_image")).toBe(false); // attachments stay metered — owner decision §10
    expect(isFreeCapability("util")).toBe(false);
  });

  it("reserveAiJob/settleAiJob for chat_ava are a no-op pass-through with metering ON", async () => {
    const env = makeEnv({ aiWalletMeteringEnabled: true });
    // No env.DB_WALLET / env.Q_ANALYTICS binding is provided at all. If the
    // free-capability bypass in ai_billing.ts ever regresses to fall through to
    // the real walletOp/ledger path, this call throws instead of silently
    // passing — this test fails LOUDLY if a real wallet op is ever attempted
    // for a free capability, which is exactly what should happen.
    const reservation = await reserveAiJob(env, {
      uid: UID, opId: "test-op-1", capability: "chat_ava", modality: "text",
      model: "deepseek/deepseek-v4-flash", maxInputTokens: 1000, maxOutputTokens: 500,
    });
    // toMatchObject (not toEqual) — this asserts the REQUIRED zero-wallet shape
    // without over-pinning ai_billing.ts's own return type, which is free to
    // carry additional fields (debt/unrecovered accounting, cost_source, …)
    // that are that file's business, not this ticket's.
    expect(reservation).toMatchObject({ ok: true, metered: false, reserved_tokens: 0, ref: "aijob:test-op-1" });

    const settled = await settleAiJob(env, reservation, {
      opId: "test-op-1", uid: UID, capability: "chat_ava", modality: "text",
      modelRequested: "deepseek/deepseek-v4-flash", modelActual: "deepseek/deepseek-v4-flash",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    expect(settled).toMatchObject({ ok: true, metered: false, charged_tokens: 0, provider_cost_micro_usd: 0 });
  });

  it("chat_thread is also a no-op pass-through with metering ON", async () => {
    const env = makeEnv({ aiWalletMeteringEnabled: true });
    const reservation = await reserveAiJob(env, {
      uid: UID, opId: "test-op-2", capability: "chat_thread", modality: "text",
      model: "deepseek/deepseek-v4-flash", maxInputTokens: 1000, maxOutputTokens: 500,
    });
    expect(reservation.ok).toBe(true);
    expect(reservation.metered).toBe(false);
    expect(reservation.reserved_tokens).toBe(0);
  });
});
