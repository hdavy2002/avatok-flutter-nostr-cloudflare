// [AUMFE-ASTRO-CLIENT-1] Registry of the AstrologyAPI JSON endpoints we plan to use. `ttl` is the cache policy
// astroCall should be given: natal data = forever, time-dependent data = day (IST midnight), none = never.
// verified:false = path not yet confirmed against the live API (do not rely on it without a test call).
import type { AstroTtl } from "./cache";

export interface AstroEndpoint { path: string; purpose: string; ttl: AstroTtl; verified: boolean; /** body shape */ input: "natal" | "match" | "date" | "custom" }

const E = (path: string, purpose: string, ttl: AstroTtl, input: AstroEndpoint["input"] = "natal", verified = true): AstroEndpoint =>
  ({ path, purpose, ttl, verified, input });

export const ASTRO_ENDPOINTS = {
  birth_details: E("birth_details", "Basic birth data: sunrise/sunset, ayanamsha.", "forever"),
  astro_details: E("astro_details", "Varna, vashya, yoni, gan, nadi, sign, nakshatra, charan.", "forever"),
  planets: E("planets", "Planet positions in the natal chart.", "forever"),
  current_vdasha: E("current_vdasha", "Current Vimshottari dasha/antardasha: changes over time.", "day"),
  major_vdasha: E("major_vdasha", "Full list of major Vimshottari dashas.", "forever"),
  sub_vdasha: E("sub_vdasha/:md", "Sub-periods inside one major dasha (append the dasha lord).", "forever", "natal", false),
  manglik: E("manglik", "Manglik dosha check.", "forever"),
  kalsarpa_details: E("kalsarpa_details", "Kalsarpa dosha check.", "forever"),
  sadhesati_current_status: E("sadhesati_current_status", "Is Sade Sati running now: changes over time.", "day"),
  sadhesati_remedies: E("sadhesati_remedies", "Sade Sati remedies.", "forever"),
  pitra_dosha_report: E("pitra_dosha_report", "Pitra dosha report.", "forever"),
  puja_suggestion: E("puja_suggestion", "Puja suggestions from the chart (feeds puja upsell).", "forever"),
  basic_gem_suggestion: E("basic_gem_suggestion", "Life/benefic/lucky gemstone suggestion.", "forever"),
  rudraksha_suggestion: E("rudraksha_suggestion", "Rudraksha suggestion.", "forever"),
  basic_panchang: E("basic_panchang", "Today's panchang for a place.", "day"),
  chaughadiya_muhurta: E("chaughadiya_muhurta", "Chaughadiya muhurta for a day.", "day"),
  monthly_muhurta_marriage: E("monthly_muhurta/marriage", "Auspicious marriage dates in a month.", "day", "date", false),
  monthly_muhurta_griha_pravesh: E("monthly_muhurta/griha_pravesh", "Auspicious griha pravesh dates.", "day", "date", false),
  monthly_muhurta_business_start: E("monthly_muhurta/business_start", "Auspicious business-start dates.", "day", "date", false),
  monthly_muhurta_travel: E("monthly_muhurta/travel", "Auspicious travel dates.", "day", "date", false),
  monthly_muhurta_vehicle_purchase: E("monthly_muhurta/vehicle_purchase", "Auspicious vehicle-purchase dates.", "day", "date", false),
  monthly_muhurta_property_purchase: E("monthly_muhurta/property_purchase", "Auspicious property-purchase dates.", "day", "date", false),
  varshaphal_details: E("varshaphal_details", "Yearly (solar return) chart details; body also needs the year.", "forever", "natal", false),
  numero_table: E("numero_table", "Numerology table from name + birth date.", "forever", "custom"),
  numero_report: E("numero_report", "Numerology report from name + birth date.", "forever", "custom"),
  match_ashtakoot_points: E("match_ashtakoot_points", "Ashtakoot (36-point) compatibility score; body has m_* and f_* fields.", "forever", "match"),
  match_making_report: E("match_making_report", "Full match-making report.", "forever", "match"),
  match_manglik_report: E("match_manglik_report", "Manglik compatibility between two charts.", "forever", "match"),
  tarot_predictions: E("tarot_predictions", "Tarot card draw with predictions: random, never cache.", "none", "custom"),
  yes_no_tarot: E("yes_no_tarot", "Yes/no tarot answer: random, never cache.", "none", "custom"),
  sun_sign_prediction_daily: E("sun_sign_prediction/daily/:sign", "Daily horoscope for a sun sign (append aries..pisces).", "day", "custom"),
  geo_details: E("geo_details", "Place text -> lat/lon/timezone_id candidates. Body {place, maxRows}.", "forever", "custom"),
  timezone_with_dst: E("timezone_with_dst", "UTC offset (with DST) for lat/lon on a date.", "forever", "custom"),
} as const satisfies Record<string, AstroEndpoint>;

export type AstroEndpointKey = keyof typeof ASTRO_ENDPOINTS;

/** Natal request body shared by all `natal` endpoints. tzone is hours from UTC (5.5 for India). */
export interface NatalBody { day: number; month: number; year: number; hour: number; min: number; lat: number; lon: number; tzone: number }

export const SUN_SIGNS = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"] as const;
