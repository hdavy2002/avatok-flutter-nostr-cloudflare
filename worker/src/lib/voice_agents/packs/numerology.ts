// [AUMFE-VOICE-PACKS-1 2026-10-02] Numerology tool pack for voice guides: my_numbers, numerology_report, numerology_today.
// Request shapes verified live against json.astrologyapi.com on 2026-10-02:
//   numero_table          {name, day, month, year}              -> destiny/radical/name numbers + lucky colour/day/number/stone/god/mantra
//   numerological_numbers {full_name, date, month, year}        -> western life path / personality / expression / soul urge / challenges
//                         (NOT name/day: those give "Please enter a valid name!!")
//   numero_report         {name, day, month, year}              -> {title, description} (~1200 chars)
//   numero_prediction/daily {name, day, month, year}            -> {prediction, lucky_color, lucky_number, prediction_date}
import { getProfile } from "../../agent_memory/profile";
import { GUIDE_RULES } from "../../guides/brain";
import type { VoiceTool, VoiceToolCtx } from "../types";
import type { VoiceToolPack } from "../tool_packs";
import { api, brainTools, clip, failOf, isFail, lazyTools, NO_BIRTH, obj, parseDob, txt, type Fail } from "./common";

export interface NumeroIdentity { name: string; day: number; month: number; year: number }

