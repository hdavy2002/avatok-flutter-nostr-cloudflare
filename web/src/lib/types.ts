// Shared TS types for the avatok.ai web client. These mirror the existing
// Worker response shapes (MASTER-PROMPT §4). They are intentionally permissive
// (optional fields) because the Worker is the source of truth — phases A–E may
// narrow/extend locally, but should not redefine these core shapes.

/** A marketplace card as returned by /api/explore, /api/explore/* and search. */
export interface Card {
  id: string;
  kind?: ListingKind;
  title: string;
  /** Poster / cover image path (run through cfImage for transforms). */
  poster?: string | null;
  /** Price in minor units (or display string from the Worker). */
  price?: number | null;
  currency?: string | null;
  category?: string | null;
  country?: string | null;
  rating?: number | null;
  /** Creator summary embedded on the card. */
  creator?: CreatorRef | null;
  /** Present on /api/explore/live-now items. */
  joinable?: boolean;
  /** Live state hint when applicable. */
  live?: boolean;
  starts_at?: number | null;
  ends_at?: number | null;
}

export type ListingKind = 'live' | 'consult' | 'event' | 'agent' | 'content' | string;

export interface CreatorRef {
  id: string;
  handle?: string;
  name?: string | null;
  avatar?: string | null;
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
