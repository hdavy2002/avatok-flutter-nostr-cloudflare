// [AUMFE-GUIDE-BRAIN-1 2026-10-01] The ONE brain behind both guides: Meera (female, voice) and Pandit ji (male, text).
// Same rules, same tools, same customer memory. In the UI they stay two people; underneath they cannot disagree.
//   GUIDE_RULES       owner rules, appended to both personas' prompts
//   sharedGuideTools  astrology tools + knowledge tools (catalog / tradition / chart-based recommendation)
// Memory tools (remember, recall, save_birth_details) are added by the voice runtime for Meera and by text_chat.ts for
// Pandit ji, both from voice_agents/memory_tools.ts. Not duplicated here.
import { searchCatalog, searchTradition } from "../knowledge";
import type { CatalogHit } from "../knowledge";
import type { VoiceCard, VoiceTool } from "../voice_agents/types";
import { astrologyTools, call, isFail, loadBirth, s } from "./astro_tools";
import type { GuideCard, GuideToolCtx } from "./types";

export const GUIDE_RULES = `GUIDE RULES (owner's rules; they bind every answer)
- Go by the book: say what Hindu tradition prescribes, and name the source (text, tradition) when asked. If you do not know, say so; never invent a scripture or a verse.
- Never promise an outcome ("this will fix...", "you will get..."). Say what tradition holds, in "tradition says / is believed to" words.
- No fear selling. Never make the customer afraid of a dosha, a planet or a missed purchase.
- Never predict death, illness, accidents or court results. No medical, legal or financial advice; suggest a qualified professional.
- Recommend ONLY items returned by search_catalog or recommend_for_chart. Never name a product, puja, price or link that no tool gave you. If nothing is returned, say so and offer to look again.
- Explain a product design-first: the deity or symbol on the design, then its chakra / mandala / yantra, then the print colour, then the shirt colour last. Chakra colours follow the modern convention. Use the "why" steps the tool returns.
- Use search_tradition for facts about rituals, deities, mantras and wear days before you state them.
- Chart facts come from the chart tools only. You may read the chart, advise, refer and recommend, softly, never pressure.
- Reply in the customer's language and switch when they do.`;

const CLIP = 260;
const clip = (t: string, n = CLIP) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** Catalog hit -> the card the web renders. */
export function toGuideCard(h: CatalogHit): GuideCard {
  return {
    kind: h.subject_kind === "event" ? "puja" : "product",
    subject_id: h.subject_id,
    title: h.title,
    price_inr: h.price_inr,
    image_url: h.image_url,
    url: h.url,
    wear_days: h.wear_days,
    deity: h.deity,
    chakra: h.chakra,
    tradition_note: h.tradition_note,
    why: h.why.map((w) => ({ step: w.step, fact: w.fact })),
  };
}

/** Compact JSON the model sees for one card (small: well under the 4 KB tool-result budget for 3 items). */
export function compactItem(c: GuideCard) {
  return {
    subject_id: c.subject_id, kind: c.kind, title: c.title, price_inr: c.price_inr, url: c.url,
    deity: c.deity, chakra: c.chakra, wear_days: c.wear_days,
    tradition_note: clip(c.tradition_note), why: c.why.map((w) => ({ step: w.step, fact: clip(w.fact, 160) })),
  };
}

/** What the voice call screen shows (it has no product card yet): title plus a few label/value rows. */
export function voiceCardOf(c: GuideCard): VoiceCard {
  const items: { label: string; value: string }[] = [];
  if (c.price_inr != null) items.push({ label: "Price", value: `₹${c.price_inr}` });
  if (c.deity) items.push({ label: "Deity", value: c.deity });
  if (c.wear_days.length) items.push({ label: "Wear on", value: c.wear_days.join(", ") });
  return { title: c.title, items };
}

function emit(ctx: GuideToolCtx, cards: GuideCard[]): void {
  for (const c of cards) {
    ctx.showGuideCard?.(c);
    ctx.showCard?.(voiceCardOf(c));
  }
}

