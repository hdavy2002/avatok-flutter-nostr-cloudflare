// [MKT-PROMO-CHECKOUT-1] Listing promotions, in ONE place.
//
// `promosFor` + `activePromoPct` used to be private to routes/listings.ts, which
// meant the marketplace card and the legacy book route applied discounts while the
// commercial checkout lane (routes/commercial_checkout.ts) charged full list price —
// the buyer saw one number on the card and was debited another. Both lanes now import
// the SAME two functions from here, so a change to the discount rule can never again
// apply to one lane and not the other. Extracted verbatim; no behaviour changed.

import type { Env } from "../types";
import { metaSession } from "../db/shard";

/** Fetch promos for a page of listing ids (one IN query, no N+1). */
export async function promosFor(env: Env, ids: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  if (!ids.length) return map;
  const rs = await metaSession(env).prepare(
    `SELECT id, listing_id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions
      WHERE listing_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...ids).all();
  for (const p of (rs.results ?? []) as any[]) {
    if (!map.has(p.listing_id)) map.set(p.listing_id, []);
    map.get(p.listing_id)!.push(p);
  }
  return map;
}

/** The single best applicable promotion: early-bird applies automatically, a
 *  `promo_code` promotion only when the submitted code matches (case-insensitive).
 *  Expired and used-up promos are skipped; the highest pct_off wins; 0..100 clamped. */
export function activePromoPct(promos: any[], now: number, code?: string | null): { pct: number; promo: any | null } {
  let best: any = null;
  for (const p of promos) {
    if (p.ends_at && now > Number(p.ends_at)) continue;
    if (p.max_uses != null && Number(p.used) >= Number(p.max_uses)) continue;
    if (p.kind === "promo_code" && (!code || String(p.code || "").toUpperCase() !== String(code).toUpperCase())) continue;
    if (!best || Number(p.pct_off) > Number(best.pct_off)) best = p;
  }
  return best ? { pct: Math.min(100, Math.max(0, Number(best.pct_off))), promo: best } : { pct: 0, promo: null };
}
