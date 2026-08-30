/*
 * money.ts — the ONE place the web client turns a token count into money.
 *
 * [TOKENS-INR-RAIL-1 2026-08-28] Before this file existed, eight modules each
 * carried their own copy of
 *
 *     `$${(coins / 100).toFixed(2)}`
 *
 * — a formatter from the era when a token was priced at one US cent, so 500
 * tokens rendered as "$5.00". The owner's pricing decision is 1 token = ₹1
 * (see CLAUDE.md, [TOKENS-INR-1] and [TOKENS-INR-RAIL-1]), which makes that
 * formatter wrong twice over: wrong symbol AND wrong magnitude. 500 tokens are
 * ₹500, not ₹5. The divide-by-100 has to go, not just the dollar sign.
 *
 * Every call site now delegates here so the next pricing change is one edit.
 *
 * WHAT DOES NOT BELONG IN THIS FILE:
 *   • Marketplace listing prices. Those carry their own `currency` field and
 *     are genuinely multi-currency (see components/ListingTile.tsx and, in the
 *     app, intent_theme.dart). A seller may list in USD, EUR, whatever.
 *   • Real US dollars — provider cost accounting in micro_usd, Google Play's
 *     USD-defined SKU tiers. Those are actual dollars and keep their "$".
 */

/** The fixed, owner-set rate. Not an FX conversion — see lib/fx_rates.ts. */
export const RUPEES_PER_TOKEN = 1;

/**
 * A token amount as money: `₹500`, `₹1,200`. Whole rupees, because a token is
 * a whole rupee and fractions of one cannot be bought or spent.
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
 * ⚠️ THIS IS A QUOTE, NOT A TAX INVOICE. avaTOK has no GSTIN yet, so nothing rendered
 * from this may be labelled a GST invoice or carry a registration number. Have an
 * accountant confirm the rate, the place-of-supply treatment and the invoice format
 * before a single rupee of it is collected.
 */
export const GST_RATE_PCT = 18;

export interface PriceBreakdown {
  /** The creator's price, in tokens (₹1 each). */
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
