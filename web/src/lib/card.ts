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
import type { AiPoster, Card, CardView, CoverMedia, CreatorRef } from './types';
import { chips as chipCopy, cta, statusPill, laneBadge, laneName, laneBlurbFallback, spotsLeft, seatsBaakiUrgent, earlyBird, regularsHeart, chatsCount, AI_INSTANT, responseTime, billingUnitLabel, liveWatching, pillExtra } from './copy';

/** [POSTER-FIRST-1 2026-09-05] Find the generated poster, from whichever of the
 *  two wires this card arrived on.
 *
 *  The DETAIL response carries `attrs.poster`, which is the richer source — it
 *  knows the variants and whether the lettering is baked in. The LIST responses
 *  (/api/explore, search, live-now) do not send `attrs` at all, so there the
 *  only signal is the `source: "ai_poster"` marker the worker writes onto the
 *  cover_media entry it prepends. Both paths must work, because the same tile
 *  renders in a rail and on a detail page.
 *
 *  A poster that is not yet usable (generating / failed / rejected) returns
 *  null, so the card falls back to its ordinary layout rather than rendering a
 *  broken image or an empty frame. */
function aiPosterFrom(card: Card): AiPoster | null {
  const attrs = (card as Card & { attrs?: Record<string, unknown> | null }).attrs;
  const p = (attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>).poster : null) as
    Record<string, unknown> | null | undefined;
  if (p && typeof p === 'object') {
    const status = String(p.status ?? '');
    const url = typeof p.url === 'string' ? p.url : '';
    if (url && (status === 'draft' || status === 'approved')) {
      return {
        url,
        variants: (p.variants ?? undefined) as AiPoster['variants'],
        lettering: (p.lettering === 'overlay' ? 'overlay' : 'baked'),
        copy: (p.copy ?? undefined) as AiPoster['copy'],
      };
    }
    // An attrs.poster that exists but is mid-flight or failed is a definitive
    // "no poster yet" — do NOT fall through to the cover_media guess below,
    // which would resurrect a stale poster from a previous attempt.
    if (status === 'generating' || status === 'failed') return null;
  }
  const covers = card.cover_media;
  if (Array.isArray(covers)) {
    for (const m of covers) {
      if (m && typeof m === 'object' && m.source === 'ai_poster') {
        const url = m.url ?? m.r2_key;
        if (typeof url === 'string' && url) return { url, lettering: 'baked' };
      }
    }
  }
  return null;
}

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
    aiPoster: aiPosterFrom(card),
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
    createdAt: num(card.created_at),

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
export function priceLabel(price: number | null, semantics?: string | null, billingUnit?: string | null): string {
  if (price == null) return '';
  if (price === 0) return 'Free';
  const amount = `₹${price.toLocaleString('en-IN')}`;
  // [LIST-TRUST-1] "from" outranks the per-unit suffix — "From ₹300/10min" reads
  // like two conflicting claims about the same number, and §2's card comps only
  // ever show one or the other.
  if (semantics === 'from') return `From ${amount}`;
  switch (billingUnit) {
    case 'minute': return `${amount}/min`;
    case '10min': return `${amount}/10min`;
    case 'chat': return `${amount}/chat`;
    case 'night': return `${amount}/night`;
    case 'game': return `${amount}/game`;
    default: break;
  }
  switch (semantics) {
    case 'per_minute': return `${amount}/min`;
    case 'per_hour': return `${amount}/hr`;
    case 'per_month': return `${amount}/mo`;
    default: return amount;
  }
}

/* ── §2 per-type card slot rules (Specs/SPEC-2026-09-02-LISTING-TRUST-AND-
 * VIBE.md §2.1–2.5) ─────────────────────────────────────────────────────────
 * The type DECIDES the slot contents; a creator never picks chips (§2 intro).
 * Every ladder below stops at the first rung backed by real data on the card
 * wire and falls back to an honest "we don't know yet" badge (PEHLA SHOW /
 * NAYA AGENT / NEW EXPERT / JUST ADDED) rather than inventing evidence — rule
 * zero, §1: "every badge is earned from data. Nothing is faked to look full."
 *
 * Rungs that need data NOT on the Card wire today (shows_hosted, sessions_done,
 * comeback_pct, cancel_rate — all live on `creator_stats`, not `/api/explore`)
 * are skipped rather than guessed at; when the worker starts embedding
 * `creator_trust_stats` on list cards, wire those rungs in here.
 */

