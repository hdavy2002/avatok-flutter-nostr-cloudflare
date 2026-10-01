// [SAATHUM-SHOP-EDITOR-2 2026-10-02] The shop-home blocks (web/src/islands/shop/blocks): live rules vs editor rules.
// Lives in the worker suite because that is where the web default page is already parity-tested (shop_page.test.ts).
import { describe, it, expect } from 'vitest';
import { createElement } from '../../web/node_modules/react';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server';
import FeaturedBannerBlock from '../../web/src/islands/shop/blocks/FeaturedBannerBlock';
import CollectionGridBlock from '../../web/src/islands/shop/blocks/CollectionGridBlock';
import ProductRailBlock from '../../web/src/islands/shop/blocks/ProductRailBlock';
import { buildDefaultPage } from '../../web/src/islands/shop/blocks/defaultPage';
import { collectionTiles, isVisible } from '../../web/src/islands/shop/blocks/util';
import { emptyResolved } from '../../web/src/islands/shop/blocks/types';

const banner = { eyebrow: 'Featured · Navratri drop', title: 'The Lotus & Diya tee', text: 'Words', ctaLabel: 'See the tee →', ctaHref: '/shop/all', product: '', image: '' };
const col = (o: any) => ({ id: 'c', slug: 'c', name: 'C', blurb: '', image_url: null, count: 0, ...o });
const html = (el: any) => renderToStaticMarkup(el);
const ctx = (o: any = {}) => ({ collections: [], resolved: emptyResolved(), ...o });

describe('FeaturedBanner', () => {
  it('renders without a product: title, the placeholder photo and a button to its own link', () => {
    const h = html(createElement(FeaturedBannerBlock, { ...banner, ctx: ctx() }));
    expect(h).toContain('The Lotus &amp; Diya tee');
    expect(h).toContain('Feature banner photo');
    expect(h).toContain('href="/shop/all"');
    expect(h).toContain('See the tee →');
  });
  it('a chosen product wins: the button opens its page and its photo fills the banner', () => {
    const product = { id: 'p', slug: 'lotus-tee', name: 'Lotus', price_rupees: 1, mrp_rupees: null, off_pct: null, badge: '', colours: [], sizes: [], image_url: '/assets/x.jpg', collection: null };
    const h = html(createElement(FeaturedBannerBlock, { ...banner, product: 'p', ctx: ctx({ resolved: { products: { p: product }, rails: {} } }) }));
    expect(h).toContain('href="/shop/p/lotus-tee"');
    expect(h).not.toContain('Feature banner photo');
  });
  it('no title = nothing on the live page, but always something in the editor', () => {
    expect(html(createElement(FeaturedBannerBlock, { ...banner, title: '', ctx: ctx() }))).toBe('');
    expect(html(createElement(FeaturedBannerBlock, { ...banner, title: '', ctx: ctx({ editing: true }) }))).toContain('sh-banner');
  });
});

describe('CollectionGrid', () => {
  const props = { title: 'Shop by collection', subtitle: 's', linkLabel: 'All', tiles: [] };
  it('live: only collections with a live product; nothing at all when none qualify', () => {
    const tiles = collectionTiles(props, [col({ id: 'a', slug: 'a', count: 2 }), col({ id: 'b', slug: 'b', count: 0 })]);
    expect(tiles.map((t) => t.c.slug)).toEqual(['a']);
    expect(html(createElement(CollectionGridBlock, { ...props, ctx: ctx({ collections: [col({ count: 0 })] }) }))).toBe('');
    expect(isVisible({ type: 'CollectionGrid', props: { id: 'x', ...props } } as any, ctx({ collections: [col({ count: 0 })] }))).toBe(false);
  });
  it('editor: six placeholder tiles and the hint when there are no collections', () => {
    const h = html(createElement(CollectionGridBlock, { ...props, ctx: ctx({ editing: true }) }));
    expect(h.match(/class="sh-cat"/g)?.length).toBe(6);
    expect(h).toContain('Collection art');
    expect(h).toContain('Your collection');
    expect(h).toContain('Admin → Shop → Categories');
  });
  it('the collection photo fills the tile', () => {
    const h = html(createElement(CollectionGridBlock, { ...props, ctx: ctx({ collections: [col({ count: 1, image_url: 'https://media.example.in/c.jpg', name: 'Shiva' })] }) }));
    expect(h).toContain('<img');
    expect(h).toContain('Shiva');
  });
});

describe('ProductRail', () => {
  const rail = { id: 'new-arrivals', title: 'New arrivals', subtitle: 's', linkLabel: 'View all', linkHref: '/shop/all?tag=new', source: 'new_arrivals', collection: '', products: [], count: 4, hideWhenEmpty: true, emptyTitle: '', emptyText: '', emptyButtonLabel: '', emptyButtonHref: '' };
  it('live: an empty hide-when-empty row is omitted', () => {
    expect(html(createElement(ProductRailBlock, { ...rail, ctx: ctx() } as any))).toBe('');
  });
  it('editor: an empty row shows 4 placeholder cards and the hint', () => {
    const h = html(createElement(ProductRailBlock, { ...rail, ctx: ctx({ editing: true }) } as any));
    expect(h.match(/class="sh-card"/g)?.length).toBe(4);
    expect(h).toContain('T-shirt photo');
    expect(h).toContain('Your T-shirt');
    expect(h).toContain('₹—');
    expect(h).toContain('Mark products as New arrival / Bestseller in Admin → Shop → Products');
  });
});

describe('default page', () => {
  it('has the five mockup sections in order', () => {
    expect(buildDefaultPage({ brandName: 'X' }).content.map((c) => c.type)).toEqual(['ShopHero', 'CollectionGrid', 'ProductRail', 'FeaturedBanner', 'ProductRail']);
  });
});
