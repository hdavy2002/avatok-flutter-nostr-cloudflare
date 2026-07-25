// [AI-BUDGET-AUTH-1] Regression contract for the atomic free-chat budget.
import { describe, expect, it } from "vitest";
import {
  estimateTokens, reserveFreeTextBudget, runGated,
} from "../src/lib/ai_gate";
import { isFreeCapability, reserveAiJob, settleAiJob } from "../src/lib/ai_billing";

class FakeKv {
  private data = new Map<string, string>();
  async get(key: string, type?: string): Promise<any> {
    const raw = this.data.get(key);
    return raw == null ? null : type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> { this.data.set(key, value); }
}

type BudgetRow = {
  status: "reserved" | "settled" | "released";
  inReserved: number; outReserved: number; costReserved: number;
  inActual: number; outActual: number; costActual: number;
};

class FakeWalletAuthority {
  readonly rows = new Map<string, BudgetRow>();
  calls = 0;

  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    this.calls++;
    const b = JSON.parse(String(init?.body ?? "{}"));
    if (b.op === "ai_budget_reserve") {
      if (this.rows.has(b.request_id)) return Response.json({ ok: true, duplicate: true });
      const active = [...this.rows.values()].filter((r) => r.status !== "released");
      const turns = active.length;
      const input = active.reduce((n, r) => n + (r.status === "reserved" ? r.inReserved : r.inActual), 0);
      const output = active.reduce((n, r) => n + (r.status === "reserved" ? r.outReserved : r.outActual), 0);
      const cost = active.reduce((n, r) => n + (r.status === "reserved" ? r.costReserved : r.costActual), 0);
      const blocked =
        (b.turn_limit > 0 && turns + 1 > b.turn_limit) ||
        (b.daily_input_limit > 0 && input + b.input_tokens > b.daily_input_limit) ||
        (b.daily_output_limit > 0 && output + b.output_tokens > b.daily_output_limit) ||
        (b.daily_cost_limit > 0 && cost + b.cost_micro_usd > b.daily_cost_limit);
      if (blocked) return Response.json({ ok: false, error: "daily_ai_budget_exhausted" }, { status: 429 });
      this.rows.set(b.request_id, {
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
): { env: any; authority: FakeWalletAuthority } {
  const kv = new FakeKv();
  void kv.put("platform_config", JSON.stringify(overrides));
  const authority = new FakeWalletAuthority();
  return {
    authority,
    env: {
      TOKENS: kv,
      AI: { run: aiRun },
      AI_GATEWAY_ID: "",
      WALLET_DO: {
        idFromName: (uid: string) => uid,
        get: () => authority,
      },
      ANALYTICS: { writeDataPoint: () => {} },
    },
  };
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
});

describe("moderation and real-call accounting", () => {
  it("runs the classifier and records only provider calls that happened", async () => {
    let guardCalls = 0;
    const { env, authority } = makeEnv({}, async () => {
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
    const { env, authority } = makeEnv({}, async () => { throw new Error("guard unavailable"); });
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
    const { env } = makeEnv({}, async () => ({ response: "unsafe" }));
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