/** A card's rendering lane. `free_entry` outranks `kind` (§2.4 is its own
 *  slot set layered over whatever kind the session actually is). */
export type ListingLane = 'live' | 'consult' | 'agent' | 'free' | 'adda';

export function laneFor(card: Card, c: CardView): ListingLane {
  if (card.free_entry) return 'free';
  const kind = (c.kind ?? '').toLowerCase();
  if (kind === 'agent') return 'agent';
  if (kind === 'consult') return 'consult';
  if (card.schedule_mode === 'recurring') return 'adda';
  return 'live';
}

/** `NEW` chip rule (§4.6 / task item 4): true for the first 48h after `created_at`. */
export function isNew(createdAt: number | null, withinHours = 48): boolean {
  if (!createdAt) return false;
  return Date.now() - createdAt < withinHours * 3_600_000;
}

/** `★ 4.9 · 620`, or null when the rating doesn't clear §4.6's floor (a raw
 *  review count under 3 must show NEW/PEHLA SHOW instead of a real-looking star). */
function ratingOrNull(c: CardView): string | null {
  if (c.ratingAvg == null || c.ratingCount < 3) return null;
  return chipCopy.rating(c.ratingAvg, c.ratingCount);
}

/** `♡ 300 REGULARS` from the creator's follower count, or null. */
function regularsOrNull(card: Card): string | null {
  const n = card.creator?.follower_count;
  return n && n > 0 ? regularsHeart(n) : null;
}

/** Parse a field the worker may send as a real array or a JSON-encoded string
 *  (types.ts documents both shapes for `recurrence_days` and `vibe_tags`). */
