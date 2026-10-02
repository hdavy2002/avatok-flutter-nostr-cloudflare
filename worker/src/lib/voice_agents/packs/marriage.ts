// [AUMFE-VOICE-PACKS-1 2026-10-02] Marriage (kundli matching) tool pack: match_partner.
// lib/guides/astro_tools.ts already has a match_partner (ashtakoot + manglik, partner dob/place/tob). It is REUSED here
// for everything it exports: loadBirth (the caller's saved birth data, place -> lat/lon/tzone), geoLookup/tzoneFor for the
// partner's place, and the same body shape. This pack's own match_partner exists because the owner's spec needs more than
// that tool returns (dashakoot, manglik for BOTH people, match_making_report, partner_gender, "time unknown"), and the
// shared brain is owned by another session so it is not edited. The model never supplies the CUSTOMER's birth data.
//
// Verified live against json.astrologyapi.com on 2026-10-02 (body m_*/f_* = day, month, year, hour, min, lat, lon, tzone; m = groom):
//   match_ashtakoot_points  -> {varna,vashya,tara,yoni,maitri,gan,bhakut,nadi: {total_points, received_points, male_koot_attribute, ...},
//                               total:{total_points:36, received_points, minimum_required:18}, conclusion:{status, report}}
//   match_dashakoot_points  -> {dina,gana,yoni,rashi,rasyadhipati,rajju,vedha,vashya,mahendra,streeDeergha: {...}, total:{total_points:36, received_points, minimum_required:18}}
//   match_manglik_report    -> {male:{is_present, manglik_status, percentage_manglik_after_cancellation, is_mars_manglik_cancelled, manglik_report, ...}, female:{...}, conclusion:{match, report}}
//   match_making_report     -> {ashtakoota:{status, received_points}, manglik:{status, male_percentage, female_percentage}, rajju_dosha:{status}, vedha_dosha:{status}, conclusion:{match_report}}
import { geoLookup, tzoneFor } from "../../astrology";
import type { NatalBody } from "../../astrology";
import { GUIDE_RULES } from "../../guides/brain";
import { isFail as birthFail, loadBirth } from "../../guides/astro_tools";
import type { VoiceTool } from "../types";
import type { VoiceToolPack } from "../tool_packs";
import { api, brainTools, clip, failOf, lazyTools, obj, parseDob, txt } from "./common";

type Side = "male" | "female";

/** m_* = the male (groom) side, f_* = the female (bride) side. */
export function buildMatchBody(customerSide: Side, customer: NatalBody, partner: NatalBody): Record<string, number> {
  const pre = (p: "m" | "f", n: NatalBody) => ({
    [`${p}_day`]: n.day, [`${p}_month`]: n.month, [`${p}_year`]: n.year, [`${p}_hour`]: n.hour, [`${p}_min`]: n.min,
    [`${p}_lat`]: n.lat, [`${p}_lon`]: n.lon, [`${p}_tzone`]: n.tzone,
  });
  return customerSide === "male" ? { ...pre("m", customer), ...pre("f", partner) } : { ...pre("m", partner), ...pre("f", customer) };
}

const KOOT_KEYS = ["varna", "vashya", "tara", "yoni", "maitri", "gan", "bhakut", "nadi"] as const;

const pts = (t: any): { received: number; total: number; minimum: number } | null => {
  const received = Number(t?.received_points), total = Number(t?.total_points ?? 36);
  return Number.isFinite(received) ? { received, total: Number.isFinite(total) ? total : 36, minimum: Number(t?.minimum_required ?? 18) } : null;
};

export function summariseAshtakoot(d: any) {
  const t = pts(d?.total);
  const zero = KOOT_KEYS.filter((k) => Number(d?.[k]?.received_points) === 0 && Number(d?.[k]?.total_points) > 0);
  const full = KOOT_KEYS.filter((k) => Number(d?.[k]?.total_points) > 0 && Number(d?.[k]?.received_points) === Number(d?.[k]?.total_points));
  return {
    score: t ? `${t.received} out of ${t.total}` : undefined,
    minimum_needed: t ? t.minimum : undefined,
    enough: t ? t.received >= t.minimum : undefined,
    koots_with_zero: zero.length ? zero : undefined,
    koots_full: full.length ? full : undefined,
    note: clip(d?.conclusion?.report, 260) || undefined,
  };
}

