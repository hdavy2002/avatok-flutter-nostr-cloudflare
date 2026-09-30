import type { Creator, Listing } from '../types';
import { scheduleStateOf } from '../card';
import { copyFor, takesPersonalSankalp } from '../eventTypes';
import { listingPath, creatorPath } from '../urls';
import type { ContentState, PublicContent } from './types';
import { BRAND } from '../brand';

function timestampIso(value: unknown): string | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number < 1e12 ? number * 1000 : number).toISOString();
}

function seoText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

export function listingContent(listing: Listing, image?: { url: string; alt: string }): PublicContent {
  const rawState = scheduleStateOf(listing);
  const state: ContentState = ['ended', 'cancelled', 'expired'].includes(rawState)
    ? rawState as ContentState
    : 'active';
  const attrs = (listing as any).attrs ?? {};
  const discovery = (listing as any).discovery;
  const hidden = Boolean(attrs.hide_from_marketplace || (listing as any).is_example || discovery?.indexable === false);
  const creatorName = listing.creator?.name ?? (listing.creator?.handle ? `@${listing.creator.handle}` : undefined);
  const starts = timestampIso(listing.starts_at);
  const duration = Number(listing.duration_min);
  const visiblePrice = listing.effective_price ?? listing.price ?? undefined;
  const ends = starts && Number.isFinite(duration) && duration > 0
    ? new Date(Date.parse(starts) + duration * 60_000).toISOString()
    : undefined;
  return {
    kind: 'listing',
    key: listing.id,
    canonicalPath: listingPath({ id: listing.id, handle: listing.creator?.handle, slug: (listing as any).slug }),
    // [SAATHUM-EVENT-FIELDS-1] attrs.seo is written by the worker on every admin save
    // (auto from the listing's own fields, or the admin's override). Older rows fall back.
    // [WEB-OG-SHARE-1 2026-09-29] OWNER DECISION: a shared listing must sell the
    // booking ("Book X in your name, live on <date>, from ₹N"), not paste the
    // start of the ritual's long description. An admin's hand-written SEO text
    // still wins; the worker's AUTO text (title_source/description_source 'auto')
    // is replaced by the booking pitch below.
    title: adminSeo(attrs.seo, 'title', 70) ?? listingShareTitle(listing, state),
    summary: adminSeo(attrs.seo, 'description', 200) ?? listingShareDescription(listing, state, visiblePrice),
    visibility: hidden ? 'unlisted' : 'public',
    state,
    modifiedAt: timestampIso(discovery?.updated_at ?? (listing as any).updated_at),
    image,
    breadcrumbs: [
      { name: 'Marketplace', path: '/marketplace' },
      { name: listing.title, path: listingPath({ id: listing.id, handle: listing.creator?.handle, slug: (listing as any).slug }) },
    ],
    listing: {
      startsAt: starts,
      endsAt: ends,
      price: visiblePrice,
      currency: ((listing as any).currency_display ?? listing.currency ?? 'INR').toUpperCase(),
      priceSemantics: listing.price_semantics ?? undefined,
      billingUnit: listing.billing_unit ?? undefined,
      free: Boolean(listing.free_entry) || visiblePrice === 0,
      creatorName,
      listingType: starts ? 'event' : 'service',
    },
    ad: listingAd(listing, visiblePrice),
  };
}

/** Only text an admin typed himself; the worker's auto-generated SEO is ignored. */
function adminSeo(seo: any, field: 'title' | 'description', max: number): string | undefined {
  if (!seo || seo[`${field}_source`] === 'auto') return undefined;
  return seoText(seo[field], max);
}

const IST_PARTS = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

/** "Sun 11 Oct" and "Sun 11 Oct, 7:00 AM IST", or undefined without a start time. */
function istWhen(startsAt: unknown): { day: string; full: string } | undefined {
  const n = Number(startsAt);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  try {
    const parts = Object.fromEntries(IST_PARTS.formatToParts(new Date(n < 1e12 ? n * 1000 : n)).map((p) => [p.type, p.value]));
    const day = `${parts.weekday} ${parts.day} ${parts.month}`;
    const time = `${parts.hour}:${parts.minute} ${String(parts.dayPeriod ?? '').toUpperCase()}`.trim();
    return { day, full: `${day}, ${time} IST` };
  } catch { return undefined; }
}

