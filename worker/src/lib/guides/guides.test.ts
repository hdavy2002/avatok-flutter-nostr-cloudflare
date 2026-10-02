// [AUMFE-GUIDE-BRAIN-1] Pure parts of the guide brain: tool loop (fake model), card mapping, chart needs, access rule, SSE/facts parsing.
import { describe, expect, it, vi } from "vitest";

const searchCatalog = vi.fn();
const searchTradition = vi.fn();
vi.mock("../knowledge", () => ({ searchCatalog: (...a: unknown[]) => searchCatalog(...a), searchTradition: (...a: unknown[]) => searchTradition(...a) }));

import { GUIDE_RULES, chartNeeds, compactItem, grahaKey, sharedGuideTools, toGuideCard, voiceCardOf } from "./brain";
import { canUsePandit } from "./access";
import { chartFromToolOutputs } from "./chart";
import { PANDIT } from "./personas";
import { applySseLine, boundResult, parseFacts, runToolLoop, type Content, type ModelStep, type Part } from "./text_chat";
import { toWire } from "./store";
import type { GuideToolCtx } from "./types";
import type { VoiceTool } from "../voice_agents/types";

const hit = (o: Record<string, unknown> = {}) => ({
  subject_kind: "shop_product", subject_id: "p1", title: "Hanuman tee", price_inr: 799, image_url: "https://x/i.jpg", url: "https://x/shop/p/p1",
  wear_days: ["tuesday"], deity: "hanuman", chakra: "solar plexus", tradition_note: "Hanuman is worshipped on Tuesdays.",
  why: [{ step: "deity", fact: "Hanuman on the design" }, { step: "chakra", fact: "Manipura yellow" }], score: 0.9, ...o,
});

const ctxOf = (cards: unknown[] = [], voice: unknown[] = []): GuideToolCtx =>
  ({ env: {} as any, uid: "u1", sessionId: "c1", agentId: "pandit", showGuideCard: (c) => cards.push(c), showCard: (c) => voice.push(c) });
const tool = (n: string) => sharedGuideTools().find((t) => t.decl.name === n)!;

describe("access", () => {
  it("open when enabled, else admin uids only", () => {
    expect(canUsePandit(true, "u1", "")).toBe(true);
    expect(canUsePandit(false, "u1", "u2, u1")).toBe(true);
    expect(canUsePandit(false, "u3", "u2,u1")).toBe(false);
    expect(canUsePandit(true, "", "")).toBe(false);
  });
});

describe("card mapping", () => {
  it("maps a catalog hit to the contract Card", () => {
    const c = toGuideCard(hit() as any);
    expect(Object.keys(c).sort()).toEqual(["chakra", "deity", "image_url", "kind", "price_inr", "subject_id", "title", "tradition_note", "url", "wear_days", "why"]);
    expect(c.kind).toBe("product");
    expect(toGuideCard(hit({ subject_kind: "event" }) as any).kind).toBe("puja");
    expect(c.why).toEqual([{ step: "deity", fact: "Hanuman on the design" }, { step: "chakra", fact: "Manipura yellow" }]);
  });
  it("voice card and compact item stay small", () => {
    const c = toGuideCard(hit({ tradition_note: "x".repeat(900) }) as any);
    expect(JSON.stringify(compactItem(c)).length).toBeLessThan(1200);
    expect(voiceCardOf(c).items.map((i) => i.label)).toEqual(["Price", "Deity", "Wear on"]);
  });
});

