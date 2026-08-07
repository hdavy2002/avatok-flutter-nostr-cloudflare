// [AI-BUDGET-AUTH-1] Regression contract for the atomic free-chat budget.
// [AI-BUDGET-AUTH-2] + [AI-MOD-FLAG-1] (2026-07-25 Opus gate fixes):
//   B1 — a WalletDO fault (non-2xx, non-429-exhausted) must fail OPEN, not
//        render as "you've used today's allowance".
//   B5 — content moderation ships DARK behind aiContentModerationEnabled
//        (default false), preserving the 2026-06-24 owner no-op decision.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateTokens, reserveFreeTextBudget, runGated, safetyVerdict,
} from "../src/lib/ai_gate";
import { isFreeCapability, reserveAiJob, settleAiJob } from "../src/lib/ai_billing";
import { bustConfigMemo } from "../src/routes/config";

// [AVA-CFG-CACHE-1 fix 2026-08-07] Reset the config memo between cases.
//
// `readConfig` gained a 10s module-scope memo, and `memoKey(env)` is
// `env.ENVIRONMENT_NAME ?? "prod"` — every `makeEnv()` in this file resolves to
// the SAME key "prod". So the first test's overrides were pinned and every
// later test silently read them: the concurrency case saw no daily ceiling and
// admitted all 50 requests instead of 5, which reads exactly like a budget
// enforcement failure. It is not — production has one env per isolate and the
// TTL is deliberate. The tests simply predate the memo and assumed every
// `readConfig` hit KV.
//
// Do NOT "fix" this by weakening the memo; it is a real latency win across 40+
// call sites. Any suite that builds more than one env per file needs this.
beforeEach(() => bustConfigMemo());

