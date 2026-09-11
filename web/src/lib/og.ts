// OpenGraph / Twitter meta builder — LOCAL to Phase A (not shared kit).
// Turns a listing/creator into the props Base.astro accepts (title, description,
// image) plus a few extra og: tags the share-preview funnel benefits from.
//
// Images run through the Cloudflare image-transform pattern (cfImage) at a
// social-friendly 1200px so link unfurls look crisp. Never hardcode a hex/URL.

import { cfImage } from './config';
import type { Creator, Listing } from './types';
import { scheduleStateOf } from './card';

/** The shape Base.astro consumes, plus optional extra tags for the head slot. */
export interface OgMeta {
  title: string;
  description: string;
  /** Absolute (or transform) image URL for og:image / twitter:image. */
  image?: string;
  /** Extra <meta> pairs Phase A pages drop into the Base `head` slot. */
  extra: Array<{ property?: string; name?: string; content: string }>;
}

const SITE = 'avatok.ai';
const OG_IMG_WIDTH = 1200;

function clampDesc(text: string | null | undefined, fallback: string): string {
  const t = (text ?? '').trim();
  if (!t) return fallback;
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

function socialImage(path?: string | null): string | undefined {
  if (!path) return undefined;
  return cfImage(path, { width: OG_IMG_WIDTH, fit: 'cover', quality: 70 });
}

/**
 * [SHARE-CARD-1 2026-09-06] The image a shared listing link unfurls with.
 *
 * This used to read `listing.poster` alone, which is the flattened
 * cover_media[0] alias — and on a real listing it came back empty, so every
 * shared link fell through to Base.astro's generic /ogimage.jpg. Verified on
 * the live page: og:image was the brand card, not the poster.
 *
 * The generated poster actually lives at `attrs.poster` with optional shape
 * variants, exactly as ListingDetailsComp.astro resolves its hero — so this
 * resolves it the same way, and prefers the LANDSCAPE renders because a share
 * card is a wide box. A tall portrait poster in a 1.91:1 unfurl gets centre-
 * cropped to a band across the middle of someone's chest.
 *
 * `status` is checked for the same reason the page checks it: a poster still
 * generating, or one an admin rejected, must not be the face of a shared link.
 */
function listingShareImage(listing: Listing): string | undefined {
  const poster: any = (listing as any).attrs?.poster ?? null;
  const usable = poster && (poster.status === 'draft' || poster.status === 'approved');
  const variants = usable ? (poster.variants ?? {}) : {};
  const best =
    variants?.wide?.url ??      // 16:9 — the closest thing to a share card
    variants?.tablet?.url ??    // 4:3 — still landscape
    (usable ? poster.url : null) ??
    listing.poster ??
    listing.cover_media?.[0]?.url ??
    null;
  return socialImage(best);
}

/** Build share meta for a listing detail / event page. */
export function listingOg(listing: Listing): OgMeta {
  const creator = listing.creator?.name ?? (listing.creator?.handle ? `@${listing.creator.handle}` : SITE);
  const title = `${listing.title} · ${creator}`;
  const description = clampDesc(
    listing.description,
    `${listing.title} on ${SITE} — browse, book and watch without installing the app.`,
  );
  const image = listingShareImage(listing);
  const extra: OgMeta['extra'] = [
    // og:type is overridden from Base's default 'website'. A listing with a
    // start time is an event, and that is what unfurlers and answer engines
    // should treat it as; everything else stays a product.
    { property: 'og:type', content: listing.starts_at ? 'video.other' : 'product' },
  ];
  if (listing.price != null) {
    extra.push({ property: 'product:price:amount', content: String(listing.price) });
    // [TOKENS-INR-1] Listings default to INR now; the old 'USD' fallback here
    // put a dollar sign on a rupee price in every share preview.
    extra.push({ property: 'product:price:currency', content: (listing.currency ?? 'INR').toUpperCase() });
  }
  return { title, description, image, extra };
}

/**
 * [LISTING-SEO-1 2026-09-06] Structured data for one listing.
 *
 * Two audiences, one object. Google reads schema.org Event to build a rich
 * result (date, price, availability, rating stars). The answer engines —
 * ChatGPT, Perplexity, Gemini, Claude — read the same JSON-LD because it is the
 * only part of a page that states plainly what the thing IS, rather than
 * leaving it to be inferred from marked-up prose. Both get more from one
 * accurate graph than from any amount of keyword stuffing.
 *
 * EVERY FIELD IS OMITTED WHEN UNKNOWN, deliberately. Structured data that
 * asserts a wrong price or an invented rating is worse than none: Google
 * penalises mismatches between the markup and the visible page, and an answer
 * engine will repeat whatever it is told. So no placeholder dates, no zero
 * ratings, no guessed availability — if the listing does not know, the graph
 * stays silent.
 */
export function listingJsonLd(listing: Listing, canonicalUrl: string): Record<string, unknown> {
  const creatorName = listing.creator?.name ?? (listing.creator?.handle ? `@${listing.creator.handle}` : SITE);
  const image = listingShareImage(listing);
  const starts = listing.starts_at ? new Date(listing.starts_at).toISOString() : null;
  const ends = starts && listing.duration_min
    ? new Date(listing.starts_at! + listing.duration_min * 60_000).toISOString()
    : null;

  const event: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    '@id': `${canonicalUrl}#event`,
    name: listing.title,
    url: canonicalUrl,
    // Online by definition — every avaTOK session is a live stream or a 1:1
    // call, never a place someone travels to.
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    location: { '@type': 'VirtualLocation', url: canonicalUrl },
    organizer: { '@type': 'Person', name: creatorName },
    performer: { '@type': 'Person', name: creatorName },
    inLanguage: 'en-IN',
    isAccessibleForFree: listing.price === 0,
  };
  if (listing.description) event.description = clampDesc(listing.description, listing.title);
  if (image) event.image = [image];
  if (starts) event.startDate = starts;
  if (ends) event.endDate = ends;
  // [LISTING-EXPIRY-1] Say what actually happened to the show. schema.org has no
  // "completed" status, so an ended show carries no eventStatus and — below — no
  // purchasable offer, instead of a past startDate still marked InStock.
  const state = scheduleStateOf(listing);
  if (state === 'cancelled') event.eventStatus = 'https://schema.org/EventCancelled';
  else if (state === 'live' || state === 'upcoming' || state === 'starting') event.eventStatus = 'https://schema.org/EventScheduled';
  const sellable = listing.booking_open ?? !['ended', 'cancelled', 'expired'].includes(state);

  if (listing.price != null) {
    event.offers = {
      '@type': 'Offer',
      price: String(listing.price),
      priceCurrency: (listing.currency ?? 'INR').toUpperCase(),
      url: canonicalUrl,
      availability: sellable
        ? (listing.seats_left === 0 ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock')
        : 'https://schema.org/Discontinued',
      ...(starts && sellable ? { validFrom: new Date().toISOString() } : {}),
    };
  }

  // Ratings only when there are real ones. Google requires a review count > 0
  // for AggregateRating and rejects the whole block otherwise — and an
  // invented 5.0 on a show nobody has been to is exactly the kind of claim
  // this codebase keeps having to take back out.
  const count = listing.rating_count ?? 0;
  if (count > 0 && listing.rating_avg != null) {
    event.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(listing.rating_avg).toFixed(1),
      reviewCount: count,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return event;
}

/** [LISTING-SEO-1] Breadcrumbs — the trail Google prints under a result
 *  instead of a raw URL, and a cheap way for a crawler to learn the site's
 *  shape from a page it landed on directly. */
export function listingBreadcrumbLd(listing: Listing, canonicalUrl: string): Record<string, unknown> {
  const items: Array<{ name: string; item: string }> = [
    { name: 'avaTOK', item: 'https://avatok.ai/' },
    { name: 'Marketplace', item: 'https://avatok.ai/marketplace' },
  ];
  if (listing.creator?.handle) {
    items.push({ name: listing.creator.name ?? `@${listing.creator.handle}`, item: `https://avatok.ai/${listing.creator.handle}` });
  }
  items.push({ name: listing.title, item: canonicalUrl });
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: it.name, item: it.item,
    })),
  };
}

/** Build share meta for a creator channel page. */
export function creatorOg(creator: Creator): OgMeta {
  const name = creator.name ?? `@${creator.handle}`;
  const title = `${name} · ${SITE}`;
  const description = clampDesc(
    creator.bio,
    `${name} on ${SITE} — watch live, book a 1:1, or talk to their AI agent.`,
  );
  const image = socialImage(creator.avatar);
  return {
    title,
    description,
    image,
    extra: [
      { property: 'og:type', content: 'profile' },
      { property: 'profile:username', content: creator.handle },
    ],
  };
}
