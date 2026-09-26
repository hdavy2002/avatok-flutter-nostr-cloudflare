// [PRICING-1 2026-09-26] "Starting from" prices come from the backend
// (worker/src/routes/pricing.ts, edited at /admin/pricing) — never hardcode a
// price in an article, the homepage or the share card again.
//
// Three readers:
//   1. The build — prerendered pages bake in the price that was live at build time.
//   2. The browser — public/pricing.js (loaded by pages that show a price) re-reads
//      /api/pricing and rewrites every [data-saathum-price] element, so a price
//      change shows on every article within a minute, with no rebuild.
//   3. The OG card endpoint — reads the live price per request.
//
// Wording is always "starting from ₹X": checkout adds prasad delivery, GST,
// donation, chadhava and other options, so this is a floor, not a total.
import { API_BASE } from './config';

export type Pricing = {
  currency: 'INR';
  havan_from: number | null;
  puja_from: number | null;
  rituals: Record<string, number>;
  updated_at?: number | null;
};

/** Used only if the pricing API cannot be reached. Keep in step with DEFAULT_PRICING in the worker. */
export const FALLBACK_PRICING: Pricing = { currency: 'INR', havan_from: 111, puja_from: null, rituals: {} };

let cached: { at: number; value: Pricing } | null = null;

export async function fetchPricing(timeoutMs = 2000): Promise<Pricing> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/pricing`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return FALLBACK_PRICING;
    const body = (await res.json()) as Partial<Pricing>;
    const value: Pricing = {
      currency: 'INR',
      havan_from: validPrice(body.havan_from),
      puja_from: validPrice(body.puja_from),
      rituals: Object.fromEntries(Object.entries(body.rituals ?? {}).filter(([, v]) => validPrice(v) !== null)) as Record<string, number>,
      updated_at: body.updated_at ?? null,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return FALLBACK_PRICING;
  } finally {
    clearTimeout(timer);
  }
}

function validPrice(v: unknown): number | null {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n > 0 ? n : null;
}

/** A ritual's floor: its own override, else the havan/puja floor, else null (show no price). */
export function ritualPrice(pricing: Pricing, ritual: { slug: string; type: 'havan' | 'puja' }): number | null {
  return pricing.rituals[ritual.slug] ?? (ritual.type === 'havan' ? pricing.havan_from : pricing.puja_from) ?? null;
}

export function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}