describe("shared tools", () => {
  it("one definition: names, no uid params, rules text", () => {
    const names = sharedGuideTools().map((t) => t.decl.name);
    expect(names).toEqual(expect.arrayContaining(["get_my_chart", "check_doshas", "search_catalog", "search_tradition", "recommend_for_chart"]));
    expect(new Set(names).size).toBe(names.length);
    for (const t of sharedGuideTools()) expect(Object.keys((t.decl.parameters as any)?.properties ?? {})).not.toContain("uid");
    expect(GUIDE_RULES).toMatch(/never promise/i);
    expect(PANDIT.systemPrompt()).toContain(GUIDE_RULES);
    expect(PANDIT.id).toBe("pandit"); expect(PANDIT.channel).toBe("text");
  });
  it("search_catalog returns <=3 items and emits cards on both channels", async () => {
    searchCatalog.mockResolvedValueOnce([hit(), hit({ subject_id: "p2" }), hit({ subject_id: "p3" }), hit({ subject_id: "p4" })]);
    const cards: unknown[] = [], voice: unknown[] = [];
    const r: any = await tool("search_catalog").run(ctxOf(cards, voice), { query: "hanuman", kind: "product" });
    expect(r.items).toHaveLength(3);
    expect(cards).toHaveLength(3); expect(voice).toHaveLength(3);
    expect(searchCatalog.mock.calls[0][1].filters.kind).toBe("shop_product");
  });
  it("search_catalog says so when nothing matches (no invented items)", async () => {
    searchCatalog.mockResolvedValueOnce([]);
    const cards: unknown[] = [];
    const r: any = await tool("search_catalog").run(ctxOf(cards), { query: "zzz" });
    expect(r.items).toEqual([]); expect(cards).toHaveLength(0);
  });
  it("search_tradition returns <=4 passages with source", async () => {
    searchTradition.mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: "T", text: "body", source: "Skanda Purana", topic: "deity", score: 1 })));
    const r: any = await tool("search_tradition").run(ctxOf(), { query: "tuesday hanuman" });
    expect(r.passages).toHaveLength(4); expect(r.passages[0].source).toBe("Skanda Purana");
  });
});

describe("chart needs", () => {
  it("orders dasha lords first, adds doshas, dedupes, max 3", () => {
    const n = chartNeeds({ mahadasha: "Saturn", antardasha: "Rahu" }, { manglik: true, sadhesati: true });
    expect(n.map((x) => x.graha)).toEqual(["saturn", "rahu", "mars"]);
  });
  it("unknown planet names are ignored", () => {
    expect(grahaKey("Shani")).toBe("saturn");
    expect(chartNeeds({ mahadasha: "??" }, {})).toEqual([]);
  });
  it("chart summary from tool outputs; null when the chart failed", () => {
    expect(chartFromToolOutputs({ error: "astro_unavailable" }, {}, {})).toBeNull();
    const c = chartFromToolOutputs({ lagna: "Leo", rashi: "Cancer", nakshatra: "Pushya" }, { mahadasha: "Venus", antardasha: "Sun" },
      { approximate: false, manglik: { present: true }, kalsarpa: { present: false }, sadhesati: { running: true } });
    expect(c).toEqual({ lagna: "Leo", moon_sign: "Cancer", nakshatra: "Pushya", dasha: "Venus / Sun", doshas: ["Manglik", "Sade Sati"] });
  });
});

