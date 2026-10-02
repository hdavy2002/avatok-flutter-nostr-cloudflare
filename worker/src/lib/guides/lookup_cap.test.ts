// [AUMFE-PANDIT-TRIM-1] At most MAX_TOOL_CALLS lookups per answer; past the cap the model must answer.
import { describe, it, expect } from "vitest";
import { runToolLoop, MAX_TOOL_CALLS } from "./text_chat";

describe("runToolLoop lookup cap", () => {
  it("runs at most MAX_TOOL_CALLS tools and forces a final answer", async () => {
    let ran = 0;
    const tool = { decl: { name: "t", description: "x" }, run: async () => { ran++; return { ok: true }; } };
    const finals: boolean[] = [];
    const step = async (_c: any, finalRound: boolean) => {
      finals.push(finalRound);
      if (finalRound) return { parts: [{ text: "answer" }], usage: { inTok: 1, outTok: 1 }, blocked: false } as any;
      return { parts: [{ functionCall: { name: "t", args: {} } }, { functionCall: { name: "t", args: {} } }], usage: { inTok: 1, outTok: 1 }, blocked: false } as any;
    };
    const r = await runToolLoop({ step, tools: [tool as any], ctx: {} as any, contents: [{ role: "user", parts: [{ text: "q" }] }] });
    expect(ran).toBe(MAX_TOOL_CALLS);
    expect(r.toolsUsed.length).toBe(MAX_TOOL_CALLS);
    expect(r.text).toBe("answer");
    expect(finals[finals.length - 1]).toBe(true);
  });
});
