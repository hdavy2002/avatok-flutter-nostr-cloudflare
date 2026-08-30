// [TAX-GST-1] The one place tax is computed. (owner decision 2026-08-29: 18% GST)
//
// THE SHAPE, AND WHY IT IS THIS SHAPE
// -----------------------------------
//   P            listing price, the number the creator set and the card shows
//   F            platform fee — 0 today, carried so it can be switched on without
//                reshaping any of this (the bazaar comp shows a flat ₹6; charging both a
//                flat fee AND a 20% cut is a pricing decision nobody has made)
//   taxableBase  P + F
//   gst          round(taxableBase * ratePct / 100)
//   buyer pays   taxableBase + gst
//   escrow holds taxableBase          ← the 80/20 split runs on THIS
//   gst          → 'platform:tax'     ← never escrow, never split
//
// THE INVARIANT THAT MATTERS: **the creator's payout does not change when tax is turned
// on.** They set P, they earn 80% of (P + F), with GST on or off. The failure mode this
// prevents is computing the split off the tax-inclusive total, which pays creators out of
// tax money — 80% of ₹118 instead of 80% of ₹100 — and leaves nothing to remit. There is
// a test for exactly that; do not delete it because it looks tautological.
//
// GST IS NOT REVENUE. It is money held on behalf of a tax authority. That is the whole
// reason it gets its own account instead of a share of the fee.
//
// ⚠️ Collection is OFF until avaTOK has a GSTIN — `gstEnabled` in config.ts carries the
// full warning. With it off this returns zeros, so every caller runs the same code path
// in production long before a real charge includes tax.
import type { PlatformConfig } from "../routes/config";

/** The platform's own tax-liability account. Never `platform:fees` — that is revenue. */
export const ACCT_PLATFORM_TAX = "platform:tax";

export type TaxBreakdown = {
  /** P + F. Escrow holds exactly this; the 80/20 split is computed from it. */
  taxableBase: number;
  /** The rate actually applied, frozen onto the order's policy snapshot. */
  gstRatePct: number;
  /** Tax collected. Credited to ACCT_PLATFORM_TAX, outside escrow. */
  gstAmount: number;
  /** What the buyer is charged: taxableBase + gstAmount. */
  buyerTotal: number;
};

/**
 * Compute the tax line for one order. Returns null on a malformed configuration so the
 * caller REFUSES the checkout — the snapshot is immutable and settles a real order
 * months later, and there is no graceful way to recover from a NaN written into one.
 */
export function taxFor(config: PlatformConfig, taxableBase: number): TaxBreakdown | null {
  if (!Number.isSafeInteger(taxableBase) || taxableBase < 0) return null;
  const enabled = config.gstEnabled === true;
  const rate = Math.trunc(Number(config.gstRatePct));
  if (!Number.isInteger(rate) || rate < 0 || rate > 100) return null;
  // Rate is recorded as 0 when collection is off, not as 18-but-unapplied. The snapshot
  // must say what was actually charged, or a receipt reprinted later will disagree with
  // the money that moved.
  const gstRatePct = enabled ? rate : 0;
  const gstAmount = gstRatePct === 0 ? 0 : Math.round(taxableBase * gstRatePct / 100);
  return {
    taxableBase,
    gstRatePct,
    gstAmount,
    buyerTotal: taxableBase + gstAmount,
  };
}