describe("runToolLoop with a fake model", () => {
  const callPart = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });
  const mk = (steps: ModelStep[]) => {
    const seen: { contents: number; final: boolean }[] = [];
    let i = 0;
    return { seen, step: async (c: Content[], final: boolean) => { seen.push({ contents: c.length, final }); return steps[Math.min(i++, steps.length - 1)]; } };
  };
  const u = { inTok: 10, outTok: 5 };
  const echo: VoiceTool = { decl: { name: "echo", description: "" }, run: async (_c, a) => ({ got: a.v }) };

  it("plain answer: one step, no tools", async () => {
    const m = mk([{ parts: [{ text: "Namaste" }], usage: u, blocked: false }]);
    const r = await runToolLoop({ step: m.step, tools: [echo], ctx: ctxOf(), contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(r.text).toBe("Namaste"); expect(r.rounds).toBe(0); expect(r.toolsUsed).toEqual([]);
  });
  it("tool round: runs the tool, echoes model parts, sums usage", async () => {
    const m = mk([{ parts: [callPart("echo", { v: 7 })], usage: u, blocked: false }, { parts: [{ text: "Done" }], usage: u, blocked: false }]);
    const contents: Content[] = [{ role: "user", parts: [{ text: "hi" }] }];
    const names: string[] = [];
    const r = await runToolLoop({ step: m.step, tools: [echo], ctx: ctxOf(), contents, onTool: (n) => names.push(n) });
    expect(r.text).toBe("Done"); expect(r.rounds).toBe(1); expect(r.usage).toEqual({ inTok: 20, outTok: 10 }); expect(names).toEqual(["echo"]);
    expect(contents).toHaveLength(3);
    expect((contents[2].parts[0] as any).functionResponse.response.result).toEqual({ got: 7 });
  });
  it("unknown tool and a throwing tool become error results, the loop continues", async () => {
    const boom: VoiceTool = { decl: { name: "boom", description: "" }, run: async () => { throw new Error("x"); } };
    const m = mk([{ parts: [callPart("nope"), callPart("boom")], usage: u, blocked: false }, { parts: [{ text: "ok" }], usage: u, blocked: false }]);
    const contents: Content[] = [{ role: "user", parts: [{ text: "hi" }] }];
    const errs: string[] = [];
    const r = await runToolLoop({ step: m.step, tools: [boom], ctx: ctxOf(), contents, onToolError: (n) => errs.push(n) });
    expect(r.text).toBe("ok"); expect(errs).toEqual(["boom"]);
    const res = contents[2].parts.map((p: any) => p.functionResponse.response.result);
    expect(res).toEqual([{ error: "unknown_tool" }, { error: "tool_failed" }]);
  });
  it("last round is made with calls disabled and never loops past maxRounds", async () => {
    const m = mk([{ parts: [callPart("echo")], usage: u, blocked: false }]);
    const r = await runToolLoop({ step: m.step, tools: [echo], ctx: ctxOf(), contents: [{ role: "user", parts: [{ text: "x" }] }], maxRounds: 2 });
    expect(m.seen.map((s) => s.final)).toEqual([false, false, true]); expect(r.rounds).toBe(2);
  });
  it("ignores thought parts and carries the blocked flag", async () => {
    const m = mk([{ parts: [{ text: "hidden", thought: true }, { text: "shown" }], usage: u, blocked: true }]);
    const r = await runToolLoop({ step: m.step, tools: [], ctx: ctxOf(), contents: [] });
    expect(r.text).toBe("shown"); expect(r.blocked).toBe(true);
  });
  it("boundResult truncates oversized results", () => {
    expect(boundResult({ a: 1 })).toEqual({ a: 1 });
    expect((boundResult({ a: "x".repeat(9000) }) as any).truncated).toBe(true);
  });
});

describe("parsing", () => {
  it("SSE line -> text deltas, usage, blocked", () => {
    const acc = { parts: [] as Part[], usage: { inTok: 0, outTok: 0 }, blocked: false };
    const got: string[] = [];
    applySseLine(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Na" }, { text: "x", thought: true }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })}`, acc, (t) => got.push(t));
    applySseLine("data: {torn", acc, (t) => got.push(t));
    applySseLine(`data: ${JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })}`, acc, () => undefined);
    expect(got).toEqual(["Na"]); expect(acc.usage).toEqual({ inTok: 3, outTok: 2 }); expect(acc.blocked).toBe(true);
  });
  it("facts: max 3, short, no ids/secrets", () => {
    const raw = JSON.stringify(["Likes to be called Anu", "x", "Card 4111111111111111", "Asking about marriage timing", "My password is hunter2 ok", "Has a daughter", "Fourth fact here ok"]);
    expect(parseFacts("```json\n" + raw + "\n```")).toEqual(["Likes to be called Anu", "Asking about marriage timing", "Has a daughter"]);
    expect(parseFacts("not json")).toEqual([]);
  });
  it("wire messages: visitor->user, preeti->assistant, tool rows dropped, cards kept", () => {
    const out = toWire([
      { role: "visitor", text: "hi", cards_json: null },
      { role: "tool", text: "", cards_json: null },
      { role: "preeti", text: "Namaste", cards_json: JSON.stringify([{ kind: "puja", subject_id: "e1" }]) },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1].cards).toHaveLength(1); expect(out[0].cards).toBeUndefined();
  });
});