function listingShareTitle(listing: Listing, state: ContentState): string {
  const title = listing.title.trim();
  if (state !== 'active') return `${title} has ended – see upcoming havans & pujas`;
  const when = istWhen(listing.starts_at);
  return when ? `Book ${title} in your name – live ${when.day}` : `Book ${title} in your name – live from a Himalayan temple`;
}

function listingShareDescription(listing: Listing, state: ContentState, price: number | null | undefined): string {
  const attrs = (listing as any).attrs ?? {};
  const copy = copyFor(attrs);
  const title = listing.title.trim();
  if (state !== 'active') {
    return `This ${copy.noun} has ended. Book the next havan or puja at a Himalayan temple – watch it live from anywhere.`;
  }
  // The AI ad line often opens by repeating the title ("Gayatri Havan: Seek…"); drop that.
  const rawHook = typeof attrs.ad_hook?.text === 'string' ? attrs.ad_hook.text.replace(/\s+/g, ' ').trim() : '';
  const hook = rawHook.toLowerCase().startsWith(`${title.toLowerCase()}:`) ? rawHook.slice(title.length + 1).trim() : rawHook;
  const place = typeof (listing as any).location === 'string' && (listing as any).location.trim()
    ? (listing as any).location.trim() : 'a Himalayan temple';
  const when = istWhen(listing.starts_at);
  const amount = Number(price);
  // Kept under ~165 chars (truncateAtWord) so the call to book is never cut off.
  const priceText = Boolean(listing.free_entry) || amount === 0 ? 'free to join'
    : Number.isFinite(amount) && amount > 0 ? `from ₹${amount.toLocaleString('en-IN')}` : '';
  // [SAATHUM-SHARED-SANKALP-1] Only a one-family ritual promises a personal sankalp.
  const close = [takesPersonalSankalp(attrs) ? 'Sankalp in your name & gotra' : '', priceText].filter(Boolean).join(', ');
  return [
    hook && /[.!?]$/.test(hook) ? hook : hook ? `${hook}.` : '',
    `Watch it live from ${place}${when ? ` on ${when.full}` : ''}.`,
    close ? `${close.charAt(0).toUpperCase()}${close.slice(1)} – book your place now.` : 'Book your place now.',
  ].filter(Boolean).join(' ');
}

/** [OG-AD-HOOK-1] attrs.ad_hook is written by the worker (lib/listing_ad_hook.ts,
 *  AI on submit/approval). The price is the listing's REAL price, never the model's. */
function listingAd(listing: Listing, price: number | null | undefined): PublicContent['ad'] {
  const raw = (listing as any).attrs?.ad_hook;
  const hook = typeof raw?.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim().slice(0, 90) : '';
  if (!hook) return undefined;
  const currency = String((listing as any).currency_display ?? listing.currency ?? 'INR').toUpperCase();
  const amount = Number(price);
  const free = Boolean(listing.free_entry) || amount === 0;
  const label = free ? 'Free'
    : Number.isFinite(amount) && amount > 0
      ? (['INR', 'TOKENS', 'TOKEN', 'COINS', 'COIN', 'AVACOIN'].includes(currency) ? `from ₹${amount.toLocaleString('en-IN')}` : `from ${currency} ${amount}`)
      : undefined;
  return label ? { hook, price: label } : { hook };
}

export function creatorContent(creator: Creator, image?: { url: string; alt: string }): PublicContent {
  const path = creatorPath(creator.handle);
  const discovery = (creator as any).discovery;
  return {
    kind: 'creator',
    key: creator.id ?? creator.handle,
    canonicalPath: path,
    title: creator.name ? `${creator.name} (@${creator.handle})` : `@${creator.handle}`,
    summary: creator.bio ?? `See public listings from @${creator.handle} on ${BRAND.name}.`,
    visibility: discovery?.indexable === false ? 'unlisted' : 'public',
    modifiedAt: timestampIso(discovery?.updated_at),
    image,
    breadcrumbs: [
      { name: 'Marketplace', path: '/marketplace' },
      { name: creator.name ?? `@${creator.handle}`, path },
    ],
    creator: { handle: creator.handle, name: creator.name ?? undefined, bio: creator.bio ?? undefined },
  };
}
