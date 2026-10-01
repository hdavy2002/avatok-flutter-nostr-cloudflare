// [AUMFE-ASTRO-AGENT-1 2026-10-01] Meera, the astrology voice guide (Vedic / Jyotish). Subject agent for the
// VoiceSession runtime (see Specs/SPEC-2026-10-01-VOICE-AGENTS.md). Tools read the CALLER's saved astro_profiles
// row; the model never supplies a uid or birth data for the customer (match_partner takes the PARTNER's details,
// which are not stored anywhere).
import { astroCall, geoLookup, tzoneFor, ASTRO_ENDPOINTS } from "../../astrology";
import type { NatalBody } from "../../astrology";
import { getProfile, type AstroProfile } from "../../agent_memory/profile";
import { BRAND } from "../../brand";
import type { VoiceAgentDef, VoiceTool, VoiceToolCtx } from "../types";

// Voice: "Aoede" (warm, breezy female prebuilt Gemini voice).
export const ASTROLOGY_VOICE = "Aoede";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function systemPrompt({ briefing, brandName, nowIst }: { briefing: string; brandName: string; nowIst: string }): string {
  const core = `You are Meera, ${brandName}'s AI astrology guide (Vedic astrology / Jyotish), speaking with a customer on a live voice call. Now: ${nowIst} IST.

VOICE AND STYLE
- Warm, calm, respectful; address the customer as "ji". Speak the customer's language (Hindi, Hinglish, English or other) and switch when they do.
- Short spoken sentences. No lists, no markdown, no reading out numbers digit by digit. Ask only ONE question at a time. Let the customer talk.
- If asked, say plainly that you are an AI guide, not a human astrologer.

BIRTH DETAILS
- New customer with no birth details on file: gently ask their name, date of birth, time of birth (or that it is unknown) and place of birth, one at a time. Then call save_birth_details.
- Returning customer: greet them by name and mention something you remember (see the briefing below). Do not re-ask details you already have.
- Chart tools use the saved details automatically; never ask the customer to read them out again. If a tool says no_birth_details, collect them and save.
- If the birth time is unknown, say the lagna (ascendant) and house-based parts are uncertain.

HOW TO GUIDE (by the book)
- Speak as tradition says: "shastron ke anusaar...", "Jyotish mein mana jata hai...". Never guarantee outcomes. Never sell fear.
- Never predict death, illness, accidents or court results. No medical, legal or financial advice; for those, gently suggest a qualified professional.
- Use tools for facts (chart, dasha, doshas, panchang, muhurta, matching). Do not invent planetary positions. If a tool fails, say you could not read it right now and offer to try again.
- Summarise tool results in a sentence or two; the customer also sees a card on screen.
- When a dosha or a difficult period comes up you may mention a puja or havan offered by ${brandName}, and simple remedies, softly. Never pressure or push a purchase.
- Use remember() for important new facts the customer shares (family, goals, worries, decisions).

Keep the call focused on astrology; politely steer away from unrelated topics.`;
  const brief = briefing && briefing.trim() ? `\n\n${briefing.trim()}` : "";
  return core + brief;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Fail = { error: string; hint?: string };
type Birth = { body: NatalBody; approximate: boolean; profile: AstroProfile };

const NO_BIRTH: Fail = { error: "no_birth_details", hint: "ask the customer and call save_birth_details" };

/** Builds the natal body from the caller's saved profile. Unknown time -> 12:00 + approximate. Missing lat/lon/tzone are resolved from the place. */
export async function loadBirth(ctx: VoiceToolCtx): Promise<Birth | Fail> {
  const p = await getProfile(ctx.env, ctx.uid);
  if (!p || !p.dob) return NO_BIRTH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.dob);
  if (!m) return NO_BIRTH;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let hour = 12, min = 0, approximate = true;
  if (p.tob && !p.tob_unknown) {
    const t = /^(\d{2}):(\d{2})$/.exec(p.tob);
    if (t) { hour = Number(t[1]); min = Number(t[2]); approximate = false; }
  }
  let lat = p.lat, lon = p.lon, tzone = p.tzone;
  if (lat == null || lon == null) {
    if (!p.place) return { error: "no_birth_place", hint: "ask the customer for the place of birth and call save_birth_details" };
    const g = await geoLookup(ctx.env, p.place, 1, ctx.uid);
    if (!g.ok || !g.data.length) return { error: "place_not_found", hint: "ask for a nearby larger town or city" };
    lat = g.data[0].lat; lon = g.data[0].lon;
  }
  if (tzone == null) {
    const z = await tzoneFor(ctx.env, lat, lon, `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`, ctx.uid);
    tzone = z.ok ? z.data : 5.5; // India default when the lookup is down
  }
  return { body: { day, month, year, hour, min, lat, lon, tzone }, approximate, profile: p };
}

