// [AUMFE-PREETI-BRAIN-1] Preeti on the shared brain: rules text, prompt gating, tool gating, cards, recommendation telemetry.
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchCatalog = vi.fn();
const searchTradition = vi.fn();
vi.mock("../knowledge", () => ({ searchCatalog: (...a: unknown[]) => searchCatalog(...a), searchTradition: (...a: unknown[]) => searchTradition(...a) }));
const track = vi.fn(async () => undefined);
vi.mock("../../hooks", () => ({ track: (...a: unknown[]) => track(...(a as [])), trackException: vi.fn(async () => undefined) }));

import { CORE_REMINDER, CORE_RULES, coreReminder, coreRules } from "./core_rules";
import { buildSystemPrompt } from "./prompt";
import { MAX_TOOL_CARDS, guideCard, itemCard } from "./brain";
import { TOOL_DECLARATIONS, runTool, toolDeclarations, type ToolCtx } from "./tools";
import type { PreetiCard } from "./contracts";

const brand = { name: "Brand", domain: "brand.test", site: "https://brand.test", former: [] };
const hit = (id: string, o: Record<string, unknown> = {}) => ({
  subject_kind: "shop_product", subject_id: id, title: `Tee ${id}`, price_inr: 799, image_url: "/img/a.png", url: `/shop/${id}`,
  wear_days: ["tuesday"], deity: "hanuman", chakra: "solar plexus", tradition_note: "n", why: [{ step: "deity", fact: "Hanuman on the design" }], score: 1, ...o,
});

function ctxOf(o: Partial<ToolCtx> = {}): { ctx: ToolCtx; cards: PreetiCard[] } {
  const cards: PreetiCard[] = [];
  const ctx = {
    env: {} as any, brand, agentName: "Preeti", cfg: {} as any, conv: { id: "c1", is_test: 0 } as any, uid: "u1", traceId: "t",
    guides: true, memorySessionId: "s1", showCard: (c: PreetiCard) => cards.push(c), ...o,
  } as ToolCtx;
  return { ctx, cards };
}

beforeEach(() => { searchCatalog.mockReset(); searchTradition.mockReset(); track.mockClear(); });

describe("rules text", () => {
  it("guides=false keeps today's text: no astrology rule lifted, no hand-off section", () => {
    expect(coreRules(false)).toBe(CORE_RULES);
    expect(coreReminder(false)).toBe(CORE_REMINDER);
    expect(CORE_RULES).toContain("Astrology, horoscopes, kundli, palmistry, numerology, predictions of anyone's future.");
    expect(CORE_RULES).not.toContain("suggest_guide");
    expect(CORE_RULES).not.toContain("Pandit ji");
    expect(CORE_REMINDER).toContain("no astrology/predictions");
  });
  it("guides=true lifts astrology but keeps the hard rules and hands readings over", () => {
    const r = coreRules(true);
    expect(r).not.toContain("Astrology, horoscopes, kundli, palmistry, numerology, predictions of anyone's future.");
    expect(r).toContain("suggest_guide");
    expect(r).toContain("never voice");
    expect(r).toContain("/pandit");
    expect(r).toContain("/talk");
    for (const keep of ["Guaranteed outcomes", "Black magic", "any other customer's data", "any previous, older, other or \"original\" name", "support executive", "never predict"]) expect(r).toContain(keep);
    expect(coreReminder(true)).not.toContain("no astrology/predictions");
    expect(coreReminder(true)).toContain("no guaranteed outcomes");
  });
});

describe("system prompt gating", () => {
  const base = { brand, agentName: "Preeti", persona: "p", page: { path: "/", kind: "home" as const }, signedIn: true, firstName: "A", hasPhone: true, now: 0, articles: [] };
  it("ignores a briefing unless guides is on", () => {
    const off = buildSystemPrompt({ ...base, briefing: "<customer_memory>X</customer_memory>" });
    expect(off).not.toContain("customer_memory");
    expect(off).toContain("Astrology, horoscopes");
    const on = buildSystemPrompt({ ...base, guides: true, briefing: "<customer_memory>X</customer_memory>" });
    expect(on).toContain("<customer_memory>X</customer_memory>");
    expect(on).toContain("suggest_guide");
  });
});