const MAX_ITEMS = 3;
const MAX_PASSAGES = 4;
const KINDS = ["shop_product", "event"] as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "OBJECT", properties, ...(required.length ? { required } : {}) });
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const NOTHING = { items: [], note: "Nothing in the catalog matches. Say so honestly; do not recommend anything else." };

const searchCatalogTool: VoiceTool = {
  blocking: true,
  decl: {
    name: "search_catalog",
    description:
      `Find shirts, products and pujas sold here that match what the customer needs. Returns at most ${MAX_ITEMS} items and shows them to the customer as cards. ` +
      "Recommend ONLY what this returns. Filters are optional; use them when you know the deity, graha (planet), chakra or weekday.",
    parameters: obj({
      query: { type: "STRING", description: "What the customer is looking for, in a few words (e.g. 'Hanuman shirt for Tuesday', 'Shani remedy puja')." },
      kind: { type: "STRING", enum: ["product", "puja"], description: "product = a shirt/item, puja = a puja or havan event. Omit for both." },
      deity: { type: "STRING", description: "e.g. shiva, hanuman, ganesha" },
      graha: { type: "STRING", description: "e.g. saturn, mars" },
      chakra: { type: "STRING", description: "e.g. heart, throat" },
      wear_day: { type: "STRING", description: "Weekday in English, e.g. tuesday" },
    }, ["query"]),
  },
  async run(rawCtx, args) {
    const ctx = rawCtx as GuideToolCtx;
    const query = str(args.query);
    if (!query) return { error: "query_required" };
    const kind = args.kind === "product" ? KINDS[0] : args.kind === "puja" ? KINDS[1] : undefined;
    const hits = await searchCatalog(ctx.env, {
      query, k: MAX_ITEMS,
      filters: { kind, deity: str(args.deity, 40), graha: str(args.graha, 40), chakra: str(args.chakra, 40), wear_day: str(args.wear_day, 20) },
    });
    const cards = hits.slice(0, MAX_ITEMS).map(toGuideCard);
    if (!cards.length) return NOTHING;
    emit(ctx, cards);
    return { items: cards.map(compactItem) };
  },
};

const searchTraditionTool: VoiceTool = {
  blocking: true,
  decl: {
    name: "search_tradition",
    description:
      `Look up what Hindu tradition says (rituals, deities, mantras, grahas, wear days, fasting) from the approved library. Returns at most ${MAX_PASSAGES} passages, each with its source. ` +
      "Use it before stating a traditional fact, and to name the source when the customer asks.",
    parameters: obj({
      query: { type: "STRING", description: "The question, in a few words." },
      topic: { type: "STRING", description: "Optional topic filter, e.g. graha, deity, vrat, mantra." },
    }, ["query"]),
  },
  async run(ctx, args) {
    const query = str(args.query);
    if (!query) return { error: "query_required" };
    const hits = await searchTradition(ctx.env, { query, topic: str(args.topic, 40), k: MAX_PASSAGES });
    if (!hits.length) return { passages: [], note: "The library has nothing on this. Say you are not sure; do not guess a source." };
    return { passages: hits.slice(0, MAX_PASSAGES).map((h) => ({ title: h.title, text: clip(h.text, 500), source: h.source })) };
  },
};

// ---------------------------------------------------------------------------
// recommend_for_chart
// ---------------------------------------------------------------------------
/** Traditional graha -> (lowercase English graha key used by the catalog, one-line reason). Pure; exported for tests. */
const GRAHA_KEYS: Record<string, string> = {
  sun: "sun", surya: "sun", moon: "moon", chandra: "moon", mars: "mars", mangal: "mars", mercury: "mercury", budh: "mercury",
  jupiter: "jupiter", guru: "jupiter", venus: "venus", shukra: "venus", saturn: "saturn", shani: "saturn", rahu: "rahu", ketu: "ketu",
};
export const grahaKey = (planet: string): string => GRAHA_KEYS[planet.trim().toLowerCase()] ?? "";

export interface ChartNeed { graha: string; reason: string }