/** Latin letters only: the API computes a name number from letters, and a Devanagari name gives a different, meaningless number. */
export function cleanLatinName(v: unknown): string | null {
  const n = txt(v, 80).replace(/[^A-Za-z .'-]/g, (c) => (/\p{L}/u.test(c) ? "\u0000" : ""));
  if (n.includes("\u0000")) return null; // contains non-Latin letters
  const t = n.replace(/\s+/g, " ").trim();
  return /[A-Za-z]{2}/.test(t) ? t : null;
}

/** Name + date of birth of the CALLER, from the saved profile. `name_spelling` (optional arg) overrides a missing or non-Latin profile name for this call only. */
export async function loadIdentity(ctx: VoiceToolCtx, args: Record<string, unknown>): Promise<NumeroIdentity | Fail> {
  const p = await getProfile(ctx.env, ctx.uid);
  const dob = parseDob(p?.dob);
  if (!p || !dob) return NO_BIRTH;
  const given = args.name_spelling != null && String(args.name_spelling).trim() ? cleanLatinName(args.name_spelling) : null;
  const name = given ?? cleanLatinName(p.name);
  if (!name) {
    return { error: p.name || args.name_spelling ? "name_needs_english_letters" : "no_name",
      hint: "ask for the full name, spelled in English letters, then call again with name_spelling (and call save_birth_details to keep it)" };
  }
  return { name, ...dob };
}

const NAME_ARG = { name_spelling: { type: "STRING", description: "Full name in English letters. Only needed when no name is saved or it is not in English letters." } };

const body = (i: NumeroIdentity) => ({ name: i.name, day: i.day, month: i.month, year: i.year });

// ---------------------------------------------------------------------------
// Pure summarisers (exported for tests)
// ---------------------------------------------------------------------------
export function summariseNumeroTable(t: any) {
  return {
    destiny_number: t?.destiny_number ?? undefined,
    radical_number: t?.radical_number ?? t?.radical_num ?? undefined,
    name_number: t?.name_number ?? undefined,
    ruling_planet: txt(t?.radical_ruler, 40) || undefined,
    lucky: {
      colour: txt(t?.fav_color, 60) || undefined,
      days: txt(t?.fav_day, 80) || undefined,
      numbers: txt(t?.friendly_num, 40) || undefined,
      stone: txt(t?.fav_stone, 60) || undefined,
      metal: txt(t?.fav_metal, 40) || undefined,
      deity: txt(t?.fav_god, 40) || undefined,
      mantra: txt(t?.fav_mantra, 80) || undefined,
    },
    avoid_numbers: txt(t?.evil_num, 40) || undefined,
  };
}

export function summariseWestern(w: any) {
  return {
    life_path: w?.lifepath_number ?? undefined,
    personality: w?.personality_number ?? undefined,
    expression: w?.expression_number ?? undefined,
    soul_urge: w?.soul_urge_number ?? undefined,
    subconscious_self: w?.subconscious_self_number ?? undefined,
    challenges: Array.isArray(w?.challenge_numbers) ? w.challenge_numbers.slice(0, 4) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export const myNumbers: VoiceTool = {
  blocking: true,
  decl: {
    name: "my_numbers",
    description: "The customer's core numerology numbers from their saved name and date of birth: destiny (bhagyank), radical (moolank), name number, plus lucky colour, days, numbers, stone; and the western life path, expression and soul urge numbers.",
    parameters: obj({ ...NAME_ARG }),
  },
  async run(ctx, args) {
    const id = await loadIdentity(ctx, args);
    if (isFail(id)) return id;
    const [tb, wn] = await Promise.all([
      api(ctx, "numero_table", body(id), "forever"),
      api(ctx, "numerological_numbers", { full_name: id.name, date: id.day, month: id.month, year: id.year }, "forever"),
    ]);
    if (!tb.ok && !wn.ok) return failOf(tb);
    const out = {
      name: id.name,
      ...(tb.ok ? summariseNumeroTable(tb.data) : {}),
      western: wn.ok ? summariseWestern(wn.data) : undefined,
    };
    ctx.showCard?.({ title: "Your numbers", items: [
      ...(tb.ok ? [
        { label: "Destiny", value: String(out.destiny_number ?? "-") },
        { label: "Radical", value: String(out.radical_number ?? "-") },
        { label: "Name", value: String(out.name_number ?? "-") },
        { label: "Lucky colour", value: out.lucky?.colour || "-" },
      ] : []),
      ...(wn.ok ? [{ label: "Life path", value: String(out.western?.life_path ?? "-") }] : []),
    ] });
    return out;
  },
};

export const numerologyReport: VoiceTool = {
  blocking: true,
  decl: {
    name: "numerology_report",
    description: "A short numerology reading of the customer's radical number: character, strengths and tendencies. Speak it in your own words, two or three sentences.",
    parameters: obj({ ...NAME_ARG }),
  },
  async run(ctx, args) {
    const id = await loadIdentity(ctx, args);
    if (isFail(id)) return id;
    const r = await api(ctx, "numero_report", body(id), "forever");
    if (!r.ok) return failOf(r);
    const report = clip(r.data?.description, 700);
    if (!report) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
    ctx.showCard?.({ title: txt(r.data?.title, 60) || "Your numerology", items: [{ label: "Reading", value: clip(report, 110) }] });
    return { name: id.name, title: txt(r.data?.title, 60) || undefined, report, truncated: txt(r.data?.description, 100000).length > report.length };
  },
};

export const numerologyToday: VoiceTool = {
  blocking: true,
  decl: {
    name: "numerology_today",
    description: "Today's numerology prediction for the customer, with today's lucky colour and number. Changes every day (IST).",
    parameters: obj({ ...NAME_ARG }),
  },
  async run(ctx, args) {
    const id = await loadIdentity(ctx, args);
    if (isFail(id)) return id;
    const r = await api(ctx, "numero_prediction/daily", body(id), "day");
    if (!r.ok) return failOf(r);
    const prediction = clip(r.data?.prediction, 450);
    if (!prediction) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
    const out = {
      date: txt(r.data?.prediction_date, 20) || undefined,
      prediction,
      lucky_colour: txt(r.data?.lucky_color, 40) || undefined,
      lucky_number: txt(r.data?.lucky_number, 10) || undefined,
    };
    ctx.showCard?.({ title: "Today for you", items: [
      { label: "Lucky colour", value: out.lucky_colour || "-" }, { label: "Lucky number", value: out.lucky_number || "-" },
    ] });
    return out;
  },
};

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------
export function numerologyBaseRules(brandName: string): string {
  return `NUMEROLOGY (Ank Jyotish)
- Your numbers come from the customer's full name and date of birth, both saved on file. New customer: gently ask their full name (spelled in English letters), date of birth, then call save_birth_details. Time and place of birth are not needed.
- Do not re-ask details you already have. If a tool says no_birth_details or no_name, collect them and save; if it says name_needs_english_letters, ask them to spell the name in English letters.
- Use my_numbers, numerology_report and numerology_today for facts. Never calculate or guess a number yourself and never invent a lucky colour, day or stone. If a tool fails, say you could not read it right now and offer to try again.
- Explain numbers in plain words: destiny (bhagyank) is the life path from the full date of birth, radical (moolank) is the birth day, the name number comes from the spelling. A different spelling changes only the name number.
- Speak results in one or two short sentences; the customer also sees a card. Never read a list of digits or a whole report aloud.
- You may suggest a lucky colour or day as a gentle habit, never as a cure. A matching puja, havan or T-shirt offered by ${brandName} may be mentioned softly, only if search_catalog returned it.

${GUIDE_RULES}`;
}

const tools = lazyTools(() => [myNumbers, numerologyReport, numerologyToday, ...brainTools(["search_catalog", "search_tradition"])]);

export const numerologyPack: VoiceToolPack = {
  id: "numerology",
  label: "Numerology",
  description: "Destiny, radical and name numbers, lucky colour/day/number, a short report and today's numerology prediction, from the customer's saved name and date of birth.",
  get tools() { return tools(); },
  baseRules: numerologyBaseRules,
};