export function summariseDashakoot(d: any) {
  const t = pts(d?.total);
  return t ? { score: `${t.received} out of ${t.total}`, minimum_needed: t.minimum, enough: t.received >= t.minimum } : undefined;
}

const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v == null ? undefined : /^(true|yes|1)$/i.test(String(v)));

export function summariseManglikSide(m: any) {
  return {
    manglik: flag(m?.is_present),
    strength: txt(m?.manglik_status, 40) || undefined,
    percent_after_cancellation: Number.isFinite(Number(m?.percentage_manglik_after_cancellation)) ? Number(m.percentage_manglik_after_cancellation) : undefined,
    cancelled: flag(m?.is_mars_manglik_cancelled),
    note: clip(m?.manglik_report, 160) || undefined,
  };
}

export function summariseManglikMatch(d: any, customerSide: Side) {
  const mine = customerSide === "male" ? d?.male : d?.female;
  const theirs = customerSide === "male" ? d?.female : d?.male;
  return {
    customer: summariseManglikSide(mine),
    partner: summariseManglikSide(theirs),
    balanced: flag(d?.conclusion?.match),
    note: clip(d?.conclusion?.report, 260) || undefined,
  };
}

export function summariseMakingReport(d: any) {
  return {
    rajju_dosha: flag(d?.rajju_dosha?.status),
    vedha_dosha: flag(d?.vedha_dosha?.status),
    verdict: clip(d?.conclusion?.match_report, 300) || undefined,
  };
}

const norm = (v: unknown): Side | null => { const g = String(v ?? "").trim().toLowerCase(); return g === "male" || g === "female" ? g : null; };

