import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveNumberAndProfile: vi.fn(),
  metaDb: vi.fn(),
  emitRoutingDecision: vi.fn(),
  authorityQuery: vi.fn(),
  authorityEnabled: vi.fn(),
}));

vi.mock("../src/routes/config", () => ({ readConfig: mocks.readConfig }));
vi.mock("../src/routes/agent_profiles", () => ({
  resolveNumberAndProfile: mocks.resolveNumberAndProfile,
}));
vi.mock("../src/db/shard", () => ({ metaDb: mocks.metaDb }));
vi.mock("../src/lib/call_events", () => ({
  emitRoutingDecision: mocks.emitRoutingDecision,
}));
vi.mock("../src/lib/call_authority", () => ({
  authorityQuery: mocks.authorityQuery,
  authorityEnabled: mocks.authorityEnabled,
}));

import { decideRouting } from "../src/lib/call_routing";

const config = {
  businessCallUx: true,
  voicemailBot: true,
  voicemailEnabled: true,
  agentConcurrencyA: 1,
  agentConcurrencyB: 5,
  agentMaxCallSec: 3600,
  platformFeePerMin: 2,
  serviceLineFeePerMin: 3,
};

const input = {
  call_id: "call-fast",
  trace_id: "trace-fast",
  caller_id: "caller",
  callee_id: "callee",
  number_dialed: null,
  via: "dialpad",
};

function envWithBlock(blocked = false): any {
  return {
    DB_META: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => blocked ? { x: 1 } : null) })),
      })),
    },
  };
}

describe("call dialpad ring fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNumberAndProfile.mockResolvedValue({
      is_service_number: false,
      owner_uid: "callee",
      number: "",
      retired: false,
      active: true,
      agent_profile: null,
    });
    mocks.authorityEnabled.mockReturnValue(true);
    mocks.authorityQuery.mockResolvedValue({ phase: "idle" });
    mocks.emitRoutingDecision.mockResolvedValue(undefined);
    mocks.metaDb.mockImplementation(() => {
      throw new Error("ordinary human route must not touch agent concurrency");
    });
  });

  it("keeps an ordinary free human call out of agent concurrency and defers event I/O", async () => {
    const deferred: Promise<void>[] = [];
    const result = await decideRouting(envWithBlock(), input, {
      config: config as any,
      defer: (work) => deferred.push(work),
    });

    expect(result.action).toBe("ring");
    expect(result.is_service_number).toBe(false);
    expect(result.concurrency_in_use).toBe(0);
    expect(mocks.metaDb).not.toHaveBeenCalled();
    expect(mocks.authorityQuery).toHaveBeenCalledOnce();
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(mocks.emitRoutingDecision).toHaveBeenCalledOnce();
  });

  it("does not query busy authority after an offline verdict is already authoritative", async () => {
    const result = await decideRouting(envWithBlock(), { ...input, callee_reachable: false }, {
      config: config as any,
      defer: () => {},
    });

    expect(result.action).toBe("voicemail");
    expect(mocks.authorityQuery).not.toHaveBeenCalled();
    expect(mocks.metaDb).not.toHaveBeenCalled();
  });

  it("does not wake authority or concurrency for a silently blocked human call", async () => {
    const result = await decideRouting(envWithBlock(true), input, {
      config: config as any,
      defer: () => {},
    });

    expect(result.action).toBe("silent_noanswer");
    expect(mocks.authorityQuery).not.toHaveBeenCalled();
    expect(mocks.metaDb).not.toHaveBeenCalled();
  });
});

describe("ring-path telemetry lifecycle", () => {
  const api = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");

  it("keeps event writes off the response path and records the dialpad stage", () => {
    expect(api).toContain("config: cfg");
    expect(api).toContain("defer: execCtx ? (work) => execCtx.waitUntil(work) : undefined");
    expect(api).toContain('markRingStage("dialpad_routing")');
    expect(api).toContain("if (execCtx) execCtx.waitUntil(callCreatedEvent); else await callCreatedEvent");
  });

  it("flushes all PostHog stages concurrently, including silent prewarm returns", () => {
    expect(api).toContain("await Promise.allSettled(stages.map((s, index) =>");
    expect(api).toContain("delta_ms:");
    expect(api).toMatch(/markRingStage\("prewarm_started"\);\s+await settleRingPath\(\);\s+return json\(/);
    expect(api).toMatch(/markRingStage\("response_ready"\);\s+await settleRingPath\(\);/);
  });
});
