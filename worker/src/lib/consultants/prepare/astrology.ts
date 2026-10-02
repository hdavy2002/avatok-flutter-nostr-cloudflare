// [AUMFE-CONSULT-W2-1 2026-10-02] Astrology cards: birth_details, chart_d1, chart_d9, planets, dasha, doshas, panchang, remedies, match.
// AstrologyAPI endpoints (json host): birth_details, astro_details, horo_chart_image/D1|D9, planets, current_vdasha, major_vdasha,
// manglik, kalsarpa_details, sadhesati_current_status, pitra_dosha_report, basic_panchang, puja_suggestion, basic_gem_suggestion,
// rudraksha_suggestion; with a partner: match_ashtakoot_points, match_dashakoot_points, match_manglik_report, match_making_report.
import type { AstrologyIntake, BirthBlock } from "../types";
import type { NatalBody } from "../../astrology";
import { ASTRO_ENDPOINTS } from "../../astrology";
import type { AstroResult } from "../../astrology";
import { type CardOut, missing, ok, notApplicable, parseHm, clipStr } from "./shared";
import { short, type PrepDeps } from "./deps";

export const APPROX_NOTE = "approximate — birth time unknown";
/** Cards whose answer depends on the exact birth time. */
export const TIME_SENSITIVE = new Set(["birth_details", "chart_d1", "chart_d9", "planets", "dasha", "doshas", "remedies", "match"]);

export interface ResolvedBirth { body: NatalBody; approximate: boolean }
export type BirthResult = { ok: true; birth: ResolvedBirth } | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** BirthBlock -> natal body. Geo from the block's lat/lon, else geoLookup(place); tzone from the block, else the API, else IST. Unknown time -> 12:00. */
export async function resolveBirth(b: BirthBlock, deps: PrepDeps): Promise<BirthResult> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b?.dob ?? ""));
  if (!m) return { ok: false, error: "Birth date is missing or invalid" };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let hour = 12, min = 0, approximate = true;
  const t = !b.tob_unknown ? parseHm(b.tob) : null;
  if (t) { hour = t.hour; min = t.min; approximate = false; }
  let lat = b.lat, lon = b.lon;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    if (!clipStr(b.place)) return { ok: false, error: "Birth place is missing" };
    const g = await deps.geo(b.place);
    if (!g) return { ok: false, error: `Could not find the birth place "${clipStr(b.place, 60)}"` };
    lat = g.lat; lon = g.lon;
  }
  let tzone = b.tzone;
  if (tzone == null || !Number.isFinite(tzone)) {
    const z = await deps.tzone(lat, lon, `${pad(day)}-${pad(month)}-${year}`);
    tzone = z ?? 5.5; // India default when the lookup is down
  }
  return { ok: true, birth: { body: { day, month, year, hour, min, lat, lon, tzone }, approximate } };
}

/** m_* = male (groom) side, f_* = female (bride) side. Same shape the voice marriage pack uses (verified live 2026-10-02). */
export function buildMatchBody(customerSide: "male" | "female", customer: NatalBody, partner: NatalBody): Record<string, number> {
  const pre = (p: "m" | "f", n: NatalBody) => ({
    [`${p}_day`]: n.day, [`${p}_month`]: n.month, [`${p}_year`]: n.year, [`${p}_hour`]: n.hour, [`${p}_min`]: n.min,
    [`${p}_lat`]: n.lat, [`${p}_lon`]: n.lon, [`${p}_tzone`]: n.tzone,
  });
  return customerSide === "male" ? { ...pre("m", customer), ...pre("f", partner) } : { ...pre("m", partner), ...pre("f", customer) };
}

type Probe = { name: string; r: AstroResult<any> };
/** Combine several API answers into one card: ok when any succeeded (failures listed in the note), missing when all failed. */
export function combine(key: string, probes: Probe[], approximate: boolean, shape: (data: Record<string, any>) => unknown = (d) => d): CardOut {
  const data: Record<string, any> = {};
  const failed: string[] = [];
  let firstErr = "";
  for (const p of probes) {
    if (p.r.ok) data[p.name] = p.r.data;
    else { failed.push(p.name); firstErr ||= short(p.r.error); }
  }
  if (!Object.keys(data).length) return missing(key, `Could not fetch (${firstErr})`);
  const notes: string[] = [];
  if (failed.length) notes.push(`Not available: ${failed.join(", ")}`);
  if (approximate && TIME_SENSITIVE.has(key)) notes.push(APPROX_NOTE);
  return ok(key, shape(data), notes.join("; ") || undefined);
}

