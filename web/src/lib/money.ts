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