function parseArrayMaybe<T>(v: unknown): T[] | null {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const DAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function formatHHmm(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h)) return hhmm;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${period}` : `${h12} ${period}`;
}

/** `DAILY 6 PM` / `MON·WED·FRI 6 PM` from `recurrence_days` + `recurrence_time`
 *  (§2.5). Null when there's no recurrence time to anchor a label to. */
export function recurrenceLabel(
  days: number[] | null | undefined,
  time: string | null | undefined,
): string | null {
  if (!time) return null;
  const t = formatHHmm(time);
  const list = (days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!list.length || list.length >= 7) return `DAILY ${t}`;
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  return `${sorted.map((d) => DAY_ABBR[d]).join('·')} ${t}`;
}

/** `FRI 9 PM` / `TONIGHT 9 PM` / `6 SEPT` — the comp's status-pill date copy.
 *  `prefixNext` renders the weekday branch as `NEXT FRI 9 PM` (§2.2's consult
 *  pill reads "NEXT MON 11 AM", not just "MON 11 AM"). */
export function timePillLabel(startsAt: number | null, opts: { prefixNext?: boolean; timeZone?: string } = {}): string {
  if (!startsAt) return pillExtra.AVAILABLE_NOW;
  const d = new Date(startsAt);
  if (!Number.isFinite(d.getTime())) return pillExtra.AVAILABLE_NOW;
  // [LIST-PAGE-3] This runs server-side on a UTC Worker: without an explicit zone
  // every card and hero pill on the site said "3:30 PM" for a 9 PM IST show.
  // India is the only market, so IST is the default; a listing's own timezone wins.
  const timeZone = opts.timeZone || 'Asia/Kolkata';
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone }).toUpperCase();
  const dayKey = (x: Date) => x.toLocaleDateString('en-CA', { timeZone });
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return `TONIGHT ${time}`;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days > 0 && days < 7) {
    const wk = d.toLocaleDateString('en-IN', { weekday: 'short', timeZone }).toUpperCase();
    return opts.prefixNext ? `NEXT ${wk} ${time}` : `${wk} ${time}`;
  }
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone }).toUpperCase();
}

/**
 * The status pill per §2's per-type ladder:
 *   live/free — LIVE · N DEKH RAHE → SOLD OUT (seats_left=0) → the time pill →
 *               NEW (<48h, no date at all)
 *   consult   — ON REQUEST (schedule_mode) → AVAILABLE NOW (no starts_at) →
 *               NEXT <day> <time> from starts_at
 *   agent     — ALWAYS ON, always (never a time — §2.3)
 *   adda      — the recurrence label, else the time pill / LIVE
 */
export function pillLabel(lane: ListingLane, card: Card, c: CardView): string {
  switch (lane) {
    case 'agent':
      return statusPill.ALWAYS_ON;
    case 'consult':
      if (card.schedule_mode === 'on_request') return pillExtra.ON_REQUEST;
      if (!c.startsAt) return pillExtra.AVAILABLE_NOW;
      return timePillLabel(c.startsAt, { prefixNext: true });
    case 'adda': {
      const rec = recurrenceLabel(
        parseArrayMaybe<number>(card.recurrence_days) ?? undefined,
        card.recurrence_time,
      );
      if (rec) return rec;
      return c.live ? 'LIVE' : timePillLabel(c.startsAt);
    }
    case 'free':
    case 'live':
    default: {
      if (c.live) return c.watching ? liveWatching(c.watching) : statusPill.LIVE;
      if (c.seatsLeft === 0) return statusPill.SOLD_OUT;
      if (!c.startsAt) return isNew(c.createdAt) ? statusPill.NEW : pillExtra.AVAILABLE_NOW;
      return timePillLabel(c.startsAt);
    }
  }
}

/** The two proof chips per §2's per-type ladder. Always both filled (the
 *  layout needs it) — see the ⚠️ note on the old `chipsFor` this replaces. */
export function chipsForLane(lane: ListingLane, card: Card, c: CardView): [string, string] {
  const rating = ratingOrNull(c);
  switch (lane) {
    case 'free': {
      const one =
        c.seatsLeft === 0 ? laneBadge.FULL
          : c.seatsLeft != null ? spotsLeft(c.seatsLeft)
            : c.capacity != null ? spotsLeft(c.capacity)
              : laneBadge.NEW_LISTING;
      const two = regularsOrNull(card) ?? rating ?? laneBadge.PEHLA_SHOW;
      return [one, two];
    }
    case 'consult': {
      const one = card.response_time_min != null ? responseTime(card.response_time_min) : laneBadge.NEW_EXPERT;
      const two = rating ?? laneBadge.NEW_LISTING;
      return [one, two];
    }
    case 'agent': {
      const one = AI_INSTANT;
      const two = c.joinedCount > 0 ? chatsCount(c.joinedCount) : rating ?? laneBadge.NAYA_AGENT;
      return [one, two];
    }
    case 'adda': {
      const tags = parseArrayMaybe<string>(card.vibe_tags);
      const one = tags && tags[0] ? tags[0].toUpperCase() : laneBadge.NEW_LISTING;
      const two = rating ?? laneBadge.JUST_ADDED;
      return [one, two];
    }
    case 'live':
    default: {
      const one = regularsOrNull(card) ?? laneBadge.PEHLA_SHOW;
      const pct = card.capacity && c.seatsLeft != null && card.capacity > 0 ? c.seatsLeft / card.capacity : null;
      const two =
        rating
        ?? (c.seatsLeft != null && c.seatsLeft > 0 && pct != null && pct <= 0.2 ? seatsBaakiUrgent(c.seatsLeft) : null)
        ?? (card.promo_pct ? earlyBird(card.promo_pct) : null)
        ?? laneBadge.JUST_ADDED;
      return [one, two];
    }
  }
}

/**
 * [CARD-UNIFORM-1 2026-09-03, owner decision] THE UNIFORM CHIP LADDER.
 *
 * Every card gets exactly THREE chips, in the same order, in every lane:
 *
 *   1. AVAILABILITY — how many spots/seats are left, or the honest terminal
 *      rung when the listing never set a capacity.
 *   2. PROOF        — rating, then regulars/chats, then the lane's "new" badge.
 *   3. CONTEXT      — an active promo, else a real vibe tag, else the lane's
 *      own name. Freshness is already communicated by the status pill when it
 *      is useful; repeating JUST ADDED here wastes scarce card space.
 *
 * The owner's complaint this fixes: "some cards get some buttons and some
 * cards don't" — a grid where one tile shows a seat count and its neighbour
 * shows nothing reads as broken rather than as two different listings.
 *
 * ⚠️ The fix is a SLOT that is always filled, never a FACT that is always
 * invented. Each rung below is data the listing actually carries; the terminal
 * rungs (BOOKING_OPEN, PEHLA SHOW, the lane name) claim nothing beyond "this
 * listing is published". Do not add a rung that prints a number the row does
 * not have — a fake seat count is worse than an uneven grid.
 *
 * `chipsForLane` above is kept: it is the §2 two-chip contract other surfaces
 * still read against, and the detail page's own ladder is derived from it.
 */
export function uniformChips(lane: ListingLane, card: Card, c: CardView): [string, string, string] {
  const rating = ratingOrNull(c);

  // ── 1. availability ───────────────────────────────────────────────────────
  let availability: string;
  if (c.seatsLeft === 0) {
    availability = laneBadge.FULL;
  } else if (c.seatsLeft != null) {
    const pct = card.capacity && card.capacity > 0 ? c.seatsLeft / card.capacity : null;
    availability = lane === 'free'
      ? spotsLeft(c.seatsLeft)
      : pct != null && pct <= 0.2 ? seatsBaakiUrgent(c.seatsLeft) : chipCopy.seatsLeft(c.seatsLeft);
  } else if (card.capacity != null && card.capacity > 0) {
    availability = lane === 'free' ? spotsLeft(card.capacity) : chipCopy.seatsLeft(card.capacity);
  } else if (lane === 'agent') {
    availability = AI_INSTANT;
  } else if (lane === 'consult') {
    availability = card.response_time_min != null
      ? responseTime(card.response_time_min)
      : card.schedule_mode === 'on_request' ? pillExtra.ON_REQUEST : laneBadge.SLOTS_OPEN;
  } else {
    availability = lane === 'free' ? laneBadge.ENTRY_OPEN : laneBadge.BOOKING_OPEN;
  }

  // ── 2. proof ──────────────────────────────────────────────────────────────
  const newBadge =
    lane === 'agent' ? laneBadge.NAYA_AGENT
      : lane === 'consult' ? laneBadge.NEW_EXPERT
        : lane === 'adda' ? laneBadge.NEW_LISTING
          : laneBadge.PEHLA_SHOW;
  const proof =
    rating
    ?? (lane === 'agent' && c.joinedCount > 0 ? chatsCount(c.joinedCount) : null)
    ?? regularsOrNull(card)
    ?? newBadge;

  // ── 3. context ────────────────────────────────────────────────────────────
  const tags = parseArrayMaybe<string>(card.vibe_tags);
  const context =
    (card.promo_pct ? earlyBird(card.promo_pct) : null)
    ?? (tags && tags[0] ? tags[0].toUpperCase() : null)
    ?? laneName[lane];

  return [availability, proof, context];
}

/** [CARD-UNIFORM-1] The body line, with the lane's fallback when the creator
 *  left the blurb empty. Never invents a description of the session itself —
 *  see the note on `laneBlurbFallback`. */
export function cardBlurb(lane: ListingLane, card: Card, c: CardView): string {
  const written = (card.blurb || c.oneLiner || '').trim();
  return written || laneBlurbFallback[lane];
}

/** The bottom-right cadence label per §2's per-type rule. */
export function bottomRightForLane(lane: ListingLane, card: Card, c: CardView): string | null {
  switch (lane) {
    case 'agent':
      return billingUnitLabel(card.billing_unit) ?? 'PER 10 MIN';
    case 'consult':
      if (card.billing_unit === '10min' && c.price != null) {
        return `₹${c.price.toLocaleString('en-IN')} / 10 MIN`;
      }
      return billingUnitLabel(card.billing_unit) ?? durationLabel(c.durationMin);
    case 'adda':
      return billingUnitLabel(card.billing_unit) ?? durationLabel(c.durationMin);
    case 'free':
    case 'live':
    default:
      return durationLabel(c.durationMin);
  }
}

/** Primary/secondary CTA per §2's per-type rule + the `cta` tag §2.3 (task
 *  item 7) reports on `market_card_click`. */
export interface LaneButtons {
  primaryLabel: string;
  primaryCta: 'book' | 'talk' | 'reserve';
  secondaryLabel: string;
  secondaryCta: 'details' | 'calendar';
}

export function buttonsForLane(lane: ListingLane): LaneButtons {
  switch (lane) {
    case 'consult':
      return { primaryLabel: cta.BOOK_SLOT, primaryCta: 'book', secondaryLabel: 'CALENDAR', secondaryCta: 'calendar' };
    case 'agent':
      return { primaryLabel: cta.TALK_NOW, primaryCta: 'talk', secondaryLabel: 'MORE INFO', secondaryCta: 'details' };
    case 'free':
      return { primaryLabel: cta.RESERVE_FREE, primaryCta: 'reserve', secondaryLabel: 'MORE INFO', secondaryCta: 'details' };
    case 'adda':
    case 'live':
    default:
      return { primaryLabel: cta.BOOK_NOW, primaryCta: 'book', secondaryLabel: 'MORE INFO', secondaryCta: 'details' };
  }
}
