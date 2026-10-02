// [AUMFE-CONSULT-W2-1 2026-10-02] Numerology cards: core_numbers, lo_shu, names, lucky, report, daily.
// AstrologyAPI (verified shapes, see voice_agents/packs/numerology.ts): numero_table {name, day, month, year},
// numero_report {name, day, month, year}, numero_prediction/daily {name, day, month, year}.
// Our own maths (numerology_calc.ts): radical/destiny from the DOB, Chaldean name totals, mobile-number total, Lo Shu grid.
import type { NumerologyIntake } from "../types";
import { type CardOut, missing, ok, clipStr } from "./shared";
import { short, type PrepDeps } from "./deps";
import { cleanLatinName, dobNumbers, loShu, mobileTotal, nameTotals, parseIsoDate } from "./numerology_calc";

/** numero_table -> the "lucky" card payload. Pure. */
export function luckyFromTable(t: any) {
  const o: Record<string, string> = {};
  const put = (k: string, v: unknown) => { const s = clipStr(v, 100); if (s) o[k] = s; };
  put("colour", t?.fav_color); put("days", t?.fav_day); put("numbers", t?.friendly_num); put("stone", t?.fav_stone);
  put("metal", t?.fav_metal); put("deity", t?.fav_god); put("mantra", t?.fav_mantra); put("avoid_numbers", t?.evil_num);
  return o;
}

export function coreFromTable(t: any) {
  return {
    destiny_number: t?.destiny_number ?? null, radical_number: t?.radical_number ?? t?.radical_num ?? null,
    name_number: t?.name_number ?? null, ruling_planet: clipStr(t?.radical_ruler, 40) || null,
  };
}

export function ownNames(intake: NumerologyIntake) {
  const list: { label: string; name: string }[] = [{ label: "Birth name", name: intake.birth_name }];
  if (intake.used_name && intake.used_name.trim() && intake.used_name.trim() !== intake.birth_name.trim()) list.push({ label: "Name in use", name: intake.used_name });
  for (const n of intake.names_to_check ?? []) if (n && n.trim()) list.push({ label: "To check", name: n });
  return list.slice(0, 8).map((x) => ({ label: x.label, ...nameTotals(x.name) }));
}

export async function buildNumerologyCards(intake: NumerologyIntake, deps: PrepDeps): Promise<CardOut[]> {
  const dob = parseIsoDate(intake.dob);
  const own = dobNumbers(intake.dob);
  const grid = loShu(intake.dob);
  const mob = intake.mobile ? mobileTotal(intake.mobile) : null;
  const cards: CardOut[] = [];

  const latin = cleanLatinName(intake.birth_name) ?? cleanLatinName(intake.used_name);
  const apiBody = dob && latin ? { name: latin, day: dob.day, month: dob.month, year: dob.year } : null;
  const apiErr = !dob ? "Date of birth is invalid" : "Name needs English letters for the API (our own totals are still shown)";
  const [table, report, daily] = apiBody
    ? await Promise.all([deps.call("numero_table", apiBody, "forever"), deps.call("numero_report", apiBody, "forever"), deps.call("numero_prediction/daily", apiBody, "day")])
    : [null, null, null];

  // core_numbers: our own DOB + mobile numbers always; API table numbers when available.
  if (!own) cards.push(missing("core_numbers", "Date of birth is invalid"));
  else {
    cards.push(ok("core_numbers", {
      own: { radical: own.radical, destiny: own.destiny },
      mobile: mob ? { digits: mob.digits, total: mob.total, root: mob.root } : null,
      api: table?.ok ? coreFromTable(table.data) : null,
    }, table && !table.ok ? `API numbers not available (${short(table.error)})` : !table ? `API numbers not available (${apiErr})` : undefined));
  }
  cards.push(grid ? ok("lo_shu", grid) : missing("lo_shu", "Date of birth is invalid"));

  const apiName = table?.ok ? (table.data?.name_number ?? null) : null;
  cards.push(ok("names", { api_name_number: apiName, names: ownNames(intake), scheme: "Chaldean", used_for_api: latin ?? null }));

  cards.push(table?.ok ? ok("lucky", luckyFromTable(table.data)) : missing("lucky", table ? `Could not fetch (${short(table.error)})` : apiErr));
  cards.push(report?.ok && clipStr(report.data?.description, 5)
    ? ok("report", { title: clipStr(report.data?.title, 100) || null, description: String(report.data.description).trim().slice(0, 4000) })
    : missing("report", report ? (report.ok ? "Empty report" : `Could not fetch (${short(report.error)})`) : apiErr));
  cards.push(daily?.ok && clipStr(daily.data?.prediction, 5)
    ? ok("daily", {
      prediction: clipStr(daily.data.prediction, 1500), lucky_color: clipStr(daily.data.lucky_color, 40) || null,
      lucky_number: clipStr(daily.data.lucky_number, 10) || null, prediction_date: clipStr(daily.data.prediction_date, 20) || null,
    }, "Refreshed daily; this is the day it was prepared")
    : missing("daily", daily ? (daily.ok ? "Empty prediction" : `Could not fetch (${short(daily.error)})`) : apiErr));
  return cards;
}
