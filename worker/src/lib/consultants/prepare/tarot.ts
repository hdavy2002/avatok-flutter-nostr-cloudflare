// [AUMFE-CONSULT-W2-1 2026-10-02] Tarot cards: spread, readings, yes_no.
// AstrologyAPI (verified, see voice_agents/packs/tarot.ts): tarot_predictions {love, career, finance} ids 1..78 -> {love, career, finance} texts
// (NO card names: ours come from tarot_deck.ts); yes_no_tarot {tarot_id 1..22} -> {name, value:"Yes"|"No", description}.
import type { TarotIntake } from "../types";
import { cardById, majorById, meaningOf } from "../tarot_deck";
import { type CardOut, missing, ok, notApplicable, clipStr } from "./shared";
import { short, type PrepDeps } from "./deps";

export const AREAS = ["love", "career", "finance"] as const;
export type Area = (typeof AREAS)[number];

/** The three chosen cards with names and one-line meanings. Pure. Returns null when any id is invalid. */
export function spreadOf(intake: TarotIntake) {
  const out: { area: Area; id: number; name: string; reversed: boolean; meaning: string }[] = [];
  for (const area of AREAS) {
    const card = cardById(Number(intake.cards?.[area]));
    if (!card) return null;
    const reversed = intake.reversed?.[area] === true;
    out.push({ area, id: card.id, name: card.name, reversed, meaning: meaningOf(card, reversed) });
  }
  return out;
}

export function readingsFrom(data: any) {
  const o: Record<string, string> = {};
  for (const a of AREAS) { const t = String(data?.[a] ?? "").trim(); if (t) o[a] = t.slice(0, 3000); }
  return o;
}

export async function buildTarotCards(intake: TarotIntake, deps: PrepDeps): Promise<CardOut[]> {
  const spread = spreadOf(intake);
  const cards: CardOut[] = [];
  cards.push(spread
    ? ok("spread", { question: clipStr(intake.question, 300), cards: spread })
    : missing("spread", "A chosen card number is outside 1..78"));
  if (!spread) {
    cards.push(missing("readings", "A chosen card number is outside 1..78"));
  } else {
    // Same ids always give the same call, so cache forever: a re-run never changes the text the customer was promised.
    const r = await deps.call("tarot_predictions", { love: intake.cards.love, career: intake.cards.career, finance: intake.cards.finance }, "forever");
    const texts = r.ok ? readingsFrom(r.data) : {};
    if (r.ok && Object.keys(texts).length) {
      const miss = AREAS.filter((a) => !texts[a]);
      cards.push(ok("readings", texts, miss.length ? `No text for: ${miss.join(", ")}` : undefined));
    } else cards.push(missing("readings", r.ok ? "Empty reading" : `Could not fetch (${short(r.error)})`));
  }
  if (!intake.yes_no) cards.push(notApplicable("yes_no", "No yes/no question was asked"));
  else {
    const major = majorById(Number(intake.yes_no.card));
    if (!major) cards.push(missing("yes_no", "Yes/no card must be 1..22"));
    else {
      const r = await deps.call("yes_no_tarot", { tarot_id: major.id }, "forever");
      const value = r.ok ? (/^yes$/i.test(String(r.data?.value ?? "").trim()) ? "Yes" : /^no$/i.test(String(r.data?.value ?? "").trim()) ? "No" : "") : "";
      cards.push(r.ok && value
        ? ok("yes_no", { question: clipStr(intake.yes_no.question, 300), card: { id: major.id, name: major.name }, answer: value, description: clipStr(r.data?.description, 1500) || null })
        : missing("yes_no", r.ok ? "Empty answer" : `Could not fetch (${short(r.error)})`));
    }
  }
  return cards;
}
