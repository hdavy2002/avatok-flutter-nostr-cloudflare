/*
 * money.ts — the ONE place the web client turns a token count into money.
 *
 * [TOKENS-INR-RAIL-1 2026-09-17] Before this file existed, eight modules each
 * carried their own copy of
 *
 *     a cents-based formatter
 *
 * — a formatter from the era when a token was priced at one US cent. The customer-
 * facing rule is now fixed: 1 Token = ₹1. Tokens are whole rupees, so there is no
 * division or FX conversion in this formatter.
 *
 * Every call site now delegates here so the next pricing change is one edit.
 *
 * WHAT DOES NOT BELONG IN THIS FILE:
 *   • Marketplace listing prices. Those carry their own `currency` field and
 *     are separate from Token values (see components/ListingTile.tsx and, in
 *     the app, intent_theme.dart).
 *   • Provider currency snapshots — those carry their own authoritative currency
 *     and are outside this token formatter.
 */

/** The fixed, owner-set rate: one Token is one Indian rupee. */
export const RUPEES_PER_TOKEN = 1;

/**
 * A token amount as money: `₹500`, `₹1,200`.
 */
export function inr(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(Number(tokens))) return '—';
  const rupees = Math.round(Number(tokens) * RUPEES_PER_TOKEN);
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/** Same as `inr`, but a zero amount reads as "Free" — for rate/price labels. */
export function inrOrFree(tokens: number | null | undefined): string {
  if (tokens === 0) return 'Free';
  return inr(tokens);
}

/** `₹500 · 500 Tokens` — where both the money and the unit are worth showing. */
export function inrWithTokens(tokens: number): string {
  return `${inr(tokens)} · ${Number(tokens).toLocaleString('en-IN')} Tokens`;
}

/**
 * [TAX-GST-DISPLAY-1] The tax line, shown but not yet charged.
 *
 * Owner decision 2026-08-29: show 18% GST and the total a buyer would pay, while
 * checkout stays closed. Nothing here collects anything — the money path is governed by
 * the server's `gstEnabled` flag, which is FALSE, and by the commercial checkout flags,
 * which are also false. This is the price a buyer is quoted, not a charge.
 *
 * MIRRORS `gstRatePct` in worker/src/routes/config.ts. Two copies of a tax rate is one
 * too many, so when the server rate changes this constant changes with it — and until
 * checkout exists there is nothing for them to disagree about.
 *
 * ⚠️ THIS IS A QUOTE, NOT A TAX INVOICE. Saathum has no GSTIN yet, so nothing rendered
 * from this may be labelled a GST invoice or carry a registration number. Have an
 * accountant confirm the rate, the place-of-supply treatment and the invoice format
 * before a single rupee of it is collected.
 */
export const GST_RATE_PCT = 18;

export interface PriceBreakdown {
  /** The creator's price, in Tokens (1 Token = ₹1). */
  base: number;
  /** Platform fee. Zero today; carried so it can be switched on without reshaping this. */
  fee: number;
  gstRatePct: number;
  gst: number;
  /** base + fee + gst — what the buyer would pay. */
  total: number;
}

/** Compute the quoted breakdown for a listing price. Rounds tax the same way the
 *  server does (`Math.round`), so the displayed total matches what will be charged. */
export function priceBreakdown(base: number | null | undefined, feeTokens = 0): PriceBreakdown | null {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return null;
  const fee = Math.max(0, Math.trunc(Number(feeTokens) || 0));
  const taxable = Math.trunc(b) + fee;
  const gst = Math.round(taxable * GST_RATE_PCT / 100);
  return { base: Math.trunc(b), fee, gstRatePct: GST_RATE_PCT, gst, total: taxable + gst };
}
