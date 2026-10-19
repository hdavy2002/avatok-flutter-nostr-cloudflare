// [HF-WIRE-18] HF-REEL-37: influencers set their own per-minute rate (default and lowest Rs 5, server max PRICE_MAX).
// Targeted switch: hfStdPlanEnabled keeps governing the rupee wallet, top-up packs and GST. Only HOST PRICING bypasses the
// fixed Standard tariff when hfInfluencerSetsRate is on. Split follows HF-REEL-30 (callSplit: platform keeps Rs 2/min + 40% of the rest).
import type { HfStdPlan } from "./hf_token_config";
import { PRICE_MAX } from "./hf_options";

export const INFLUENCER_RATE_DEFAULT_PAISE = 500;
export const INFLUENCER_RATE_MIN_PAISE = 500;

export interface InfluencerRate { on: boolean; defaultRupees: number; minRupees: number; maxRupees: number }

const rupeesFrom = (v: unknown, fb: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN;
  return Number.isInteger(n) && n >= 100 && n % 100 === 0 && n / 100 <= PRICE_MAX ? n / 100 : fb / 100;
};

export function readInfluencerRate(cfg: Record<string, unknown> | null | undefined): InfluencerRate {
  const c = cfg ?? {};
  const minRupees = rupeesFrom(c.hfMinRatePaise, INFLUENCER_RATE_MIN_PAISE);
  const def = rupeesFrom(c.hfDefaultRatePaise, INFLUENCER_RATE_DEFAULT_PAISE);
  return { on: c.hfInfluencerSetsRate === true, minRupees, defaultRupees: Math.max(def, minRupees), maxRupees: PRICE_MAX };
}

/** Std plan as seen by host-pricing code: with hfInfluencerSetsRate on the fixed tariff is switched off for pricing only. */
export function pricingStd(std: HfStdPlan, cfg: Record<string, unknown> | null | undefined): HfStdPlan {
  return std.enabled && readInfluencerRate(cfg).on ? { ...std, enabled: false } : std;
}
