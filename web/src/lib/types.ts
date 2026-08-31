// Shared TS types for the avatok.ai web client. These mirror the existing
// Worker response shapes (MASTER-PROMPT §4). They are intentionally permissive
// (optional fields) because the Worker is the source of truth — phases A–E may
// narrow/extend locally, but should not redefine these core shapes.

/**
 * A marketplace card as returned by /api/explore, /api/explore/* and search.
 *
 * [CARD-MODEL-1] These names now match the worker's shapeCard()
 * (worker/src/routes/listings.ts) FIELD FOR FIELD. They did not before: this interface
 * declared `poster`, `rating` and `currency`, none of which the worker has ever sent —
 * it sends `cover_media`, `rating_avg` and `currency_display`. `request<CardPage>` casts
 * without validating, so the mismatch typechecked and every card rendered an empty
 * placeholder in production.
 *
 * Do not read these fields directly in a component. Run the card through `toCardView()`
 * in lib/card.ts, which resolves the aliases and derives the poster from the cover array.
 */
export interface Card {
  id: string;
  kind?: ListingKind;
  /**
   * [MARKET-SECTION-1] The bazaar section the SERVER assigned this listing
   * (`listings.section`, resolved at publish time). Not `vertical`, which is the
   * separate commerce|connect split. Optional because a client built before the
   * 2026-08-31 worker deploy will not see it.
   */
  section?: string | null;
  title: string;
  /** First line of the description, sent by the worker as `one_liner`. */
  one_liner?: string | null;
  /** LEGACY/hand-built only. The worker sends `cover_media`; toCardView derives it. */
  poster?: string | null;
  /** Worker truth: an array of {type,url}. The poster is the first entry. */
  cover_media?: CoverMedia[] | null;
  /** Price in tokens (1 token = ₹1). `effective_price` applies an active promo. */
  price?: number | null;
  effective_price?: number | null;
  promo_pct?: number | null;
  /** Worker sends `currency_display`; `currency` is the legacy alias. */
  currency_display?: string | null;
  currency?: string | null;
  category?: string | null;
  country?: string | null;
  location?: string | null;
  /** Worker sends `rating_avg` + `rating_count`; `rating` is the legacy alias. */
  rating_avg?: number | null;
  rating_count?: number | null;
  rating?: number | null;
  review_count?: number | null;
  joined_count?: number | null;
  /** Creator summary embedded on the card. */
  creator?: CreatorRef | null;
  /** Present on /api/explore/live-now items. */
  joinable?: boolean;
  /** Live state hint when applicable. */
  live?: boolean;
  status?: string | null;
  starts_at?: number | null;
  ends_at?: number | null;
  duration_min?: number | null;
  capacity?: number | null;
  /** Comma-separated, e.g. "Hindi,English". */
  spoken_lang?: string | null;
  adults_only?: boolean;
  favorited?: boolean;
  /** How the price should read: per_minute | per_hour | per_month | from | asking | none. */
  price_semantics?: string | null;
  /** [CARD-SCHEMA-1] Derived server-side, never stored. `null` means "could not count",
   *  which is deliberately different from 0. */
  seats_taken?: number | null;
  seats_left?: number | null;
  watching?: number | null;
  created_at?: number | null;
  /**
   * [DEMO-LISTING-1 2026-08-26] URL slug for the shareable /<handle>/<slug>
   * route. Optional because the Worker does not emit it yet — listingHref()
   * derives one from the title and falls back to /l/<id>. When /api/explore
   * starts returning a real, stable slug, this becomes the authority.
   */
  slug?: string | null;
}

export type ListingKind = 'live' | 'consult' | 'event' | 'agent' | 'content' | string;

/** One entry of the worker's `cover_media` array. */
export interface CoverMedia {
  type?: string;
  url?: string;
  /** Older rows, and a stale schema comment in migrations/listings.sql. */
  r2_key?: string;
}

export interface CreatorRef {
  /** Worker sends `uid`; `id` is the legacy/hand-built alias. */
  uid?: string;
  id?: string;
  handle?: string | null;
  name?: string | null;
  /** Worker sends `avatar_url`; `avatar` is the legacy alias. */
  avatar_url?: string | null;
  avatar?: string | null;
  /** The A4 trust badge. Every new card comp draws a ✓ — this is what earns it. */
  kyc_verified?: boolean;
}

/**
 * [CARD-MODEL-1] What a card component renders. Produced by `toCardView()`; never
 * built by hand. Names are camelCase and unambiguous, so a component can never again
 * read a field the API does not send and silently get `undefined`.
 */
export interface CardView {
  id: string;
  kind: string | null;
  title: string;
  oneLiner: string | null;
  poster: string | null;
  category: string | null;
  price: number | null;
  listPrice: number | null;
  promoPct: number;
  currency: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  reviewCount: number;
  joinedCount: number;
  startsAt: number | null;
  durationMin: number | null;
  capacity: number | null;
  spokenLang: string | null;
  location: string | null;
  country: string | null;
  adultsOnly: boolean;
  seatsLeft: number | null;
  watching: number | null;
  status: string | null;
  live: boolean;
  favorited: boolean;
  creator: {
    id: string;
    handle: string | null;
    name: string | null;
    avatar: string | null;
    verified: boolean;
  } | null;
}

/** Full listing detail from /api/listings/:id. */
export interface Listing extends Card {
  description?: string | null;
  creator_stats?: CreatorStats | null;
  reviews?: Review[];
  viewer?: {
    following?: boolean;
    booked?: boolean;
    is_owner?: boolean;
  };
}

export interface CreatorStats {
  followers?: number;
  listings?: number;
  rating?: number | null;
  reviews?: number;
}

/** Creator channel from /api/creators/:id. */
export interface Creator {
  id: string;
  handle: string;
  name?: string | null;
  avatar?: string | null;
  bio?: string | null;
  country?: string | null;
  stats?: CreatorStats | null;
  listings?: Card[];
  reviews?: Review[];
}

export interface Review {
  id: string;
  author?: CreatorRef | null;
  rating: number;
  text?: string | null;
  created_at?: number;
}

export interface Category {
  id: string;
  label: string;
  count?: number;
}

/** Cursor-paginated list envelope used by explore/search. */
export interface CardPage {
  listings: Card[];
  cursor: string | null;
  /** [MARKET-SECTION-1] The section filter the server applied, if any. */
  section?: string | null;
  /**
   * [MARKET-SECTION-1] Catalogue-wide count per section — every section present,
   * zeroes included. Absent (or null) when the worker could not compute them, in
   * which case the client must fall back rather than render zeroes: "0" and "we
   * do not know" are different claims and only one of them is safe to print.
   */
  section_counts?: Record<string, number> | null;
}

/** A booking row from /api/booking/list. */
export interface Booking {
  id: string;
  listing_id: string;
  role?: 'fan' | 'creator' | string;
  when?: number | null;
  status?: string;
  title?: string | null;
  creator?: CreatorRef | null;
}

/** Live join ticket from /api/live/:id/join. */
export interface LiveJoin {
  whep?: string;
  hls?: string;
  room_token?: string;
  starts_at?: number | null;
  ends_at?: number | null;
}

/** Identity tiers (guest = level 0). */
export interface IdentityLevel {
  level: number;
  handle?: string | null;
  uid?: string | null;
}

/** Guest account creation result from POST /api/identity/guest. */
export interface GuestCreated {
  uid: string;
  handle: string;
  guest_token: string;
  level: number;
}