const isFail = (x: Birth | Fail): x is Fail => "error" in x;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, max = 200): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max));
const pick = (o: any, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of keys) if (o && o[k] != null && o[k] !== "") out[k] = s(o[k]);
  return out;
};
const yesNo = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v == null ? null : /^(true|yes|present|1)$/i.test(String(v)));
const pad = (n: number) => String(n).padStart(2, "0");

async function call(ctx: VoiceToolCtx, key: keyof typeof ASTRO_ENDPOINTS, body: object) {
  const ep = ASTRO_ENDPOINTS[key];
  return astroCall<any>(ctx.env, ep.path, { ...body }, { ttl: ep.ttl, uid: ctx.uid });
}
const failOf = (r: { error: string }): Fail => ({ error: r.error === "astro_not_configured" ? "astro_unavailable" : r.error, hint: "tell the customer you could not read it right now" });

// ---------------------------------------------------------------------------
// Summarisers (pure, exported for tests)
// ---------------------------------------------------------------------------
export function summarisePlanets(raw: unknown): { planet: string; sign: string; house: number | null }[] {
  return arr(raw).slice(0, 12).map((p) => ({ planet: s(p?.name), sign: s(p?.sign), house: Number.isFinite(Number(p?.house)) ? Number(p.house) : null }));
}

export function summariseDasha(raw: any): { mahadasha: string; antardasha: string; pratyantar: string; until: string } {
  const major = raw?.major ?? {}, minor = raw?.minor ?? {}, sub = raw?.sub_minor ?? {};
  return { mahadasha: s(major.planet), antardasha: s(minor.planet), pratyantar: s(sub.planet), until: s(minor.end ?? major.end) };
}

export function summariseManglik(raw: any) {
  const present = yesNo(raw?.is_present ?? raw?.manglik_present_rule?.based_on_aspect ?? raw?.is_manglik);
  return { present, status: s(raw?.manglik_status), note: s(raw?.manglik_report ?? raw?.report, 300), percentage: raw?.percentage_manglik_present ?? undefined };
}
export function summariseKalsarpa(raw: any) {
  return { present: yesNo(raw?.present), type: s(raw?.type), note: s(raw?.one_line ?? raw?.report?.report, 300) };
}
export function summariseSadhesati(raw: any) {
  return { running: yesNo(raw?.sadhesati_status ?? raw?.is_undergoing_sadhesati), phase: s(raw?.sadhesati_type ?? raw?.type), note: s(raw?.what_is_sadhesati ?? raw?.summary ?? raw?.report, 300) };
}
export function summarisePitra(raw: any) {
  return { present: yesNo(raw?.is_pitri_dosha_present ?? raw?.is_present), note: s(raw?.conclusion ?? raw?.report, 300) };
}

export function summariseRemedies(puja: any, gem: any, rud: any) {
  return {
    puja: s(puja?.summary ?? puja?.suggestions?.[0]?.rite ?? puja?.suggestion ?? (puja ? JSON.stringify(puja) : ""), 300),
    gemstone: { life: s(gem?.LIFE?.gem_key ?? gem?.life?.gem_key), benefic: s(gem?.BENEFIC?.gem_key ?? gem?.benefic?.gem_key), lucky: s(gem?.LUCKY?.gem_key ?? gem?.lucky?.gem_key) },
    rudraksha: s(rud?.recommend ?? rud?.name ?? rud?.rudraksha_name ?? rud?.description, 200),
  };
}

export function summarisePanchang(p: any, ch: any) {
  const slots = (a: any) => arr(a).slice(0, 8).map((x) => `${s(x?.time)} ${s(x?.muhurta)}`.trim());
  return {
    tithi: s(p?.tithi), nakshatra: s(p?.nakshatra), yog: s(p?.yog), karan: s(p?.karan), sunrise: s(p?.sunrise), sunset: s(p?.sunset),
    rahukaal: s(p?.rahukaal ?? p?.rahu_kaal),
    day_chaughadiya: slots(ch?.chaughadiya?.day), night_chaughadiya: slots(ch?.chaughadiya?.night),
  };
}