class FakeKv {
  private data = new Map<string, string>();
  async get(key: string, type?: string): Promise<any> {
    const raw = this.data.get(key);
    return raw == null ? null : type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> { this.data.set(key, value); }
}

type BudgetRow = {
  day: string;
  status: "reserved" | "settled" | "released";
  inReserved: number; outReserved: number; costReserved: number;
  inActual: number; outActual: number; costActual: number;
};

// Mirrors do/wallet.ts aiBudgetTotals(): buckets ALL totals by `day`, exactly
// like the real DO's `WHERE day=?1` — so a UTC-day rollover really is a fresh
// budget in this fake, not just a cosmetic label.
class FakeWalletAuthority {
  readonly rows = new Map<string, BudgetRow>();
  calls = 0;

  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    this.calls++;
    const b = JSON.parse(String(init?.body ?? "{}"));
    if (b.op === "ai_budget_reserve") {
      if (this.rows.has(b.request_id)) return Response.json({ ok: true, duplicate: true });
      const active = [...this.rows.values()].filter((r) => r.status !== "released" && r.day === b.day);
      const turns = active.length;
      const input = active.reduce((n, r) => n + (r.status === "reserved" ? r.inReserved : r.inActual), 0);
      const output = active.reduce((n, r) => n + (r.status === "reserved" ? r.outReserved : r.outActual), 0);
      const cost = active.reduce((n, r) => n + (r.status === "reserved" ? r.costReserved : r.costActual), 0);
      const blocked =
        (b.turn_limit > 0 && turns + 1 > b.turn_limit) ||
        (b.daily_input_limit > 0 && input + b.input_tokens > b.daily_input_limit) ||
        (b.daily_output_limit > 0 && output + b.output_tokens > b.daily_output_limit) ||
        (b.daily_cost_limit > 0 && cost + b.cost_micro_usd > b.daily_cost_limit);
      // Real DO verdict shape for a genuine exhaustion: { ok:false, error:"daily_ai_budget_exhausted" }, 429.
      if (blocked) return Response.json({ ok: false, error: "daily_ai_budget_exhausted" }, { status: 429 });
      this.rows.set(b.request_id, {
        day: b.day,
        status: "reserved",
        inReserved: b.input_tokens, outReserved: b.output_tokens, costReserved: b.cost_micro_usd,
        inActual: 0, outActual: 0, costActual: 0,
      });
      return Response.json({ ok: true });
    }
    const row = this.rows.get(b.request_id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    if (b.op === "ai_budget_settle" && row.status === "reserved") {
      Object.assign(row, {
        status: "settled", inActual: b.input_tokens,
        outActual: b.output_tokens, costActual: b.cost_micro_usd,
      });
    } else if (b.op === "ai_budget_release" && row.status === "reserved") {
      row.status = "released";
    }
    return Response.json({ ok: true });
  }
}

function makeEnv(
  overrides: Record<string, unknown> = {},
  aiRun: () => Promise<any> = async () => ({ response: "safe" }),
): { env: any; authority: FakeWalletAuthority; authorities: Map<string, FakeWalletAuthority> } {
  const kv = new FakeKv();
  void kv.put("platform_config", JSON.stringify(overrides));
  const authorities = new Map<string, FakeWalletAuthority>();
  const getAuthority = (uid: string): FakeWalletAuthority => {
    let a = authorities.get(uid);
    if (!a) { a = new FakeWalletAuthority(); authorities.set(uid, a); }
    return a;
  };
  const env = {
    TOKENS: kv,
    AI: { run: aiRun },
    AI_GATEWAY_ID: "",
    // Mirrors routes/wallet.ts walletStub(): env.WALLET_DO.get(env.WALLET_DO.idFromName(uid)).
    // Keying getAuthority by uid gives each account its OWN wallet DO instance,
    // exactly like production (one DO per uid) — required for the cross-account
    // isolation test below to mean anything.
    WALLET_DO: {
      idFromName: (uid: string) => uid,
      get: (id: string) => getAuthority(id),
    },
    ANALYTICS: { writeDataPoint: () => {} },
  };
  return { env, authority: getAuthority(UID), authorities };
}

const UID = "free-budget-user";

describe("atomic free-chat admission", () => {
  it("rejects a per-turn oversize before touching the authority", async () => {
    const { env, authority } = makeEnv({ freeTextMaxInputTokens: 100 });
    const r = await reserveFreeTextBudget(env, UID, 101, {
      requestId: "oversize", maxOutputTokens: 10,
    });
    expect(r).toMatchObject({ allowed: false, reason: "input_too_large" });
    expect(authority.calls).toBe(0);
  });

  it("concurrent requests cannot overrun the same daily headroom", async () => {
    const { env, authority } = makeEnv({
      freeTextMaxInputTokens: 1000,
      freeTextDailyInputTokens: 100,
      freeTextDailyOutputTokens: 10_000,
      freeTextDailyCostMicroUsd: 10_000,
      dailyAvaTurnLimit: 100,
    });
    const decisions = await Promise.all(
      Array.from({ length: 50 }, (_, i) => reserveFreeTextBudget(env, UID, 20, {
        requestId: `concurrent-${i}`, maxOutputTokens: 1,
      })),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    expect([...authority.rows.values()].filter((r) => r.status === "reserved")).toHaveLength(5);
  });

  it("a stable request id is idempotent", async () => {
    const { env, authority } = makeEnv();
    const args = { requestId: "stable-op", maxOutputTokens: 20 };
    expect((await reserveFreeTextBudget(env, UID, 10, args)).allowed).toBe(true);
    expect((await reserveFreeTextBudget(env, UID, 10, args)).allowed).toBe(true);
    expect(authority.rows.size).toBe(1);
  });

  it("admits a request that lands exactly at the daily ceiling, then blocks the very next token", async () => {
    const { env } = makeEnv({
      freeTextMaxInputTokens: 1000,
      freeTextDailyInputTokens: 100,
      freeTextDailyOutputTokens: 10_000,
      freeTextDailyCostMicroUsd: 10_000,
      dailyAvaTurnLimit: 100,
    });
    const atCeiling = await reserveFreeTextBudget(env, UID, 100, {
      requestId: "exactly-at-ceiling", maxOutputTokens: 0,
    });
    expect(atCeiling.allowed).toBe(true); // input(0) + 100 == limit(100): NOT over, must admit
    const overCeiling = await reserveFreeTextBudget(env, UID, 1, {
      requestId: "one-past-ceiling", maxOutputTokens: 0,
    });
    expect(overCeiling).toMatchObject({ allowed: false, reason: "daily_ai_budget_exhausted" });
  });

  it("resets the daily budget at UTC midnight", async () => {
    const { env } = makeEnv({
      freeTextMaxInputTokens: 1000,
      freeTextDailyInputTokens: 100,
      freeTextDailyOutputTokens: 10_000,
      freeTextDailyCostMicroUsd: 10_000,
      dailyAvaTurnLimit: 100,
    });
    try {
      vi.setSystemTime(new Date("2026-07-25T23:59:00.000Z"));
      const day1 = await reserveFreeTextBudget(env, UID, 100, { requestId: "day1-full", maxOutputTokens: 0 });
      expect(day1).toMatchObject({ allowed: true, day: "2026-07-25" });
      const day1Over = await reserveFreeTextBudget(env, UID, 1, { requestId: "day1-over", maxOutputTokens: 0 });
      expect(day1Over).toMatchObject({ allowed: false, reason: "daily_ai_budget_exhausted" });

      vi.setSystemTime(new Date("2026-07-26T00:01:00.000Z"));
      const day2 = await reserveFreeTextBudget(env, UID, 100, { requestId: "day2-fresh", maxOutputTokens: 0 });
      expect(day2).toMatchObject({ allowed: true, day: "2026-07-26" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each account's daily budget completely isolated from every other account", async () => {
    const { env, authorities } = makeEnv({
      freeTextMaxInputTokens: 1000,
      freeTextDailyInputTokens: 100,
      freeTextDailyOutputTokens: 10_000,
      freeTextDailyCostMicroUsd: 10_000,
      dailyAvaTurnLimit: 100,
    });
    const userA = "account-a";
    const userB = "account-b";
    const a1 = await reserveFreeTextBudget(env, userA, 100, { requestId: "iso-a-full", maxOutputTokens: 0 });
    expect(a1.allowed).toBe(true);
    const aOver = await reserveFreeTextBudget(env, userA, 1, { requestId: "iso-a-over", maxOutputTokens: 0 });
    expect(aOver.allowed).toBe(false); // account A is exhausted for today...

    const b1 = await reserveFreeTextBudget(env, userB, 100, { requestId: "iso-b-full", maxOutputTokens: 0 });
    expect(b1.allowed).toBe(true); // ...but account B has its own, untouched headroom
    expect(authorities.get(userA)).not.toBe(authorities.get(userB));
  });
});

describe("[AI-BUDGET-AUTH-2] a WalletDO fault never masquerades as a budget verdict (B1)", () => {
  it("fails open when the authority returns a non-2xx that is NOT the documented exhausted verdict", async () => {
    const kv = new FakeKv();
    void kv.put("platform_config", JSON.stringify({}));
    let calls = 0;
    // Simulates a DO 500 / SQLite error / validation 400 / 404 / empty body —
    // anything that is not the exact { ok:false, error:'daily_ai_budget_exhausted' }
    // / 429 shape aiBudgetReserve() returns for a genuine exhaustion.
    const faultyStub = {
      fetch: async () => {
        calls++;
        return Response.json({ error: "internal wallet fault" }, { status: 500 });
      },
    };
    const env: any = {
      TOKENS: kv,
      AI: { run: async () => ({ response: "safe" }) },
      AI_GATEWAY_ID: "",
      WALLET_DO: { idFromName: (uid: string) => uid, get: () => faultyStub },
      ANALYTICS: { writeDataPoint: () => {} },
    };
    const r = await reserveFreeTextBudget(env, UID, 10, { requestId: "authority-fault", maxOutputTokens: 20 });
    expect(r.allowed).toBe(true); // fail OPEN — a wallet fault must never read as "you've used today's allowance"
    expect(calls).toBe(1);
  });

  it("still blocks on the real 429 daily_ai_budget_exhausted verdict (no overcorrection)", async () => {
    const { env } = makeEnv({
      freeTextMaxInputTokens: 1000, freeTextDailyInputTokens: 1, dailyAvaTurnLimit: 100,
    });
    const r = await reserveFreeTextBudget(env, UID, 10, { requestId: "genuinely-exhausted", maxOutputTokens: 0 });
    expect(r).toMatchObject({ allowed: false, reason: "daily_ai_budget_exhausted" });
  });

  it("free chat stays allowed end-to-end through runGated when the budget authority errors", async () => {
    const kv = new FakeKv();
    void kv.put("platform_config", JSON.stringify({}));
    const faultyStub = { fetch: async () => Response.json({ error: "boom" }, { status: 500 }) };
    const env: any = {
      TOKENS: kv,
      AI: { run: async () => ({ response: "safe" }) },
      AI_GATEWAY_ID: "",
      WALLET_DO: { idFromName: (uid: string) => uid, get: () => faultyStub },
      ANALYTICS: { writeDataPoint: () => {} },
    };
    const r = await runGated(env, {
      uid: UID, tier: "ourkeys", userText: "Tell me something cheerful", capability: "chat_ava",
      requestId: "runGated-authority-fault", maxOutputTokens: 100,
      generate: async () => "Sure — the sky is clear today.",
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).not.toBe("daily_ai_budget_exhausted");
  });
});

describe("moderation and real-call accounting", () => {
  it("runs the classifier and records only provider calls that happened", async () => {
    let guardCalls = 0;
    const { env, authority } = makeEnv({ aiContentModerationEnabled: true }, async () => {
      guardCalls++;
      return { response: "safe" };
    });
    const user = "Tell me something cheerful";
    const answer = "The day is looking brighter.";
    const r = await runGated(env, {
      uid: UID, tier: "ourkeys", userText: user, capability: "chat_ava",
      requestId: "real-guards", maxOutputTokens: 100,
      generate: async () => answer,
    });
    expect(r.blocked).toBe(false);
    expect(guardCalls).toBe(2); // input and output; no imaginary extra call
    const row = authority.rows.get("real-guards")!;
    expect(row.status).toBe("settled");
    expect(row.inActual).toBe(
      estimateTokens(user) + estimateTokens(user) + estimateTokens(answer),
    );
  });

  it("a classifier outage fails open without charging imaginary guard calls", async () => {
    const { env, authority } = makeEnv({ aiContentModerationEnabled: true }, async () => { throw new Error("guard unavailable"); });
    const user = "Hello Ava";
    const answer = "Hello!";
    await runGated(env, {
      uid: UID, tier: "ourkeys", userText: user, capability: "chat_ava",
      requestId: "guard-outage", maxOutputTokens: 100,
      generate: async () => answer,
    });
    expect(authority.rows.get("guard-outage")!.inActual).toBe(estimateTokens(user));
  });

  it("a confident unsafe verdict blocks before generation", async () => {
    const { env } = makeEnv({ aiContentModerationEnabled: true }, async () => ({ response: "unsafe\nS1" }));
    let generated = false;
    const r = await runGated(env, {
      uid: UID, tier: "ourkeys", userText: "unsafe input", capability: "chat_ava",
      requestId: "unsafe-input", maxOutputTokens: 100,
      generate: async () => { generated = true; return "should not happen"; },
    });
    expect(r).toMatchObject({ blocked: true, reason: "input_unsafe" });
    expect(generated).toBe(false);
  });
});

describe("[AI-MOD-FLAG-1] content moderation ships dark (B5)", () => {
  it("skips the classifier entirely when aiContentModerationEnabled is false (the default)", async () => {
    let guardCalls = 0;
    const { env } = makeEnv({}, async () => {
      guardCalls++;
      return { response: "unsafe\nS1" }; // would block if the classifier ran at all
    });
    const r = await safetyVerdict(env, "anything at all");
    expect(r).toEqual({ safe: true, providerCalled: false });
    expect(guardCalls).toBe(0);
  });

  it("runs and enforces the classifier once aiContentModerationEnabled is explicitly true", async () => {
    const { env } = makeEnv({ aiContentModerationEnabled: true }, async () => ({ response: "unsafe\nS1" }));
    const r = await safetyVerdict(env, "anything at all");
    expect(r).toEqual({ safe: false, providerCalled: true });
  });

  it("does not false-positive on a stray \"unsafe\" substring in an unparseable response", async () => {
    const { env } = makeEnv({ aiContentModerationEnabled: true }, async () => ({
      response: "Echoing your prompt back: this looks unsafe to some readers, but ignore that.",
    }));
    const r = await safetyVerdict(env, "hello");
    expect(r).toEqual({ safe: true, providerCalled: true }); // unparseable != a confident "unsafe" verdict; fails open
  });
});

describe("free chat has zero billing-wallet mutations", () => {
  it("both text capabilities bypass metering even when its flag is on", async () => {
    expect(isFreeCapability("chat_ava")).toBe(true);
    expect(isFreeCapability("chat_thread")).toBe(true);
    expect(isFreeCapability("chat_ava_image")).toBe(false);
    for (const capability of ["chat_ava", "chat_thread"]) {
      const { env, authority } = makeEnv({ aiWalletMeteringEnabled: true });
      const reservation = await reserveAiJob(env, {
        uid: UID, opId: `free-${capability}`, capability, modality: "text",
        model: "deepseek/deepseek-v4-flash", maxInputTokens: 100, maxOutputTokens: 20,
      });
      const settled = await settleAiJob(env, reservation, {
        uid: UID, opId: `free-${capability}`, capability, modality: "text",
        modelRequested: "deepseek/deepseek-v4-flash",
        modelActual: "deepseek/deepseek-v4-flash",
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      expect(reservation).toMatchObject({ ok: true, metered: false, reserved_tokens: 0 });
      expect(settled).toMatchObject({ ok: true, metered: false, charged_tokens: 0 });
      expect(authority.calls).toBe(0);
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
