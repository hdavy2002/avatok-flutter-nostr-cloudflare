// [AUMFE-VOICE-PACKS-1 2026-10-02] Tarot tool pack for voice guides: draw_tarot. The SERVER draws the cards
// (crypto.getRandomValues), never the model, so a reading cannot be steered. No birth details needed.
// Verified live against json.astrologyapi.com on 2026-10-02:
//   yes_no_tarot       {tarot_id}   tarot_id 1..22 (0 is treated as 1; 23+ returns an empty body). Returns {name, value:"Yes"|"No", description}.
//                      The id is NOT called "input"/"id"/"card": any other key is ignored and the answer is always The Magician.
//   tarot_predictions  {love, career, finance}   each 1..78 (0 = 1; 79+ errors "Cannot read properties of undefined").
//                      Returns ONLY {love, career, finance} reading texts (~1100 chars each). It does NOT return card names.
// So this tool names the card only for yes/no draws; for the other spreads it speaks the reading and never names a card.
import { GUIDE_RULES } from "../../guides/brain";
import type { VoiceTool } from "../types";
import type { VoiceToolPack } from "../tool_packs";
import { api, brainTools, clip, failOf, firstSentence, lazyTools, obj, txt } from "./common";

export const YES_NO_CARDS = 22;
export const READING_CARDS = 78;
export type Topic = "love" | "career" | "finance" | "yes_no";
const TOPICS: readonly Topic[] = ["love", "career", "finance", "yes_no"];

/** Uniform integer in [min, max] from crypto.getRandomValues (rejection sampling: no modulo bias). */
export function randomInt(min: number, max: number): number {
  const span = max - min + 1;
  const limit = Math.floor(0x100000000 / span) * span;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return min + (buf[0] % span);
  }
}

/** `n` distinct ids in [1, max]. `rand` is injectable for tests. */
export function drawDistinct(n: number, max: number, rand: (min: number, max: number) => number = randomInt): number[] {
  const out: number[] = [];
  while (out.length < Math.min(n, max)) {
    const id = rand(1, max);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Topic from the model's arg, else guessed from the question's words. Yes/no questions get the yes/no spread. */
export function inferTopic(question: string, given: unknown): Topic {
  if (typeof given === "string" && (TOPICS as readonly string[]).includes(given)) return given as Topic;
  const q = question.toLowerCase();
  if (/\b(job|career|work|promotion|office|business|exam|study|naukri|kaam|padhai)\b/.test(q)) return "career";
  if (/\b(money|finance|financial|invest|investment|loan|salary|income|wealth|paisa|dhan)\b/.test(q)) return "finance";
  if (/^\s*(will|should|shall|is|are|am|can|do|does|did|could|would|kya)\b/.test(q) && !/\b(love|relationship|marriage|partner)\b/.test(q)) return "yes_no";
  return "love";
}

const AREA_TITLE: Record<string, string> = { love: "Love", career: "Career", finance: "Finance" };
const MEANING_MAX = 380;
const AREA_MAX_ONE = 520;
const AREA_MAX_THREE = 300;

export const drawTarot: VoiceTool = {
  blocking: true,
  decl: {
    name: "draw_tarot",
    description: "Draw tarot cards for the customer's question. The server shuffles and draws; you never choose cards. spread 'one' = a single card (for a yes/no question it names the card and gives Yes or No); spread 'three' = three cards, one each for love, career and finance. Speak the result in your own short words.",
    parameters: obj({
      question: { type: "STRING", description: "The customer's question, in a few words." },
      spread: { type: "STRING", enum: ["one", "three"], description: "one (default) or three" },
      topic: { type: "STRING", enum: [...TOPICS], description: "For spread one: love, career, finance, or yes_no for a yes/no question. Optional: guessed from the question when absent." },
    }, ["question"]),
  },
  async run(ctx, args) {
    const question = txt(args.question, 300);
    const spread = args.spread === "three" ? "three" : "one";

    if (spread === "one" && inferTopic(question, args.topic) === "yes_no") {
      const [id] = drawDistinct(1, YES_NO_CARDS);
      const r = await api(ctx, "yes_no_tarot", { tarot_id: id }, "none");
      if (!r.ok) return failOf(r);
      const name = txt(r.data?.name, 60);
      const value = /^yes$/i.test(txt(r.data?.value, 10)) ? "Yes" : /^no$/i.test(txt(r.data?.value, 10)) ? "No" : "";
      if (!name || !value) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
      ctx.showCard?.({ title: "Your card", items: [{ label: "Card", value: name }, { label: "Answer", value: value }] });
      return { spread: "one", question, card: name, answer: value, meaning: clip(r.data?.description, MEANING_MAX) };
    }

    if (spread === "one") {
      const topic = inferTopic(question, args.topic) as "love" | "career" | "finance";
      const [id] = drawDistinct(1, READING_CARDS);
      const r = await api(ctx, "tarot_predictions", { love: id, career: id, finance: id }, "none");
      if (!r.ok) return failOf(r);
      const reading = clip(r.data?.[topic], AREA_MAX_ONE);
      if (!reading) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
      ctx.showCard?.({ title: `Tarot: ${AREA_TITLE[topic]}`, items: [{ label: AREA_TITLE[topic], value: firstSentence(reading) }] });
      return { spread: "one", question, topic, reading, note: "Card names are not available for this reading. Do not name or invent a card." };
    }

    // three: three different cards, one per life area
    const [a, b, c] = drawDistinct(3, READING_CARDS);
    const r = await api(ctx, "tarot_predictions", { love: a, career: b, finance: c }, "none");
    if (!r.ok) return failOf(r);
    const readings = (["love", "career", "finance"] as const)
      .map((area) => ({ area, reading: clip(r.data?.[area], AREA_MAX_THREE) }))
      .filter((x) => x.reading);
    if (!readings.length) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
    ctx.showCard?.({ title: "Three-card reading", items: readings.map((x) => ({ label: AREA_TITLE[x.area], value: firstSentence(x.reading) })) });
    return { spread: "three", question, readings, note: "Card names are not available for this reading. Do not name or invent a card." };
  },
};

export function tarotBaseRules(brandName: string): string {
  return `TAROT
- Tarot is a reflective practice, not prediction. Say so once, kindly, near the start. Never present a card as a fixed fate.
- No birth details are needed. Ask the customer's question (one short question), then call draw_tarot. The server draws the cards; never pick, swap or re-draw cards to get a better answer. Draw again only if the customer asks a NEW question.
- Use spread "one" for a single question or a yes/no question; spread "three" when they want a fuller look at love, career and finance.
- Speak only what the tool returned. Name a card only when the tool gives a card name (yes/no draws). Never invent a card name, position or meaning.
- Tell the result in two or three short sentences, as guidance to think about, with "the card suggests..." wording. For a Yes or No, add that it is guidance, not a promise.
- Never use tarot for questions about death, illness, pregnancy outcomes, court cases, or exam and lottery results; gently decline and offer a different question.
- You may mention a puja, havan or T-shirt offered by ${brandName} when it fits naturally, only if search_catalog returned it. Never pressure.

${GUIDE_RULES}`;
}

const tools = lazyTools(() => [drawTarot, ...brainTools(["search_catalog", "search_tradition"])]);

export const tarotPack: VoiceToolPack = {
  id: "tarot",
  label: "Tarot",
  description: "One-card, yes/no and three-card (love, career, finance) tarot readings drawn by the server. No birth details needed.",
  get tools() { return tools(); },
  baseRules: tarotBaseRules,
};
