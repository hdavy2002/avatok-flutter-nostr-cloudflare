// [AUMFE-CONSULT-FOUNDATION-1] Price maths — pure. Owner decision 2026-10-02:
//   customer pays  = rate + 18% GST (rounded to the rupee)
//   platform fee   = 20% of the RATE
//   consultant gets = rate − fee   (₹1,000 → customer ₹1,180, fee ₹200, consultant ₹800)
import type { PriceBreakdown } from "./types";

export const GST_RATE_PCT = 18;
export const FEE_RATE_PCT = 20;
export const RATE_MIN = 100;
export const RATE_MAX = 50000;

export function priceFor(rate: number, gstPct = GST_RATE_PCT, feePct = FEE_RATE_PCT): PriceBreakdown {
  const r = Math.max(0, Math.round(rate));
  const gst = Math.round((r * gstPct) / 100);
  const fee = Math.round((r * feePct) / 100);
  return { rate: r, gst, total: r + gst, fee, payout: r - fee, gst_rate_pct: gstPct, fee_rate_pct: feePct };
}

export function validRate(rate: unknown, floor = RATE_MIN, ceil = RATE_MAX): rate is number {
  return typeof rate === "number" && Number.isInteger(rate) && rate >= floor && rate <= ceil;
}