export function summariseMuhurta(raw: any) {
  const list = arr(raw?.muhurta ?? raw?.dates ?? raw);
  return list.slice(0, 5).map((d) => (typeof d === "string" ? d : pick(d, ["date", "day", "start_time", "end_time", "time", "tithi", "nakshatra"])));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "OBJECT", properties, ...(required.length ? { required } : {}) });
const MUHURTA_PURPOSES = ["marriage", "griha_pravesh", "business_start", "travel", "vehicle_purchase", "property_purchase"] as const;
const MUHURTA_KEY = {
  marriage: "monthly_muhurta_marriage", griha_pravesh: "monthly_muhurta_griha_pravesh", business_start: "monthly_muhurta_business_start",
  travel: "monthly_muhurta_travel", vehicle_purchase: "monthly_muhurta_vehicle_purchase", property_purchase: "monthly_muhurta_property_purchase",
} as const;

const getMyChart: VoiceTool = {
  blocking: true,
  decl: { name: "get_my_chart", description: "Read the customer's birth chart (kundli): lagna, moon sign, nakshatra and planet placements. Uses the saved birth details.", parameters: obj({}) },
  async run(ctx) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const [bd, ad, pl] = await Promise.all([call(ctx, "birth_details", b.body), call(ctx, "astro_details", b.body), call(ctx, "planets", b.body)]);
    if (!ad.ok) return failOf(ad);
    const a = ad.data ?? {};
    const lagna = s(arr(pl.ok ? pl.data : []).find((p: any) => /ascendant/i.test(s(p?.name)))?.sign);
    const out = {
      approximate: b.approximate,
      birth: bd.ok ? pick(bd.data, ["sunrise", "sunset", "ayanamsha"]) : undefined,
      lagna: lagna || undefined,
      rashi: s(a.sign), nakshatra: s(a.Naksahtra ?? a.nakshatra), charan: s(a.Charan ?? a.charan),
      sign_lord: s(a.SignLord ?? a.sign_lord), varna: s(a.Varna ?? a.varna), gan: s(a.Gan ?? a.gan), nadi: s(a.Nadi ?? a.nadi),
      planets: pl.ok ? summarisePlanets(pl.data) : undefined,
    };
    ctx.showCard?.({ title: "Your chart", items: [
      { label: "Lagna", value: b.approximate ? `${lagna || "-"} (approx.)` : lagna || "-" },
      { label: "Rashi", value: out.rashi || "-" }, { label: "Nakshatra", value: out.nakshatra || "-" },
    ] });
    return out;
  },
};

const getCurrentDasha: VoiceTool = {
  blocking: true,
  decl: { name: "get_current_dasha", description: "Current Vimshottari dasha: Mahadasha, Antardasha and when it ends.", parameters: obj({}) },
  async run(ctx) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const r = await call(ctx, "current_vdasha", b.body);
    if (!r.ok) return failOf(r);
    const d = summariseDasha(r.data);
    ctx.showCard?.({ title: "Your dasha", items: [
      { label: "Mahadasha", value: d.mahadasha || "-" }, { label: "Antardasha", value: d.antardasha || "-" }, { label: "Until", value: d.until || "-" },
    ] });
    return { approximate: b.approximate, ...d };
  },
};

const checkDoshas: VoiceTool = {
  blocking: true,
  decl: {
    name: "check_doshas", description: "Check doshas in the customer's chart: manglik, kalsarpa, sadhesati, pitra or all.",
    parameters: obj({ which: { type: "STRING", enum: ["manglik", "kalsarpa", "sadhesati", "pitra", "all"], description: "Which dosha; default all" } }),
  },
  async run(ctx, args) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const which = ["manglik", "kalsarpa", "sadhesati", "pitra", "all"].includes(String(args.which)) ? String(args.which) : "all";
    const want = (k: string) => which === "all" || which === k;
    const out: Record<string, unknown> = { approximate: b.approximate };
    const errors: string[] = [];
    const jobs: Promise<void>[] = [];
    const run = (k: string, key: keyof typeof ASTRO_ENDPOINTS, f: (d: any) => unknown) => {
      if (!want(k)) return;
      jobs.push(call(ctx, key, b.body).then((r) => { if (r.ok) out[k] = f(r.data); else errors.push(`${k}: ${r.error}`); }));
    };
    run("manglik", "manglik", summariseManglik);
    run("kalsarpa", "kalsarpa_details", summariseKalsarpa);
    run("sadhesati", "sadhesati_current_status", summariseSadhesati);
    run("pitra", "pitra_dosha_report", summarisePitra);
    await Promise.all(jobs);
    if (errors.length && Object.keys(out).length === 1) return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
    if (errors.length) out.unavailable = errors;
    ctx.showCard?.({ title: "Dosha check", items: Object.entries(out).filter(([k]) => k !== "approximate" && k !== "unavailable").map(([k, v]) => {
      const x = v as any; const flag = x?.present ?? x?.running;
      return { label: k, value: flag === true ? "Present" : flag === false ? "Not found" : "See notes" };
    }) });
    return out;
  },
};

