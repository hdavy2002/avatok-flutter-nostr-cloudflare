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
// The helpers below this authority retain the legacy listing/display contract.
// New commercial purchases use commercialQuoteFor; stored snapshots are never repriced.

export const COMMERCIAL_PRICING_VERSION = "commercial-inr-100-hour-v1";
export type CommercialFeePolicy = "creator_subtotal_plus_fee" | "included_platform_fee" | "legacy_percentage";
export type CommercialQuote = SessionSplit & {
  pricingVersion: typeof COMMERCIAL_PRICING_VERSION;
  feePolicy: CommercialFeePolicy;
  currency: "INR";
  moneyUnit: "whole_inr";
  rounding: "half_up_per_seat";
  bookedMinutes: number;
  paidSeats: number;
  seatBasis: "paid_customer_seat";
  priceBasis: "hourly" | "legacy_order";
  sourcePrice: number;
  policyCreatorFeePct: number | null;
  creatorSubtotal: number;
  platformFeePerSeat: number;
  gstRatePct: number;
  gstAmount: number;
  taxableBase: number;
  buyerTotal: number;
};

/** Integer ratio rounding avoids floating-point ties and unsafe intermediate products. */
export function roundMoneyRatio(amount: number, numerator: number, denominator: number): number {
  if (![amount, numerator, denominator].every(Number.isSafeInteger)
    || amount < 0 || numerator < 0 || denominator <= 0) throw new Error("invalid money ratio");
  const product = BigInt(amount) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const rounded = (product * 2n + divisor) / (divisor * 2n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("money overflow");
  return Number(rounded);
}

/** One quote authority for wallet, gateway and extension purchases. No provider inputs. */
export function commercialQuoteFor(args: {
  sourcePrice: number; bookedMinutes: number; paidSeats?: number;
  feePolicy?: CommercialFeePolicy; creatorFeePct?: number;
  gstRatePct: number; currency?: string;
}): CommercialQuote {
  const { sourcePrice, bookedMinutes, gstRatePct } = args;
  const paidSeats = args.paidSeats ?? (sourcePrice > 0 ? 1 : 0);
  const feePolicy = args.feePolicy ?? "creator_subtotal_plus_fee";
  if (![sourcePrice, bookedMinutes, paidSeats, gstRatePct].every(Number.isSafeInteger)
    || sourcePrice < 0 || bookedMinutes <= 0 || paidSeats < 0 || gstRatePct < 0 || gstRatePct > 100
    || (sourcePrice > 0) !== (paidSeats > 0) || (args.currency ?? "INR") !== "INR"
    || !["creator_subtotal_plus_fee", "included_platform_fee", "legacy_percentage"].includes(feePolicy)) {
    throw new Error("invalid commercial quote");
  }
  const perSeatSubtotal = feePolicy === "legacy_percentage"
    ? sourcePrice : roundMoneyRatio(sourcePrice, bookedMinutes, 60);
  const subtotal = roundMoneyRatio(perSeatSubtotal, paidSeats, 1);
  const platformFeePerSeat = paidSeats > 0 ? roundMoneyRatio(100, bookedMinutes, 60) : 0;
  let platformFeeAmount = roundMoneyRatio(platformFeePerSeat, paidSeats, 1);
  let creatorAmount = subtotal;
  let grossAmount = subtotal + platformFeeAmount;
  if (feePolicy === "legacy_percentage") {
    const pct = Number(args.creatorFeePct);
    if (!Number.isSafeInteger(pct) || pct < 0 || pct > 100) throw new Error("invalid creator percentage");
    creatorAmount = roundMoneyRatio(subtotal, pct, 100);
    platformFeeAmount = subtotal - creatorAmount;
    grossAmount = subtotal;
  } else if (feePolicy === "included_platform_fee") {
    if (subtotal < platformFeeAmount) throw new Error("commercial price below platform fee");
    creatorAmount = subtotal - platformFeeAmount;
    grossAmount = subtotal;
  }
  if (!Number.isSafeInteger(grossAmount)) throw new Error("money overflow");
  const gstAmount = roundMoneyRatio(grossAmount, gstRatePct, 100);
  const buyerTotal = grossAmount + gstAmount;
  // Every supported gateway transports minor units; reject overflow before any hold.
  if (!Number.isSafeInteger(buyerTotal * 100)) throw new Error("money overflow");
  return {
    pricingVersion: COMMERCIAL_PRICING_VERSION, feePolicy, currency: "INR", moneyUnit: "whole_inr",
    rounding: "half_up_per_seat", bookedMinutes, paidSeats, seatBasis: "paid_customer_seat",
    priceBasis: feePolicy === "legacy_percentage" ? "legacy_order" : "hourly", sourcePrice,
    policyCreatorFeePct: feePolicy === "legacy_percentage" ? Number(args.creatorFeePct) : null,
    creatorSubtotal: creatorAmount, platformFeePerSeat, grossAmount, creatorAmount, platformFeeAmount,
    creatorFeePct: grossAmount > 0 ? creatorAmount * 100 / grossAmount : (args.creatorFeePct ?? 0),
    gstRatePct, gstAmount, taxableBase: grossAmount, buyerTotal,
  };
}

/** Validate a frozen quote's integer identities, never apply today's price or config. */
export function commercialQuoteError(q: CommercialQuote): string | null {
  if (!q || q.pricingVersion !== COMMERCIAL_PRICING_VERSION || q.currency !== "INR"
    || q.moneyUnit !== "whole_inr" || q.seatBasis !== "paid_customer_seat"
    || q.rounding !== "half_up_per_seat") return "pricing snapshot version invalid";
  const amounts = [q.sourcePrice, q.creatorSubtotal, q.platformFeePerSeat, q.grossAmount,
    q.creatorAmount, q.platformFeeAmount, q.gstAmount, q.taxableBase, q.buyerTotal];
  if (!amounts.every(x => Number.isSafeInteger(x) && x >= 0)
    || !Number.isSafeInteger(q.buyerTotal * 100)
    || !Number.isSafeInteger(q.bookedMinutes) || q.bookedMinutes <= 0
    || !Number.isSafeInteger(q.paidSeats) || q.paidSeats < 0
    || (q.sourcePrice > 0) !== (q.paidSeats > 0)
    || !Number.isSafeInteger(q.gstRatePct) || q.gstRatePct < 0 || q.gstRatePct > 100
    || !Number.isFinite(q.creatorFeePct) || q.creatorFeePct < 0 || q.creatorFeePct > 100
    || !["creator_subtotal_plus_fee", "included_platform_fee", "legacy_percentage"].includes(q.feePolicy)
    || q.priceBasis !== (q.feePolicy === "legacy_percentage" ? "legacy_order" : "hourly")) return "pricing snapshot invalid";
  if (q.creatorAmount + q.platformFeeAmount !== q.grossAmount || q.creatorSubtotal !== q.creatorAmount
    || q.taxableBase !== q.grossAmount || q.grossAmount + q.gstAmount !== q.buyerTotal
    || q.gstAmount !== roundMoneyRatio(q.taxableBase, q.gstRatePct, 100)) return "pricing snapshot money mismatch";
  if (q.feePolicy !== "legacy_percentage"
    && (q.platformFeePerSeat !== (q.paidSeats ? roundMoneyRatio(100, q.bookedMinutes, 60) : 0)
      || q.platformFeeAmount !== q.platformFeePerSeat * q.paidSeats)) return "pricing snapshot fee mismatch";
  if (q.feePolicy === "legacy_percentage"
    && (!Number.isSafeInteger(q.policyCreatorFeePct) || Number(q.policyCreatorFeePct) < 0
      || Number(q.policyCreatorFeePct) > 100
      || q.creatorAmount !== roundMoneyRatio(q.grossAmount, Number(q.policyCreatorFeePct), 100))) {
    return "pricing snapshot percentage mismatch";
  }
  const sourceSubtotal = roundMoneyRatio(q.priceBasis === "hourly"
    ? roundMoneyRatio(q.sourcePrice, q.bookedMinutes, 60) : q.sourcePrice, q.paidSeats, 1);
  if (sourceSubtotal !== (q.feePolicy === "creator_subtotal_plus_fee" ? q.creatorAmount : q.grossAmount)) {
    return "pricing snapshot source mismatch";
  }
  return null;
}

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

/** [SETTLE-FEE-1] The split a checkout freezes into `commercial_policy_snapshots`. */
export type SessionSplit = {
  /** What the buyer paid and what the two legs below must add up to, exactly. */
  grossAmount: number;
  /** Tokens the creator is owed at settlement. */
  creatorAmount: number;
  /** Tokens avaTOK keeps. */
  platformFeeAmount: number;
  /**
   * The EFFECTIVE creator percentage this split works out to, e.g. 76.666… for
   * ₹600/hr. It is derived from `creatorAmount`, never the other way round: the
   * amounts are the authority and the percentage is a label on them. Stored so
   * `commercial_settlement.ts`'s authorityError() — which asserts
   * `creatorAmount === Math.round(gross * pct / 100)` — keeps holding, which is
   * why it is NOT rounded to an integer here.
   */
  creatorFeePct: number;
};

/**
 * [SETTLE-FEE-1] The one function checkout uses to freeze a paid session's split,
 * so what settlement pays out is the same arithmetic the listing wizard showed the
 * creator (`step_3_money.dart`: "At ₹600/hr, avaTOK takes ₹140 and you keep ₹460").
 *
 * `gross` is the whole amount the buyer is charged for this order (one seat / one
 * ticket) — which in the current checkout IS the listing's per-hour price, since
 * nothing multiplies it by the slot length. `durationMin` is the listing's slot
 * length: it is passed through sessionFeeForHours(), whose hour count floors and
 * clamps at 1, so a 30-minute slot bills one full hour exactly as the wizard says
 * ("A session shorter than an hour still bills the full hour") and a 2-hour slot
 * bills the flat ₹25 twice.
 *
 * The fee is clamped to `gross` so a grandfathered listing priced under the ₹49
 * floor can never produce a negative creator amount or break the
 * `creator + platform === gross` invariant settlement asserts.
 */
export function sessionSplitFor(gross: number, durationMin: number): SessionSplit {
  const g = Math.max(0, Math.trunc(Number(gross) || 0));
  const minutes = Math.max(1, Math.trunc(Number(durationMin) || 60));
  const fee = Math.min(g, sessionFeeForHours(g, minutes / 60).fee);
  const creatorAmount = g - fee;
  return {
    grossAmount: g,
    creatorAmount,
    platformFeeAmount: fee,
    creatorFeePct: g > 0 ? creatorAmount * 100 / g : 0,
  };
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