describe("tool declarations", () => {
  const names = (c: ToolCtx) => (toolDeclarations(c) as { name: string }[]).map((d) => d.name);
  it("is exactly today's list without guides", () => {
    expect(toolDeclarations(ctxOf({ guides: false }).ctx)).toBe(TOOL_DECLARATIONS);
  });
  it("adds catalogue, tradition and guide tools with guides; remember only with a memory session", () => {
    expect(names(ctxOf({ memorySessionId: null }).ctx)).toEqual([...TOOL_DECLARATIONS.map((d) => d.name), "search_catalog", "search_tradition", "suggest_guide"]);
    expect(names(ctxOf().ctx)).toContain("remember");
  });
  it("shared-brain tools refuse to run without guides or without a uid", async () => {
    expect(await runTool(ctxOf({ guides: false }).ctx, "search_catalog", { query: "x" })).toEqual({ error: "unknown_tool" });
    expect(await runTool(ctxOf({ uid: null }).ctx, "suggest_guide", { guide: "meera" })).toEqual({ error: "unknown_tool" });
    expect(searchCatalog).not.toHaveBeenCalled();
  });
});

describe("recommendations", () => {
  it("search_catalog shows item cards (absolute urls), logs each, and returns compact items", async () => {
    searchCatalog.mockResolvedValue([hit("p1"), hit("p2", { subject_kind: "event" })]);
    const { ctx, cards } = ctxOf();
    const r: any = await runTool(ctx, "search_catalog", { query: "hanuman tee" });
    expect(r.items).toHaveLength(2);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ type: "item", kind: "product", id: "p1", read_more_url: "https://brand.test/shop/p1", image: "https://brand.test/img/a.png", price_rupees: 799 });
    expect(cards[1]).toMatchObject({ type: "item", kind: "puja" });
    const ev = track.mock.calls.filter((c: any[]) => c[2] === "preeti_recommendation_shown").map((c: any[]) => c[4]);
    expect(ev).toEqual([
      expect.objectContaining({ item_id: "p1", kind: "product", uid: "u1", conversation_id: "c1" }),
      expect.objectContaining({ item_id: "p2", kind: "puja" }),
    ]);
  });
  it("search_tradition passes through the library passages without cards", async () => {
    searchTradition.mockResolvedValue([{ title: "Shani", text: "Saturday fasting", source: "Text" }]);
    const { ctx, cards } = ctxOf();
    const r: any = await runTool(ctx, "search_tradition", { query: "shani" });
    expect(r.passages[0]).toMatchObject({ title: "Shani", source: "Text" });
    expect(cards).toHaveLength(0);
  });
  it("suggest_guide shows a card once per guide, rejects unknown guides, and caps tool cards", async () => {
    const { ctx, cards } = ctxOf();
    const a: any = await runTool(ctx, "suggest_guide", { guide: "pandit", reason: "kundli" });
    expect(a).toMatchObject({ shown: true, guide: "pandit", free: true });
    await runTool(ctx, "suggest_guide", { guide: "pandit" });
    expect(cards).toEqual([guideCard(ctx, "pandit")]);
    expect(cards[0]).toMatchObject({ type: "guide", free: true, url: "https://brand.test/pandit" });
    expect(guideCard(ctx, "meera")).toMatchObject({ free: false, url: "https://brand.test/talk?guide=astrology" });
    expect(await runTool(ctx, "suggest_guide", { guide: "someone" })).toMatchObject({ shown: false });
    searchCatalog.mockResolvedValue(Array.from({ length: 5 }, (_, i) => hit(`q${i}`)));
    await runTool(ctx, "search_catalog", { query: "x" });
    expect(cards.length).toBeLessThanOrEqual(MAX_TOOL_CARDS);
  });
  it("itemCard keeps absolute urls and null images", () => {
    const c = itemCard(ctxOf().ctx, { ...(hit("z") as any), kind: "puja", image_url: null, url: "https://other/x" });
    expect(c).toMatchObject({ image: null, read_more_url: "https://other/x" });
  });
});