export const matchPartner: VoiceTool = {
  blocking: true,
  decl: {
    name: "match_partner",
    description: "Kundli matching between the customer and a partner: ashtakoot (36 points), dashakoot, manglik for both, rajju and vedha. The customer's own details are saved; ask for the PARTNER's date of birth, time of birth (or that it is unknown) and place of birth.",
    parameters: obj({
      partner_name: { type: "STRING", description: "Partner's first name, optional." },
      dob: { type: "STRING", description: "Partner date of birth, YYYY-MM-DD" },
      tob: { type: "STRING", description: "Partner time of birth HH:MM 24h. Omit when unknown." },
      tob_unknown: { type: "BOOLEAN", description: "true when the partner's birth time is not known" },
      place: { type: "STRING", description: "Partner place of birth (town or city)" },
      partner_gender: { type: "STRING", enum: ["male", "female"], description: "Partner's gender. Needed only when the customer's gender is not saved." },
    }, ["dob", "place"]),
  },
  async run(ctx, args) {
    const b = await loadBirth(ctx);
    if (birthFail(b)) return b;
    const partnerGender = norm(args.partner_gender);
    let side = norm(b.profile.gender);
    if (!side && partnerGender) side = partnerGender === "male" ? "female" : "male"; // matching is groom/bride: the other side
    if (!side) return { error: "gender_unknown", hint: "ask the customer whether they are male or female, then call save_birth_details with gender (or pass partner_gender)" };

    const dob = parseDob(args.dob);
    if (!dob) return { error: "bad_partner_dob", hint: "ask for the partner's date of birth" };
    const place = txt(args.place, 120);
    if (!place) return { error: "no_partner_place", hint: "ask for the partner's place of birth" };
    const tm = args.tob_unknown === true ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(args.tob ?? ""));
    const partnerApprox = !tm;

    const geo = await geoLookup(ctx.env, place, 1, ctx.uid);
    if (!geo.ok || !geo.data.length) return { error: "partner_place_not_found", hint: "ask for a nearby larger town or city" };
    const pl = geo.data[0];
    const pad = (n: number) => String(n).padStart(2, "0");
    const z = await tzoneFor(ctx.env, pl.lat, pl.lon, `${pad(dob.day)}-${pad(dob.month)}-${dob.year}`, ctx.uid);
    const partner: NatalBody = { ...dob, hour: tm ? Number(tm[1]) : 12, min: tm ? Number(tm[2]) : 0, lat: pl.lat, lon: pl.lon, tzone: z.ok ? z.data : 5.5 };
    const body = buildMatchBody(side, b.body, partner);

    const [ash, dash, mg, rep] = await Promise.all([
      api(ctx, "match_ashtakoot_points", body, "forever"),
      api(ctx, "match_dashakoot_points", body, "forever"),
      api(ctx, "match_manglik_report", body, "forever"),
      api(ctx, "match_making_report", body, "forever"),
    ]);
    if (!ash.ok) return failOf(ash);

    const out = {
      partner: txt(args.partner_name, 60) || undefined,
      approximate: b.approximate || partnerApprox,
      ashtakoot: summariseAshtakoot(ash.data),
      dashakoot: dash.ok ? summariseDashakoot(dash.data) : undefined,
      manglik: mg.ok ? summariseManglikMatch(mg.data, side) : undefined,
      other_doshas: rep.ok ? summariseMakingReport(rep.data) : undefined,
    };
    ctx.showCard?.({ title: "Kundli matching", items: [
      { label: "Ashtakoot", value: out.ashtakoot.score ?? "-" },
      ...(out.dashakoot ? [{ label: "Dashakoot", value: out.dashakoot.score }] : []),
      ...(out.manglik ? [{ label: "Manglik", value: `${out.manglik.customer.manglik === true ? "You: yes" : out.manglik.customer.manglik === false ? "You: no" : "You: -"}, ${out.manglik.partner.manglik === true ? "partner: yes" : out.manglik.partner.manglik === false ? "partner: no" : "partner: -"}` }] : []),
    ] });
    return out;
  },
};

export function marriageBaseRules(brandName: string): string {
  return `MARRIAGE MATCHING (Kundli Milan)
- Your own birth details are saved on file. New customer with none: gently ask their name, date of birth, time of birth (or that it is unknown), place of birth and whether they are male or female, one at a time, then call save_birth_details with gender included.
- For the partner, ask one thing at a time: date of birth, time of birth (or unknown), place of birth. The partner's details are not stored; use them only for match_partner. Then call match_partner once.
- If a time of birth is unknown, say the result is approximate and that a pandit can refine it with the exact time.
- Speak the tool's numbers plainly: ashtakoot out of 36 (tradition treats 18 or more as acceptable), dashakoot out of 36, manglik for both people, and any koot that scored zero. Do not read the whole table aloud.
- Matching is one input, never a verdict. Never tell anyone to marry, not to marry, or to end a relationship. Never say a match "will fail" or "will succeed". Low scores and manglik dosha are described calmly with what tradition holds, including that manglik is often considered balanced when both people have it or when the dosha is cancelled.
- No fear selling: do not frighten anyone about nadi, bhakut or manglik. Say a family pandit or a qualified astrologer can look at the full charts, and that mutual understanding, health and family values matter beyond points.
- Keep it respectful of the partner and of both families. If the customer is upset about a low score, acknowledge it and slow down.
- A suitable puja or havan offered by ${brandName} may be mentioned softly, only if search_catalog or recommend_for_chart returned it.

${GUIDE_RULES}`;
}

const tools = lazyTools(() => [matchPartner, ...brainTools(["search_catalog", "search_tradition", "recommend_for_chart"])]);

export const marriagePack: VoiceToolPack = {
  id: "marriage",
  label: "Marriage matching",
  description: "Kundli milan between the customer and a partner: ashtakoot and dashakoot points, manglik for both, rajju and vedha, with puja suggestions from the catalogue.",
  get tools() { return tools(); },
  baseRules: marriageBaseRules,
};
