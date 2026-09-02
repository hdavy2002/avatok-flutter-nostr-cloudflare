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
  /** [LIST-DETAIL-1] YouTube intro video link (§2.2). Null on every listing that has
   *  none — never autoplay when rendering it. */
  video_url?: string | null;
  /** [LIST-DETAIL-1] Live translation offered alongside `spoken_lang`. */
  translation_enabled?: boolean;
  /**
   * [LIST-DETAIL-1] Category-specific answers (§2.2), keyed per the category's own
   * `field_schema`. Also carries the buyer-facing commercial booking policy the
   * creator filled in — `commercial_refund_window_hours` (live/event),
   * `commercial_cancellation_window_hours` / `commercial_reschedule_allowed` /
   * `commercial_booking_notice_hours` / `commercial_preparation_instructions`
   * (consult) — validated server-side in `commercialPolicyError`
   * (worker/src/routes/listings.ts). Shape is per-category and per-kind; read
   * defensively rather than assuming every key is present.
   */
  attrs?: (Record<string, unknown> & ListingContentAttrs) | null;
  /** [LIST-CONTENT-2] Short one-line pitch, distinct from `one_liner` (§C.1/§C.2). */
  blurb?: string | null;
  /**
   * [LIST-CONTENT-2] Booking cadence — how the listing's time is structured
   * (Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.1/§C.2). Optional
   * because older listings/clients predate this field.
   */
  schedule_mode?: 'fixed_date' | 'recurring' | 'on_request' | 'always_on';
  /** [LIST-CONTENT-2] For `schedule_mode: 'recurring'` — 0=Sun..6=Sat. Worker may
   *  send this as a JSON-encoded string or a real array; parse defensively. */
  recurrence_days?: number[] | null;
  /** [LIST-CONTENT-2] "HH:mm" local time paired with `recurrence_days`/`timezone`. */
  recurrence_time?: string | null;
  /** [LIST-CONTENT-2] IANA tz name the schedule fields above are expressed in. */
  timezone?: string;
  /** [LIST-CONTENT-2] What the price is charged per. */
  billing_unit?: 'session' | 'minute' | '10min' | 'chat' | 'night' | 'game' | null;
  /** [LIST-CONTENT-2] Whether joining/attending is free (server truth; not a promo). */
  free_entry?: 0 | 1;
  /** [LIST-CONTENT-2] Cap on units-per-booking a single buyer may take at once. */
  max_per_booking?: number;
  /** [LIST-TRUST-1] Creator's typical reply latency in minutes, backs the JALDI
   *  JAWAB badge. Null when there isn't enough data yet. */
  response_time_min?: number | null;
  /** [LIST-TRUST-1 / VIBE] Freeform vibe/mood tags. Worker may send this as a
   *  JSON-encoded string or a real array; parse defensively. */
  vibe_tags?: string[] | null;
  /** [LIST-TRUST-1] Credential/qualification line shown on the trust ladder. */
  credential?: string | null;
}

export type ListingKind = 'live' | 'consult' | 'event' | 'agent' | 'content' | string;

/**
 * [LIST-CONTENT-2] Typed `attrs` keys added by the listing-content work
 * (Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.1, §C.2). `attrs`
 * remains an open `Record<string, unknown>` for every category-specific key —
 * this interface only documents the ones this phase introduced. Every field is
 * optional: a listing written before this phase, or one whose creator skipped
 * a section, sends none of them.
 */
export interface ListingContentAttrs {
  content_how_it_works?: { label: string; body: string }[];
  content_house_rules?: { heading: string; body: string }[];
  content_house_rules_intro?: string;
  content_join_lead_minutes?: number;
  content_free_cap_tokens?: number;
  content_what_you_get?: string[];
  content_who_for?: string[];
  content_not_for?: string[];
  content_faq?: { q: string; a: string }[];
  content_sample_qa?: { q: string; a: string }[];
  content_sample_chat?: { who: string; line: string }[];
  content_can_do?: string[];
  content_cant_do?: string[];
  join_requirements?: {
    mic?: boolean;
    cam?: boolean;
    listen_only?: boolean;
    replay_days?: number;
    recording?: boolean;
  };
}

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
  /**
   * The A4 trust badge. Every new card comp draws a ✓ — this is what earns it.
   * [LIST-TRUST-1] Widened to `boolean | 0 | 1`: some worker read paths select
   * the raw D1 column (0/1) instead of the coerced boolean.
   */
  kyc_verified?: boolean | 0 | 1;
  /** [LIST-TRUST-1] Follower count shown on the creator trust ladder. */
  follower_count?: number;
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
  /** [LIST-TRUST-1] Epoch ms the listing was created, null when unknown. Backs
   *  the `NEW` chip (<48h, §2/§4). */
  createdAt: number | null;
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
  /**
   * [LIST-DETAIL-1] Category-driven rendering hints, resolved server-side in
   * `getListing` (worker/src/routes/listings.ts ~line 1684) — present on the detail
   * response ONLY, never on a browse/search Card. `intent` names the seller's verb
   * (SELL | RENT | BOOK | LEAD | PROFILE); `price_semantics` names how the price
   * should read (asking | per_minute | per_hour | per_month | from | range | none);
   * `detail_template` is the pinned (§2.4) template id. All three default server-side
   * (SELL / "sell" / "asking") when the category lookup can't resolve, so treat an
   * absent value as "use the legacy kind-based fallback", not as an error.
   */
  intent?: string | null;
  price_semantics?: string | null;
  detail_template?: string | null;
  /**
   * [LIST-TRUST-1] The creator's cached trust-ladder row from `creator_stats`
   * (worker/migrations/2026-09-02-creator-stats.sql). Derived/cached server-side —
   * never computed client-side, never a form field. Null when the creator has no
   * row yet (e.g. never hosted a session).
   */
  creator_trust_stats?: CreatorTrustStats | null;
  /** [LIST-TRUST-1] Rolling count of bookings in the last 24h, backs urgency copy. */
  booked_24h?: number;
}