const getRemedies: VoiceTool = {
  // Not blocking: remedies are an add-on; she can keep chatting while it loads and mention them when they arrive.
  blocking: false,
  decl: { name: "get_remedies", description: "Traditional remedy suggestions from the chart: puja, gemstone, rudraksha.", parameters: obj({}) },
  async run(ctx) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const [pj, gm, rd] = await Promise.all([call(ctx, "puja_suggestion", b.body), call(ctx, "basic_gem_suggestion", b.body), call(ctx, "rudraksha_suggestion", b.body)]);
    if (!pj.ok && !gm.ok && !rd.ok) return failOf(pj);
    return { approximate: b.approximate, ...summariseRemedies(pj.ok ? pj.data : null, gm.ok ? gm.data : null, rd.ok ? rd.data : null) };
  },
};

const getToday: VoiceTool = {
  blocking: true,
  decl: {
    name: "get_today", description: "Panchang and chaughadiya muhurta for a day at the customer's place (default today, IST).",
    parameters: obj({ date: { type: "STRING", description: "YYYY-MM-DD, optional" } }),
  },
  async run(ctx, args) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    let d: Date;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.date ?? ""));
    if (m) d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    else d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST "today"
    const body = { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear(), hour: 6, min: 0, lat: b.body.lat, lon: b.body.lon, tzone: b.body.tzone };
    const [pc, ch] = await Promise.all([call(ctx, "basic_panchang", body), call(ctx, "chaughadiya_muhurta", body)]);
    if (!pc.ok) return failOf(pc);
    const out = { date: `${body.year}-${pad(body.month)}-${pad(body.day)}`, place: s(b.profile.place), ...summarisePanchang(pc.data, ch.ok ? ch.data : null) };
    ctx.showCard?.({ title: "Today's panchang", items: [
      { label: "Tithi", value: out.tithi || "-" }, { label: "Nakshatra", value: out.nakshatra || "-" }, { label: "Rahukaal", value: out.rahukaal || "-" },
    ] });
    return out;
  },
};

const findMuhurta: VoiceTool = {
  blocking: true,
  decl: {
    name: "find_muhurta", description: "Find auspicious dates in a month for an occasion, at the customer's place.",
    parameters: obj({
      purpose: { type: "STRING", enum: [...MUHURTA_PURPOSES] },
      month: { type: "INTEGER", description: "1-12" }, year: { type: "INTEGER", description: "e.g. 2026" },
    }, ["purpose", "month", "year"]),
  },
  async run(ctx, args) {
    const purpose = String(args.purpose) as keyof typeof MUHURTA_KEY;
    if (!(purpose in MUHURTA_KEY)) return { error: "bad_purpose", hint: `one of ${MUHURTA_PURPOSES.join(", ")}` };
    const month = Math.trunc(Number(args.month)), year = Math.trunc(Number(args.year));
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) return { error: "bad_month_or_year" };
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    // UNVERIFIED body shape: month/year plus the place; confirm against the live API.
    const r = await call(ctx, MUHURTA_KEY[purpose], { month, year, lat: b.body.lat, lon: b.body.lon, tzone: b.body.tzone });
    if (!r.ok) return failOf(r);
    const dates = summariseMuhurta(r.data);
    ctx.showCard?.({ title: `Good dates: ${purpose.replace(/_/g, " ")}`, items: dates.slice(0, 5).map((x, i) => ({ label: String(i + 1), value: typeof x === "string" ? x : Object.values(x).join(" ") })) });
    return { purpose, month, year, dates };
  },
};