/** From the dasha lord and any doshas, the ordered list of things to look for (max 3). Pure. */
export function chartNeeds(dasha: { mahadasha?: string; antardasha?: string }, doshas: { manglik?: boolean; kalsarpa?: boolean; sadhesati?: boolean; pitra?: boolean }): ChartNeed[] {
  const out: ChartNeed[] = [];
  const add = (planet: string | undefined, reason: string) => {
    const g = grahaKey(planet ?? "");
    if (g && !out.some((o) => o.graha === g)) out.push({ graha: g, reason });
  };
  add(dasha.mahadasha, `${dasha.mahadasha} Mahadasha is running`);
  add(dasha.antardasha, `${dasha.antardasha} Antardasha is running`);
  if (doshas.manglik) add("mars", "Manglik dosha is noted in the chart");
  if (doshas.kalsarpa) add("rahu", "Kalsarpa is noted in the chart");
  if (doshas.sadhesati) add("saturn", "Sade Sati is running");
  return out.slice(0, 3);
}

const recommendForChartTool: VoiceTool = {
  blocking: true,
  decl: {
    name: "recommend_for_chart",
    description:
      "Read the customer's saved chart (current dasha and doshas) and find shirts and pujas from the catalog that tradition links to those grahas. " +
      `Returns at most ${MAX_ITEMS} items with a short 'why' and shows them as cards. Needs saved birth details. Offer softly; never push.`,
    parameters: obj({}),
  },
  async run(rawCtx) {
    const ctx = rawCtx as GuideToolCtx;
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const [dr, mg, ks, ss] = await Promise.all([
      call(ctx, "current_vdasha", b.body), call(ctx, "manglik", b.body), call(ctx, "kalsarpa_details", b.body), call(ctx, "sadhesati_current_status", b.body),
    ]);
    if (!dr.ok) return { error: dr.error === "astro_not_configured" ? "astro_unavailable" : dr.error, hint: "tell the customer you could not read the chart right now" };
    const major = dr.data?.major ?? {}, minor = dr.data?.minor ?? {};
    const flag = (r: { ok: boolean; data?: any }, ...keys: string[]) => {
      if (!r.ok) return false;
      for (const k of keys) { const v = r.data?.[k]; if (typeof v === "boolean") return v; if (v != null && /^(true|yes|present|1)$/i.test(String(v))) return true; }
      return false;
    };
    const needs = chartNeeds(
      { mahadasha: s(major.planet), antardasha: s(minor.planet) },
      { manglik: flag(mg, "is_present", "is_manglik"), kalsarpa: flag(ks, "present"), sadhesati: flag(ss, "sadhesati_status", "is_undergoing_sadhesati") },
    );
    if (!needs.length) return { items: [], note: "No clear graha to work from. Ask the customer what they are looking for, then use search_catalog." };

    const seen = new Set<string>();
    const picked: { card: GuideCard; reason: string }[] = [];
    for (const n of needs) {
      let hits = await searchCatalog(ctx.env, { query: `${n.graha} graha deity remedy`, k: 2, filters: { graha: n.graha } });
      if (!hits.length) hits = await searchCatalog(ctx.env, { query: `${n.graha} graha deity remedy shirt puja`, k: 1 });
      for (const h of hits) {
        const id = `${h.subject_kind}:${h.subject_id}`;
        if (seen.has(id) || picked.length >= MAX_ITEMS) continue;
        seen.add(id);
        picked.push({ card: toGuideCard(h), reason: n.reason });
      }
    }
    if (!picked.length) return { needs: needs.map((n) => n.reason), items: [], note: NOTHING.note };
    emit(ctx, picked.map((p) => p.card));
    return {
      approximate: b.approximate,
      needs: needs.map((n) => n.reason),
      items: picked.map((p) => ({ ...compactItem(p.card), why_now: p.reason })),
    };
  },
};

/** Meera's astrology tools + the knowledge tools. A fresh array each call; the tool objects themselves are shared. */
export function sharedGuideTools(): VoiceTool[] {
  return [...astrologyTools, searchCatalogTool, searchTraditionTool, recommendForChartTool];
}
