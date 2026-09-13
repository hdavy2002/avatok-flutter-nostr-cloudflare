// [MKT-PROMO-CHECKOUT-1] Listing promotions, in ONE place.
//
// `promosFor` + `activePromoPct` used to be private to routes/listings.ts, which
// meant the marketplace card and the legacy book route applied discounts while the
// commercial checkout lane (routes/commercial_checkout.ts) charged full list price —
// the buyer saw one number on the card and was debited another. Both lanes now import
// the SAME two functions from here, so a change to the discount rule can never again
// apply to one lane and not the other. Extracted verbatim; no behaviour changed.

import type { Env } from "../types";
import { metaSession, metaDb } from "../db/shard";
import { MIN_PRICE_TOKENS_PER_HOUR } from "./session_pricing";

/**
 * [MKT-PROMO-READ-1 / M3] WHICH COPY OF D1 A PROMO IS READ FROM.
 *
 * `metaSession(env)` is `withSession("first-unconstrained")` — a stale-tolerant read that
 * may be served by a REPLICA. That is correct and cheap for the marketplace cards, where
 * a promotion is cosmetic: the worst case is a card that advertises a discount a second
 * after it ended, and the checkout lane re-resolves anyway.
 *
 * It is NOT correct for the lane that decides what a buyer is debited. The `used` counter
 * is bumped against the PRIMARY (`metaDb`), so a replica read can return a `used` that is
 * behind by one or more and let a `max_uses=1` promo be redeemed twice; and during the
 * replication lag after the creator wizard's delete-then-insert, BOTH the old and the new
 * row can come back at once, at which point `activePromoPct` picks `max(pct_off)` and
 * keeps selling at the OLD, bigger discount.
 *
 * So the read target is now explicit. `"replica"` is the default, which keeps every
 * existing card call site in routes/listings.ts byte-identical in behaviour; the money
 * lanes pass `"primary"`.
 */
export type PromoReadTarget = "replica" | "primary";

/** Fetch promos for a page of listing ids (one IN query, no N+1). */
export async function promosFor(
  env: Env,
  ids: string[],
  readFrom: PromoReadTarget = "replica",
): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  if (!ids.length) return map;
  const db = readFrom === "primary" ? metaDb(env) : metaSession(env);
  const rs = await db.prepare(
    `SELECT id, listing_id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions
      WHERE listing_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...ids).all();
  for (const p of (rs.results ?? []) as any[]) {
    if (!map.has(p.listing_id)) map.set(p.listing_id, []);
    map.get(p.listing_id)!.push(p);
  }
  return map;
}

/**
 * [M3] The charging lanes' read. Identical query, PRIMARY copy.
 *
 * A separate exported function rather than a flag every card call site has to remember:
 * "which promos apply" and "which promos may I take money against" are different
 * questions, and the money one must be impossible to ask by accident on a replica.
 */
export async function promosForCharging(env: Env, ids: string[]): Promise<Map<string, any[]>> {
  return promosFor(env, ids, "primary");
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

export type PromoChargePrice = {
  /** What the buyer is actually debited, after the discount AND the price floor. */
  chargePrice: number;
  /** True when the floor, not the promotion, decided the number. */
  clamped: boolean;
  /** The discounted price the promotion asked for, before the floor. Telemetry only. */
  discounted: number;
};

/**
 * [MKT-PROMO-FLOOR-1 / M4] Apply a promotion percentage to a LIST price, then refuse to
 * go below the paid-session price floor.
 *
 * `MIN_PRICE_TOKENS_PER_HOUR` (49) exists because `sessionFeeFor` charges a ₹25 FLAT fee
 * per participant per hour before its 20% commission: below ~₹31 the flat fee eats the
 * whole price, `creatorAmount` lands on 0, and the platform silently keeps 100% of a sale
 * the creator thinks they made. The floor was only ever enforced at listing create/edit,
 * on the LIST price — a promotion then walked straight past it (₹49 at 90% off ⇒ ₹5 ⇒ fee
 * 5, creator 0). The legs still sum to gross, so the settlement integrity check passes and
 * nothing anywhere says a word.
 *
 * The rule: a listing whose LIST price cleared the floor may not be discounted below it.
 * The buyer still gets the biggest discount that is honest (down to ₹49), the creator is
 * never silently zeroed, and the ₹0 lane stays exactly where it belongs — a genuinely free
 * listing goes through `free_entry`, whose list price is 0 and therefore never reaches the
 * floor at all.
 */
export function promoChargePrice(listPrice: number, pct: number): PromoChargePrice {
  const list = Math.max(0, Math.trunc(Number(listPrice) || 0));
  const p = Math.min(100, Math.max(0, Math.trunc(Number(pct) || 0)));
  const discounted = p > 0 ? Math.round(list * (100 - p) / 100) : list;
  // A free_entry / ₹0 listing (or any listing already grandfathered below the floor) is
  // left alone: the floor may only ever pull a price UP toward what the creator published,
  // never above it.
  if (list >= MIN_PRICE_TOKENS_PER_HOUR && discounted < MIN_PRICE_TOKENS_PER_HOUR) {
    return { chargePrice: MIN_PRICE_TOKENS_PER_HOUR, clamped: true, discounted };
  }
  return { chargePrice: discounted, clamped: false, discounted };
}