export interface CreatorStats {
  followers?: number;
  listings?: number;
  rating?: number | null;
  reviews?: number;
}

/**
 * [LIST-TRUST-1] One row of `creator_stats`
 * (worker/migrations/2026-09-02-creator-stats.sql), verbatim column names.
 * Filled by a worker cron/on-write refresh — never computed client-side.
 */
export interface CreatorTrustStats {
  creator_id: string;
  shows_hosted: number;
  hours_live: number;
  on_time_pct?: number | null;
  cancel_rate?: number | null;
  comeback_pct?: number | null;
  avg_response_min?: number | null;
  sessions_done: number;
  sold_out_count: number;
  first_session_at?: number | null;
  last_session_at?: number | null;
  updated_at: number;
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

/**
 * [LIST-DETAIL-1] A review row from /api/listings/:id and /api/creators/:id.
 *
 * This interface previously declared a nested `author: CreatorRef` and a `text`
 * field. The worker (getListing / getCreator, worker/src/routes/listings.ts) has
 * never sent either — it selects `rv.author_id, rv.rating, rv.body, rv.reply,
 * rv.reply_at, rv.created_at, u.display_name AS author_name, u.avatar_url AS
 * author_avatar` — flat columns, not a nested object, and the review text is
 * `body`. Same [CARD-MODEL-1]-shaped bug as `Card`: it typechecked, so every
 * review rendered with a blank name/avatar and no text.
 */
export interface Review {
  id: string;
  author_id?: string | null;
  author_name?: string | null;
  author_avatar?: string | null;
  rating: number;
  body?: string | null;
  /** The creator's reply, if they left one. */
  reply?: string | null;
  reply_at?: number | null;
  created_at?: number;
  /**
   * [LIST-REVIEW-2] Trust columns from `reviews`
   * (worker/migrations/2026-09-02-reviews-trust.sql). `verified_attendee` is set
   * server-side from the entitlement at write time — never a client-posted flag.
   */
  verified_attendee?: 0 | 1;
  /** [LIST-REVIEW-2] Alias for `reply`/`reply_at` under the trust-migration's own
   *  column names — some read paths select these directly. */
  creator_reply?: string | null;
  creator_reply_at?: number | null;
  helpful_count?: number;
  /** [LIST-REVIEW-2] Whether the CURRENT viewer already voted this review helpful. */
  viewer_marked_helpful?: boolean;
  /** [LIST-REVIEW-2] Resolved URLs for `reviews.photo_keys` (<=3 R2 keys). */
  photo_urls?: string[];
}

/**
 * [LIST-REVIEW-2] Paginated review list envelope, e.g. from
 * /api/listings/:id/reviews.
 */
export interface ReviewList {
  items: Review[];
  histogram: Record<'1' | '2' | '3' | '4' | '5', number>;
  verified_count: number;
  total: number;
  /** Whether the star rating should be shown at all (e.g. below a minimum count). */
  show_rating: boolean;
  next_cursor?: string | null;
}

/**
 * [LIST-SLOTS-1] A bookable slot row from `listing_slots`
 * (worker/migrations/2026-09-02-listing-slots.sql). The booking grain for
 * `consult`; optional refinement for `live`/`event`.
 */
export interface ListingSlot {
  id: string;
  listing_id: string;
  starts_at: number;
  ends_at: number;
  label?: string | null;
  capacity: number;
  booked_count: number;
  status: 'open' | 'full' | 'cancelled' | 'done' | string;
}

/**
 * [LIST-ASK-1] An "Ask the host" question row from `listing_questions`
 * (worker/migrations/2026-09-02-creator-stats.sql). The answer is shown to the
 * asker only, unless promoted into `content_faq` via `promoted_to_faq`.
 */
export interface ListingQuestion {
  id: string;
  listing_id: string;
  question: string;
  answer?: string | null;
  answered_at?: number | null;
  created_at: number;
  promoted_to_faq: 0 | 1;
}

/**
 * [LIST-TRUST-1] The six trust/vibe badge ids (§5). A badge id outside this
 * union is either a typo or a badge added server-side without a client update —
 * treat it as unknown rather than assuming it renders.
 */
export type BADGE_IDS =
  | 'pehla_show'
  | 'pakka_host'
  | 'wapsi'
  | 'bawaal'
  | 'seedhi_baat'
  | 'jaldi_jawab';

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