const ep = (k: keyof typeof ASTRO_ENDPOINTS) => ASTRO_ENDPOINTS[k];

export async function buildAstrologyCards(intake: AstrologyIntake, deps: PrepDeps): Promise<CardOut[]> {
  const rb = await resolveBirth(intake.birth, deps);
  const keys = ["birth_details", "chart_d1", "chart_d9", "planets", "dasha", "doshas", "panchang", "remedies", "match"];
  if (!rb.ok) return keys.map((k) => missing(k, rb.error));
  const { body, approximate } = rb.birth;
  const c = (path: string, ttl: "forever" | "day" | "none") => deps.call(path, { ...body }, ttl);
  const E = (k: keyof typeof ASTRO_ENDPOINTS) => c(ep(k).path, ep(k).ttl);

  const [bd, ad, d1, d9, pl, cur, maj, mg, ks, ss, pt, pc, puja, gem, rud] = await Promise.all([
    E("birth_details"), E("astro_details"),
    // UNVERIFIED path/shape: horo_chart_image/<chart id> (D1 = lagna, D9 = navamsha). Card goes `missing` if it fails.
    c("horo_chart_image/D1", "forever"), c("horo_chart_image/D9", "forever"),
    E("planets"), E("current_vdasha"), E("major_vdasha"),
    E("manglik"), E("kalsarpa_details"), E("sadhesati_current_status"), E("pitra_dosha_report"),
    // Panchang of the BIRTH day/place (natal data, so cached forever), not today's.
    c(ep("basic_panchang").path, "forever"),
    E("puja_suggestion"), E("basic_gem_suggestion"), E("rudraksha_suggestion"),
  ]);

  const cards: CardOut[] = [
    combine("birth_details", [{ name: "birth", r: bd }, { name: "astro", r: ad }], approximate),
    combine("chart_d1", [{ name: "chart", r: d1 }], approximate),
    combine("chart_d9", [{ name: "chart", r: d9 }], approximate),
    combine("planets", [{ name: "planets", r: pl }], approximate, (d) => d.planets),
    combine("dasha", [{ name: "current", r: cur }, { name: "major", r: maj }], approximate),
    combine("doshas", [{ name: "manglik", r: mg }, { name: "kalsarpa", r: ks }, { name: "sadhesati", r: ss }, { name: "pitra", r: pt }], approximate),
    combine("panchang", [{ name: "panchang", r: pc }], approximate, (d) => d.panchang),
    combine("remedies", [{ name: "puja", r: puja }, { name: "gemstone", r: gem }, { name: "rudraksha", r: rud }], approximate),
  ];
  cards.push(await buildMatchCard(intake, body, approximate, deps));
  return cards;
}

export async function buildMatchCard(intake: AstrologyIntake, mine: NatalBody, myApprox: boolean, deps: PrepDeps): Promise<CardOut> {
  const partner = intake.partner;
  if (!partner) return notApplicable("match", "No partner details were given");
  const rp = await resolveBirth(partner, deps);
  if (!rp.ok) return missing("match", `Partner: ${rp.error}`);
  const g = intake.birth.gender;
  const side: "male" | "female" = g === "female" ? "female" : "male";
  const body = buildMatchBody(side, mine, rp.birth.body);
  const [ash, dash, mg, rep] = await Promise.all([
    deps.call(ep("match_ashtakoot_points").path, body, "forever"),
    deps.call("match_dashakoot_points", body, "forever"),
    deps.call(ep("match_manglik_report").path, body, "forever"),
    deps.call(ep("match_making_report").path, body, "forever"),
  ]);
  const approx = myApprox || rp.birth.approximate;
  const card = combine("match", [{ name: "ashtakoot", r: ash }, { name: "dashakoot", r: dash }, { name: "manglik", r: mg }, { name: "report", r: rep }], approx);
  if (card.status !== "ok") return card;
  const extra: string[] = [];
  if (g === "other") extra.push("customer gender not male/female: treated as the groom side");
  if (rp.birth.approximate && !myApprox) extra.push("partner birth time unknown");
  card.api = { customer_side: side, ...(card.api as object) };
  if (extra.length) card.note = [card.note, ...extra].filter(Boolean).join("; ");
  return card;
}
