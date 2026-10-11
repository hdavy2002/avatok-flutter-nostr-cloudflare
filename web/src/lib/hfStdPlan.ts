/* [HF-STD-PLAN-1] Standard calling plan helpers (one rate for every host). Mirrors the worker's math exactly:
 * sum(paisePerMin × seconds-in-band), divide by 60 ONCE, round half up. Contract: Specs/HF-STD-PLAN-1-CONTRACT.md.
 * The tiers below are only a fallback for static pages; live pages pass the tiers the worker sent (priceTiers / plan.tiers). */
import { formatPaise } from './money';

export interface PriceTier { fromMin: number; toMin: number | null; paisePerMin: number }

export const STD_TIERS: PriceTier[] = [
  { fromMin: 0, toMin: 30, paisePerMin: 399 },
  { fromMin: 30, toMin: 60, paisePerMin: 350 },
  { fromMin: 60, toMin: null, paisePerMin: 325 },
];
export const STD_START_PAISE_PER_MIN = 399;
export const STD_HOST_PAISE_PER_MIN = 200;
export const STD_START_MINUTES = 2;

/** Charge in paise for `seconds` of connected time under `tiers`. */
export function chargeForSeconds(tiers: PriceTier[] | null | undefined, seconds: number): number {
  const t = tiers && tiers.length ? tiers : STD_TIERS;
  const secs = Math.max(0, Math.floor(Number(seconds) || 0));
  let acc = 0;
  for (const b of t) {
    const from = b.fromMin * 60;
    const to = b.toMin == null ? Infinity : b.toMin * 60;
    const inBand = Math.max(0, Math.min(secs, to) - from);
    acc += b.paisePerMin * inBand;
  }
  return Math.floor((acc + 30) / 60); // half up, rounded once
}

/** "₹39.90" for 10 minutes on the Standard plan. */
export const tenMinuteLabel = (tiers?: PriceTier[] | null): string => formatPaise(chargeForSeconds(tiers, 600));
export const stdRateLabel = (paisePerMin: number = STD_START_PAISE_PER_MIN): string => `${formatPaise(paisePerMin)}/min`;

/** Rate card lines from live tiers: "₹3.99/min for the first 30 minutes", "… for the next 30 minutes", "… after 60 minutes". */
export function rateCardLines(tiers?: PriceTier[] | null): string[] {
  const t = tiers && tiers.length ? tiers : STD_TIERS;
  return t.map((b, i) => {
    const rate = `${formatPaise(b.paisePerMin)}/min`;
    if (b.toMin == null) return `${rate} after ${b.fromMin} minutes`;
    return `${rate} for the ${i === 0 ? 'first' : 'next'} ${b.toMin - b.fromMin} minutes`;
  });
}
export const RATE_CARD_NOTE = 'Billed per second of connected time. Ringing or no answer costs nothing.';
export const SAME_RATE_LINE = 'Same rate for every host · lower on long calls';
/** Safe build-time fallback only. Runtime/API plan fields are authoritative; never enable Standard by baking it into the web bundle. */
export const STD_PLAN_ON = false;