const matchPartner: VoiceTool = {
  blocking: true,
  decl: {
    name: "match_partner", description: "Kundli matching (ashtakoot, 36 points) between the customer and a partner. The customer's own details are saved; ask for the partner's.",
    parameters: obj({
      partner_name: { type: "STRING" },
      dob: { type: "STRING", description: "Partner date of birth, YYYY-MM-DD" },
      tob: { type: "STRING", description: "Partner time of birth HH:MM 24h, optional" },
      place: { type: "STRING", description: "Partner place of birth" },
    }, ["dob", "place"]),
  },
  async run(ctx, args) {
    const b = await loadBirth(ctx);
    if (isFail(b)) return b;
    const g = (b.profile.gender ?? "").toLowerCase();
    if (g !== "male" && g !== "female") return { error: "gender_unknown", hint: "ask the customer whether they are male or female, then call save_birth_details with gender" };
    const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.dob ?? ""));
    if (!dob) return { error: "bad_partner_dob", hint: "ask for the partner's date of birth" };
    const place = s(args.place, 120);
    if (!place) return { error: "no_partner_place", hint: "ask for the partner's place of birth" };
    const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(args.tob ?? ""));
    const partnerApprox = !tm;
    const geo = await geoLookup(ctx.env, place, 1, ctx.uid);
    if (!geo.ok || !geo.data.length) return { error: "partner_place_not_found", hint: "ask for a nearby larger town or city" };
    const pl = geo.data[0];
    const z = await tzoneFor(ctx.env, pl.lat, pl.lon, `${dob[3]}-${dob[2]}-${dob[1]}`, ctx.uid);
    const partner: NatalBody = { day: Number(dob[3]), month: Number(dob[2]), year: Number(dob[1]), hour: tm ? Number(tm[1]) : 12, min: tm ? Number(tm[2]) : 0, lat: pl.lat, lon: pl.lon, tzone: z.ok ? z.data : 5.5 };
    const me = b.body;
    const pre = (p: string, n: NatalBody) => ({ [`${p}_day`]: n.day, [`${p}_month`]: n.month, [`${p}_year`]: n.year, [`${p}_hour`]: n.hour, [`${p}_min`]: n.min, [`${p}_lat`]: n.lat, [`${p}_lon`]: n.lon, [`${p}_tzone`]: n.tzone });
    // UNVERIFIED field names: m_*/f_* (day, month, year, hour, min, lat, lon, tzone) per AstrologyAPI naming. Male = groom side.
    const body = g === "male" ? { ...pre("m", me), ...pre("f", partner) } : { ...pre("m", partner), ...pre("f", me) };
    const [pts, mg] = await Promise.all([call(ctx, "match_ashtakoot_points", body), call(ctx, "match_manglik_report", body)]);
    if (!pts.ok) return failOf(pts);
    const d = pts.data ?? {};
    const total = d.total ?? d.score ?? d.received_points ?? null;
    const totalNum = total && typeof total === "object" ? (total.received_points ?? total.points ?? null) : total;
    const out = {
      partner: s(args.partner_name, 60) || undefined,
      approximate: b.approximate || partnerApprox,
      score: totalNum != null ? `${totalNum} out of ${s(total?.total_points ?? total?.minimum ?? d.out_of ?? 36)}` : undefined,
      conclusion: s(d.conclusion?.report ?? d.conclusion ?? d.ashtakoot?.conclusion, 300) || undefined,
      manglik: mg.ok ? s(mg.data?.conclusion?.report ?? mg.data?.manglik_report ?? mg.data?.conclusion, 300) : undefined,
    };
    ctx.showCard?.({ title: "Kundli matching", items: [{ label: "Ashtakoot", value: out.score ?? "-" }, ...(out.manglik ? [{ label: "Manglik", value: out.manglik.slice(0, 80) }] : [])] });
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------
export const astrologyAgent: VoiceAgentDef = {
  id: "astrology",
  name: "Meera",
  subject: "Astrology",
  voice: ASTROLOGY_VOICE,
  language: "hi-IN",
  systemPrompt: ({ briefing, brandName, nowIst }) => systemPrompt({ briefing, brandName: brandName || BRAND.name, nowIst }),
  tools: [getMyChart, getCurrentDasha, checkDoshas, getRemedies, getToday, findMuhurta, matchPartner],
  ui: { initial: "M", tint: "#07545b", blurb: "Kundli, dasha, doshas, good dates" },
};

export default astrologyAgent;
