import type { Creator, Listing } from '../types';
import { scheduleStateOf } from '../card';
import { listingPath, creatorPath } from '../urls';
import type { ContentState, PublicContent } from './types';

function timestampIso(value: unknown): string | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number < 1e12 ? number * 1000 : number).toISOString();
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
    title: creatorName ? `${listing.title} · ${creatorName}` : listing.title,
    summary: listing.description ?? `${listing.title}${creatorName ? ` by ${creatorName}` : ''}, available on Saathum.`,
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
  };
}

export function creatorContent(creator: Creator, image?: { url: string; alt: string }): PublicContent {
  const path = creatorPath(creator.handle);
  const discovery = (creator as any).discovery;
  return {
    kind: 'creator',
    key: creator.id ?? creator.handle,
    canonicalPath: path,
    title: creator.name ? `${creator.name} (@${creator.handle})` : `@${creator.handle}`,
    summary: creator.bio ?? `See public listings from @${creator.handle} on ${'Saathum'}.`,
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
