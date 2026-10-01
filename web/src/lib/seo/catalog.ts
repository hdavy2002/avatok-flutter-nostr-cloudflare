import type { PublicContent } from './types';
import { BRAND } from '../brand';
import type { ShopProduct } from '../shopApi';

export const MARKETPLACE_SEO: PublicContent = {
  kind: 'collection',
  key: 'marketplace',
  canonicalPath: '/marketplace',
  title: `Havans & Pujas at Himalayan Temples · ${BRAND.name}`,
  summary: 'Book havans and pujas performed by pujaris at positive Himalayan temples. Filter by deity, wish, date or price; your sankalp in your name and gotra, the video filmed by our crew, dry prasad delivered to your door.',
  visibility: 'public',
  image: { url: '/assets/grand/hero.png', alt: `Havans and pujas at Himalayan temples — ${BRAND.name}.` },
};

// [WEB-HIW-2 2026-09-27] /how-it-works moved off layouts/Content.astro onto the
// folk shell. These are the exact values Content.astro used to derive from the
// page's props (title / description / updated / default og image), kept so the
// page's title, canonical, summary and social card do not change.
export const HOW_IT_WORKS_SEO: PublicContent = {
  kind: 'page',
  key: '/how-it-works',
  canonicalPath: '/how-it-works',
  title: 'How we perform your havan at a Himalayan temple',
  summary: 'How our crew travels to a Himalayan temple, how the pujari performs your havan or puja in your name and gotra, live streaming and the full video, weather delays and same-day dry prasad.',
  visibility: 'public',
  modifiedAt: new Date('2026-09-27').toISOString(),
  image: { url: '/og-editorial.png', alt: `How we perform your havan at a Himalayan temple — ${BRAND.name}` },
};

// [WEB-TEMPLES-1 2026-09-29] /temples — "Our temples" (header + footer menus).
export const TEMPLES_SEO: PublicContent = {
  kind: 'page',
  key: '/temples',
  canonicalPath: '/temples',
  title: 'Our temples — Haridwar, Rishikesh, Kedarnath, Badrinath & Himachal',
  summary: `The temples ${BRAND.name} works with across Uttarakhand and Himachal. Our team visits with a camera crew and live streams your puja, sends the full video if the network drops, and ships dry prasad the same day.`,
  visibility: 'public',
  modifiedAt: new Date('2026-09-29').toISOString(),
  image: { url: '/og-editorial.png', alt: `The temples we work with — ${BRAND.name}` },
};

export const HELP_SEO: PublicContent = {
  kind: 'collection',
  key: 'help',
  canonicalPath: '/help',
  title: 'Help centre',
  summary: `Guides for booking and paying for pujas and havans on ${BRAND.name} — search or browse by topic.`,
  visibility: 'public',
};

// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The Shop (Hindu T-shirts). Titles/summaries never type the brand name:
// resolve.ts appends it. Pages with no uploaded photo fall back to the editorial share card, like /temples.
const SHOP_FALLBACK_IMAGE = '/og-editorial.png';
const SHOP_MODIFIED = new Date('2026-10-01').toISOString();

export const SHOP_SEO: PublicContent = {
  kind: 'collection',
  key: 'shop',
  canonicalPath: '/shop',
  title: 'Hindu T-shirts — printed to order, free shipping across India',
  summary: 'Pure cotton T-shirts with Mahadev, Krishna, lotus and Himalayan temple art — designed by us, printed to order in India and delivered free, pan India. Pay by any UPI app.',
  visibility: 'public',
  modifiedAt: SHOP_MODIFIED,
  image: { url: SHOP_FALLBACK_IMAGE, alt: `The ${BRAND.name} Shop — Hindu T-shirts` },
  breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }],
};

export const SHOP_ALL_SEO: PublicContent = {
  kind: 'collection',
  key: 'shop/all',
  canonicalPath: '/shop/all',
  title: 'All Hindu T-shirts — filter by collection, colour, size and fit',
  summary: 'Every T-shirt in the shop: Mahadev, Krishna, lotus and Himalayan temple designs in cotton, regular and oversized fits, adults and kids. Free shipping across India.',
  visibility: 'public',
  modifiedAt: SHOP_MODIFIED,
  image: { url: SHOP_FALLBACK_IMAGE, alt: `All T-shirts — ${BRAND.name} Shop` },
  breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }, { name: 'All T-shirts', path: '/shop/all' }],
};

export function shopCollectionContent(c: { slug: string; name: string; blurb?: string | null; image_url?: string | null }): PublicContent {
  const path = `/shop/c/${c.slug}`;
  return {
    kind: 'collection',
    key: `shop/c/${c.slug}`,
    canonicalPath: path,
    title: `${c.name} T-shirts — Hindu T-shirts, free shipping across India`,
    summary: c.blurb ? `${c.blurb}. ${c.name} T-shirts printed to order in India, free shipping pan India.` : `${c.name} T-shirts printed to order in India, free shipping pan India.`,
    visibility: 'public',
    modifiedAt: SHOP_MODIFIED,
    image: { url: c.image_url || SHOP_FALLBACK_IMAGE, alt: `${c.name} T-shirts — ${BRAND.name} Shop` },
    breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }, { name: 'All T-shirts', path: '/shop/all' }, { name: c.name, path },
    ],
  };
}

export function shopProductContent(p: ShopProduct): PublicContent {
  const path = `/shop/p/${p.slug}`;
  const photo = p.images?.[0]?.url || p.image_url;
  const fallbackSummary = `${p.name}${p.collection ? ` from our ${p.collection.name} collection` : ''}: ${p.print_type.toLowerCase()} on a ${p.fit.toLowerCase()} fit cotton T-shirt, printed to order in India. Free shipping across India.`;
  const crumbs = [{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }];
  if (p.collection) crumbs.push({ name: p.collection.name, path: `/shop/c/${p.collection.slug}` });
  crumbs.push({ name: p.name, path });
  return {
    kind: 'listing',
    key: `shop/p/${p.slug}`,
    canonicalPath: path,
    title: p.seo_title || `${p.name} — Hindu T-shirt${p.collection ? `, ${p.collection.name} collection` : ''}`,
    summary: p.seo_description || (p.description ? p.description.replace(/\s+/g, ' ').trim() : fallbackSummary),
    visibility: 'public',
    image: { url: photo || SHOP_FALLBACK_IMAGE, alt: p.name },
    breadcrumbs: crumbs,
    listing: { listingType: 'product', price: p.price_rupees, currency: 'INR', priceSemantics: 'fixed' },
  };
}
