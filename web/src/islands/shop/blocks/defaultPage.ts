// [SAATHUM-SHOP-EDITOR-1 2026-10-01] THE default /shop home page — exactly what the page showed before it became editable
// (the owner-approved mockup copy, plus whatever the old Promote-to-cards hero / featured-banner settings held).
//
// NOTE FOR AI:
//  - ONE definition. worker/src/lib/shop_page.ts holds a mirror (the worker cannot import web code at build time);
//    worker/test/shop_page.test.ts imports THIS file and fails if the two ever disagree. Change both together.
//  - Pure: no imports except types, so the worker test can load it. The brand name is passed in (never typed here).
//  - Defaults are applied with the SAME expressions the old index.astro used (|| and ??), so a page with no
//    published version renders pixel-identical to before.
import type { PageData, PageItem } from './types';

export interface DefaultHeroInput {
  image_url?: string | null; eyebrow?: string; title?: string; title_em?: string; lead?: string; cta_label?: string;
  second_cta_collection?: string | null; ticks?: string[]; promise?: { title: string; sub: string }[];
  hotspots?: { product_id: string; x: number; y: number }[];
}
export interface DefaultBannerInput {
  product_id: string; eyebrow?: string; title?: string; text?: string; cta_label?: string; image_url?: string | null;
}
export interface DefaultInputs { brandName: string; hero?: DefaultHeroInput | null; banner?: DefaultBannerInput | null }

export function buildDefaultPage({ brandName, hero: h0, banner: b0 }: DefaultInputs): PageData {
  const hero = h0 ?? {};
  const title = hero.title || 'Wear your faith,';
  const titleEm = hero.title_em ?? (hero.title ? '' : 'softly.');
  const content: PageItem[] = [
    {
      type: 'ShopHero',
      props: {
        id: 'hero',
        image: hero.image_url || '',
        eyebrow: hero.eyebrow || `The ${brandName} Shop · New season`,
        title,
        titleEm,
        lead: hero.lead || 'Pure cotton T-shirts with Mahadev, Krishna, lotus and Himalayan temple art — designed by us, printed to order in India and delivered free, pan India.',
        ctaLabel: hero.cta_label || 'Shop all T-shirts →',
        secondCollection: hero.second_cta_collection || '',
        ticks: (hero.ticks?.length ? hero.ticks : ['100% cotton, 180 GSM', 'Sizes S to 3XL + kids', 'Pay by UPI']).map((text) => ({ text })),
        promise: hero.promise?.length ? hero.promise.map((p) => ({ title: p.title, sub: p.sub })) : [
          { title: 'Free shipping', sub: 'Pan India, every order' },
          { title: 'Printed to order', sub: 'Made just for you' },
          { title: 'Pay by any UPI app', sub: 'Scan the QR, done' },
        ],
        promiseLinkLabel: 'Tap a dot to shop the stack →',
        hotspots: (hero.hotspots ?? []).filter((s) => s?.product_id).map((s) => ({ product: s.product_id, x: Number(s.x), y: Number(s.y) })),
      },
    },
    {
      type: 'CollectionGrid',
      props: {
        id: 'collections', title: 'Shop by collection', subtitle: 'Every design starts from a story — a deity, a temple, a mantra.',
        linkLabel: 'All collections', tiles: [],
      },
    },
    {
      type: 'ProductRail',
      props: {
        id: 'new-arrivals', title: 'New arrivals', subtitle: 'Fresh off the press this week.', linkLabel: 'View all', linkHref: '/shop/all?sort=new',
        source: 'new_arrivals', collection: '', products: [], count: 4, hideWhenEmpty: false,
        emptyTitle: 'New T-shirts are coming soon', emptyText: 'We are printing our first designs. Please check back shortly.',
        emptyButtonLabel: 'Explore pujas and havans', emptyButtonHref: '/marketplace',
      },
    },
  ];
  if (b0?.product_id) {
    content.push({
      type: 'FeaturedBanner',
      props: {
        id: 'banner', eyebrow: b0.eyebrow ?? '', title: b0.title ?? '', text: b0.text ?? '',
        ctaLabel: b0.cta_label || 'See the tee →', product: b0.product_id, image: b0.image_url || '',
      },
    });
  }
  content.push({
    type: 'ProductRail',
    props: {
      id: 'bestsellers', title: 'Bestsellers', subtitle: 'What devotees are wearing the most.', linkLabel: 'View all', linkHref: '/shop/all',
      source: 'bestsellers', collection: '', products: [], count: 4, hideWhenEmpty: true,
      emptyTitle: '', emptyText: '', emptyButtonLabel: '', emptyButtonHref: '',
    },
  });
  return { root: { props: {} }, content, zones: {} };
}
