// OpenGraph / Twitter meta builder — LOCAL to Phase A (not shared kit).
// Turns a listing/creator into the props Base.astro accepts (title, description,
// image) plus a few extra og: tags the share-preview funnel benefits from.
//
// Images run through the Cloudflare image-transform pattern (cfImage) at a
// social-friendly 1200px so link unfurls look crisp. Never hardcode a hex/URL.

import { cfImage } from './config';
import type { Creator, Listing } from './types';

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

/** Build share meta for a listing detail / event page. */
export function listingOg(listing: Listing): OgMeta {
  const creator = listing.creator?.name ?? (listing.creator?.handle ? `@${listing.creator.handle}` : SITE);
  const title = `${listing.title} · ${creator}`;
  const description = clampDesc(
    listing.description,
    `${listing.title} on ${SITE} — browse, book and watch without installing the app.`,
  );
  const image = socialImage(listing.poster);
  const extra: OgMeta['extra'] = [{ property: 'og:type', content: 'product' }];
  if (listing.price != null) {
    extra.push({ property: 'product:price:amount', content: String(listing.price) });
    extra.push({ property: 'product:price:currency', content: (listing.currency ?? 'USD').toUpperCase() });
  }
  return { title, description, image, extra };
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
