// [PRICE-HOURLY-1 2026-09-05] Everything is priced PER HOUR.
// Spec: Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md §4,
// mirrored verbatim from Specs/listing-taxonomy.json `pricing`.
//
// This module owns exactly one question: given a per-hour price a creator
// sets (in tokens; 1 token = ₹1), what does avaTOK keep and what does the
// creator keep? It is a PURE function — no D1, no wallet — so both the
// listing-create/edit validation below and any future settlement code can
// import the same arithmetic instead of re-deriving it. Per the spec: "The
// server is the authority on money. The wizard shows the number; the worker
// recomputes it. Never let a client-computed fee reach a ledger row."
//
// ⚠️ This file lands the FORMULA and the CREATE/EDIT-TIME FLOOR CHECK only.
// It is NOT wired into session settlement (commercial_settlement.ts) or any
// ledger write — that is a separate, larger integration outside this slice.
// See the backend agent's report for [PRICE-HOURLY-1] for the exact reason.

/** Flat fee, in tokens, per participant, PER HOUR. */
export const FLAT_TOKENS_PER_HOUR = 25;

/** Commission percent taken off whatever remains after the flat fee. */
export const COMMISSION_PCT = 20;

/** Minimum price, in tokens per hour, the wizard/server will accept for a
 *  paid (non-free_entry) listing. Below this the flat fee eats the entire
 *  price and the creator earns nothing. */
export const MIN_PRICE_TOKENS_PER_HOUR = 49;

export type SessionFee = {
  /** What avaTOK keeps, in tokens, for one participant for one hour. */
  fee: number;
  /** What the creator keeps, in tokens, for one participant for one hour. */
  creator: number;
};

/**
 * fee = FLAT + round((price - FLAT) * COMMISSION / 100); creator = price - fee.
 * `price` is per hour, per participant, in tokens. A price below FLAT (which
 * should never reach this function once the MIN_PRICE floor is enforced)
 * clamps the fee to the price itself, so `creator` is never negative.
 */
export function sessionFeeFor(price: number): SessionFee {
  const p = Math.max(0, Math.trunc(Number(price) || 0));
  const fee = Math.min(p, FLAT_TOKENS_PER_HOUR + Math.round((p - FLAT_TOKENS_PER_HOUR) * COMMISSION_PCT / 100));
  return { fee, creator: p - fee };
}

/**
 * A 2-hour booking bills the flat portion of the fee twice (owner decision:
 * "per 1 hour") — this just multiplies the per-hour decision by the hour
 * count; it does not re-derive a different curve for longer bookings.
 */
export function sessionFeeForHours(price: number, hours: number): SessionFee {
  const h = Math.max(1, Math.trunc(Number(hours) || 1));
  const one = sessionFeeFor(price);
  return { fee: one.fee * h, creator: one.creator * h };
}

/**
 * Null when `price` clears the floor (or the listing is free_entry, which
 * bypasses price entirely — that is a different lane, see free_entry_gate.ts),
 * otherwise the exact sentence the wizard/API error should show. Kept
 * separate from the generic listingContentFieldsError() checks in
 * routes/listings.ts because it needs `freeEntry` to know whether to apply
 * at all, and because MIN_PRICE is a money rule that belongs next to the fee
 * formula it protects, not next to schedule/timezone validation.
 */
export function priceFloorError(price: unknown, freeEntry: boolean): string | null {
  if (freeEntry) return null;
  const p = Math.trunc(Number(price) || 0);
  if (p < MIN_PRICE_TOKENS_PER_HOUR) {
    return `Price must be at least ${MIN_PRICE_TOKENS_PER_HOUR} tokens/hour — below that the flat fee leaves you nothing.`;
  }
  return null;
}
