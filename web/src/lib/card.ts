/* [CARD-MODEL-1] The worker's card shape → what a card component actually renders.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────────────────
 * `Card` in types.ts declared `poster`, `rating`, `currency` and `creator.avatar`.
 * The worker's shapeCard() (worker/src/routes/listings.ts) has NEVER emitted any of
 * those. It sends `cover_media` (an ARRAY of {type,url}), `rating_avg`,
 * `currency_display` and `creator.avatar_url`. Nothing translated between them, and
 * `request<CardPage>` just casts, so TypeScript was happy and every field silently
 * read `undefined`.
 *
 * The visible result, in production, on avatok.ai: **every listing card shows the
 * "no poster" placeholder and no rating**, because `listing.poster` is a field that
 * does not exist on the response. This was not a missing feature. It was a rename
 * nobody propagated.
 *
 * ── AND THE GAP ───────────────────────────────────────────────────────────────────
 * The Flutter ListingCard (app/lib/core/listings_api.dart) parses 30+ fields off the
 * SAME endpoint — duration, language, location, capacity, favourite, verified badge —
 * while web declared twelve. The new card designs need most of those. They cost one
 * normalizer, not a migration: the data has been on the wire the whole time.
 *
 * Legacy aliases are still read where they existed, so a caller that hand-built a Card
 * (the mockup pages do) keeps working.
 */
import type { Card, CardView, CoverMedia, CreatorRef } from './types';

function firstCoverUrl(media: unknown): string | null {
  if (!Array.isArray(media)) return null;
  for (const m of media) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    // {type,url} is what the worker stores today; r2_key appears on older rows and in
    // a stale schema comment in migrations/listings.sql.
    const url = rec.url ?? rec.r2_key;
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

/**
 * A number, or null. `Number(null)` is 0 and `Number('')` is 0 — NOT NaN — so a plain
 * `Number.isFinite(Number(v))` treats "absent" as "zero". That is how a brand-new listing
 * with `rating_avg: null` rendered as "★ 0.0" on the live marketplace: the worker
 * correctly sent null, and this turned it into a real rating of zero.
 *
 * Absent must stay absent, because the card uses null to decide whether to show a field
 * at all. Zero is a value; null is the lack of one.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one card from `/api/explore`, `/api/explore/search`, `/api/explore/live-now`
 * or `/api/listings/:id` into the shape components render from.
 *
 * Every field falls back to its legacy alias, so this is safe to apply to a hand-built
 * Card as well as a worker response.
 */
export function toCardView(card: Card): CardView {
  const creator = (card.creator ?? null) as (CreatorRef & Record<string, unknown>) | null;
  const covers = (card.cover_media ?? null) as CoverMedia[] | null;
  const price = num(card.effective_price) ?? num(card.price);

  return {
    id: String(card.id),
    kind: card.kind ?? null,
    title: card.title ?? '',
    // `description` only exists on the detail response (Listing extends Card), so it is
    // read off the widened record rather than declared on Card.
    oneLiner: (card.one_liner ?? (card as Card & { description?: string | null }).description ?? null) as string | null,
    poster: card.poster ?? firstCoverUrl(covers),
    category: card.category ?? null,

    price,
    // The list price, shown struck through only when a promo actually reduced it.
    listPrice: num(card.price),
    promoPct: num(card.promo_pct) ?? 0,
    // ₹, per [TOKENS-INR-1]: 1 token = ₹1. `currency_display` is a marketplace-listing
    // currency and is only meaningful on the multi-currency marketplace verticals.
    currency: (card.currency_display ?? card.currency ?? null) as string | null,

    ratingAvg: num(card.rating_avg) ?? num(card.rating),
    ratingCount: num(card.rating_count) ?? 0,
    reviewCount: num(card.review_count) ?? 0,
    joinedCount: num(card.joined_count) ?? 0,

    startsAt: num(card.starts_at),
    durationMin: num(card.duration_min),
    capacity: num(card.capacity),

    spokenLang: (card.spoken_lang ?? null) as string | null,
    location: (card.location ?? null) as string | null,
    country: card.country ?? null,
    adultsOnly: Boolean(card.adults_only),
    // null vs 0 is load-bearing: "sold out" and "we could not count" must not render
    // the same way on a card someone is deciding to buy from.
    seatsLeft: card.seats_left == null ? null : num(card.seats_left),
    watching: card.watching == null ? null : num(card.watching),

    status: (card.status ?? null) as string | null,
    live: Boolean(card.live || card.joinable || card.status === 'live'),
    favorited: Boolean(card.favorited),

    creator: creator
      ? {
        // shapeCard sends `uid`; older/hand-built shapes use `id`.
        id: String(creator.uid ?? creator.id ?? ''),
        handle: (creator.handle ?? null) as string | null,
        name: (creator.name ?? null) as string | null,
        avatar: (creator.avatar_url ?? creator.avatar ?? null) as string | null,
        verified: Boolean(creator.kyc_verified),
      }
      : null,
  };
}

/** Human duration for a card chip: "45 min", "2 hr", "1 hr 30". */
export function durationLabel(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m}` : `${h} hr`;
}

/** "Hindi · English" from the stored comma-separated list, capped so a card stays tidy. */
export function languageLabel(spokenLang: string | null, max = 2): string | null {
  if (!spokenLang) return null;
  const parts = spokenLang.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.length <= max
    ? parts.join(' · ')
    : `${parts.slice(0, max).join(' · ')} +${parts.length - max}`;
}

/**
 * Price label. `price_semantics` decides the suffix — a consult charged by the minute
 * and an event with one ticket price are different numbers with the same type, and the
 * card comps show both (`₹8/min`, `₹50/hr`, `₹1,499`).
 */
export function priceLabel(price: number | null, semantics?: string | null): string {
  if (price == null) return '';
  if (price === 0) return 'Free';
  const amount = `₹${price.toLocaleString('en-IN')}`;
  switch (semantics) {
    case 'per_minute': return `${amount}/min`;
    case 'per_hour': return `${amount}/hr`;
    case 'per_month': return `${amount}/mo`;
    case 'from': return `From ${amount}`;
    default: return amount;
  }
}
