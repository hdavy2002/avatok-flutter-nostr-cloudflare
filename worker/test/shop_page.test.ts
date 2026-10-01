// [SAATHUM-SHOP-EDITOR-1 2026-10-01] Shop-home page editor: validation, default-page parity with the web, resolution.
import { describe, it, expect } from 'vitest';
import { BRAND } from '../src/lib/brand';
import { buildDefaultPage, parseRecord, resolvePage, validatePage, PAGE_MAX_BYTES, type Snapshot } from '../src/lib/shop_page';
import { buildDefaultPage as webDefault } from '../../web/src/islands/shop/blocks/defaultPage';

const hero = { id: 'hero', image: '', eyebrow: 'E', title: 'T', titleEm: 'em', lead: 'L', ctaLabel: 'Go', secondCollection: '', ticks: [{ text: 'a' }], promise: [{ title: 'p', sub: 's' }], promiseLinkLabel: 'tap', hotspots: [] };
const page = (...content: any[]) => ({ root: { props: {} }, content });

describe('default page parity (worker mirror === web defaultPage.ts)', () => {
  const cases: Array<[string, any, any]> = [
    ['nothing configured', null, null],
    ['hero + banner configured', {
      image_url: 'https://media.example.in/h.jpg', eyebrow: 'Navratri', title: 'Hello', title_em: 'world', lead: 'Lead', cta_label: 'Go →', second_cta_collection: 'shiva',
      ticks: ['x', 'y'], promise: [{ title: 'A', sub: 'a' }], hotspots: [{ product_id: 'p1', x: 10.5, y: 20 }, { product_id: '', x: 1, y: 1 }],
    }, { product_id: 'p2', eyebrow: 'Featured', title: 'Tee', text: 'Text', cta_label: '', image_url: null }],
    ['saved-empty hero (title_em empty string)', { title: '', title_em: '', eyebrow: '', lead: '', cta_label: '', ticks: [], promise: [], hotspots: [] }, null],
    ['title without title_em', { title: 'Only title' }, null],
  ];
  for (const [name, h, b] of cases) {
    it(name, () => {
      expect(JSON.parse(JSON.stringify(buildDefaultPage({ brandName: BRAND.name, hero: h, banner: b }))))
        .toEqual(JSON.parse(JSON.stringify(webDefault({ brandName: BRAND.name, hero: h, banner: b }))));
    });
  }
  it('the default always validates and survives a round trip unchanged', () => {
    const d = buildDefaultPage({ brandName: BRAND.name, hero: { hotspots: [{ product_id: 'p1', x: 5, y: 6 }] }, banner: { product_id: 'p2', title: 'T' } });
    const v = validatePage(d);
    expect('data' in v && v.data).toEqual(JSON.parse(JSON.stringify(d)));
  });
});

describe('validatePage', () => {
  it('accepts a minimal page and rebuilds it from a whitelist', () => {
    const v = validatePage(page({ type: 'TextSection', props: { id: 't1', heading: 'Hi', text: 'There', evil: 'x' }, extra: 1 }));
    expect(v).toEqual({ data: { root: { props: {} }, content: [{ type: 'TextSection', props: { id: 't1', heading: 'Hi', text: 'There' } }], zones: {} } });
  });
  it('rejects unknown block types, duplicate ids and bad ids', () => {
    expect('errors' in validatePage(page({ type: 'Script', props: { id: 'a' } }))).toBe(true);
    expect('errors' in validatePage(page({ type: 'TextSection', props: { id: 'a' } }, { type: 'TextSection', props: { id: 'a' } }))).toBe(true);
    expect('errors' in validatePage(page({ type: 'TextSection', props: { id: 'a b' } }))).toBe(true);
    expect('errors' in validatePage(page({ type: 'TextSection', props: {} }))).toBe(true);
  });
  it('rejects non-objects, a missing content list and too many blocks', () => {
    expect('errors' in validatePage(null)).toBe(true);
    expect('errors' in validatePage([])).toBe(true);
    expect('errors' in validatePage({ root: {} })).toBe(true);
    expect('errors' in validatePage(page(...Array.from({ length: 41 }, (_, i) => ({ type: 'TextSection', props: { id: `t${i}` } }))))).toBe(true);
  });
  it('rejects a page over 200 KB', () => {
    const v = validatePage(page({ type: 'TextSection', props: { id: 'a', text: 'x'.repeat(PAGE_MAX_BYTES) } }));
    expect('errors' in v && v.errors[0].message).toMatch(/200 KB/);
  });
  it('strips HTML, collapses whitespace and caps string lengths', () => {
    const v = validatePage(page({ type: 'ShopHero', props: { ...hero, title: '  <b>Wear</b>   <script>alert(1)</script>faith  ', lead: 'x'.repeat(900) } }));
    expect('data' in v).toBe(true);
    if ('data' in v) {
      const p = v.data.content[0].props as any;
      expect(p.title).toBe('Wear alert(1)faith');
      expect(p.lead.length).toBe(300);
    }
  });
  it('only accepts uploaded https images or site /assets/ paths', () => {
    const ok = (image: string) => 'data' in validatePage(page({ type: 'PhotoBanner', props: { id: 'p', image } }));
    expect(ok('https://media.example.in/a.jpg')).toBe(true);
    expect(ok('/assets/a.png')).toBe(true);
    expect(ok('')).toBe(true);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('http://insecure.example/a.jpg')).toBe(false);
    expect(ok('data:image/png;base64,AAAA')).toBe(false);
  });
  it('only accepts site paths and https links as hrefs', () => {
    const ok = (ctaHref: string) => 'data' in validatePage(page({ type: 'PhotoBanner', props: { id: 'p', ctaHref } }));
    expect(ok('/shop/all')).toBe(true);
    expect(ok('https://example.in/x')).toBe(true);
    expect(ok('')).toBe(true);
    expect(ok('//evil.example')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
  });
  it('clamps rail counts, falls back on bad sources, bounds hotspots', () => {
    const rail = (props: any) => { const v = validatePage(page({ type: 'ProductRail', props: { id: 'r', ...props } })); return 'data' in v ? (v.data.content[0].props as any) : null; };
    expect(rail({ count: 99 }).count).toBe(12);
    expect(rail({ count: 0 }).count).toBe(1);
    expect(rail({ count: 'x' }).count).toBe(4);
    expect(rail({ source: 'drop table' }).source).toBe('new_arrivals');
    expect(rail({ source: 'sale' }).source).toBe('sale');
    expect('errors' in validatePage(page({ type: 'ShopHero', props: { ...hero, hotspots: [{ product: 'p', x: 120, y: 5 }] } }))).toBe(true);
    expect('errors' in validatePage(page({ type: 'ShopHero', props: { ...hero, hotspots: Array.from({ length: 9 }, () => ({ product: 'p', x: 1, y: 1 })) } }))).toBe(true);
  });
});

describe('parseRecord', () => {
  it('survives junk and caps history at five', () => {
    expect(parseRecord('not json').published).toBeNull();
    expect(parseRecord(null).history).toEqual([]);
    const d = { root: { props: {} }, content: [] };
    const rec = parseRecord(JSON.stringify({ published: d, history: Array.from({ length: 9 }, () => ({ data: d, at: 1, by: 'u' })), draft: 'nope' }));
    expect(rec.history.length).toBe(5);
    expect(rec.draft).toBeNull();
  });
});

describe('resolvePage', () => {
  const row = (o: any) => ({
    id: 'x', slug: 'x', name: 'X', collection_id: null, description: '', fit: 'Regular', print_type: 'DTG', audience: 'Adults', price_rupees: 500, mrp_rupees: null,
    colours_json: '[]', sizes_json: '["M"]', images_json: '[]', badge: '', status: 'live', printrove_ref: null, sold_count: 0, seo_title: null, seo_description: null,
    archived_at: null, created_at: 1, updated_at: 1, ...o,
  });
  const snap: Snapshot = {
    live: [
      row({ id: 'a', slug: 'a', created_at: 10, sold_count: 1, collection_id: 'c1', is_new: 1 }),
      row({ id: 'b', slug: 'b', created_at: 30, sold_count: 9, mrp_rupees: 1000, is_new: 1, is_bestseller: 1 }),
      row({ id: 'c', slug: 'c', created_at: 20, sold_count: 5, badge: 'sale', is_bestseller: 1 }),
      row({ id: 'd', slug: 'd', created_at: 40, sold_count: 0 }),
    ] as any,
    cols: [{ id: 'c1', slug: 'shiva', name: 'Shiva', blurb: '', image_url: null, sort: 0, active: 1 }],
  };
  const rail = (props: any, s: Snapshot = snap) => resolvePage(page({ type: 'ProductRail', props: { id: 'r', count: 4, products: [], ...props } }) as any, s).rails.r.map((p) => p.id);

  it('new arrivals = products flagged New arrival, newest first (not the newest products)', () => {
    expect(rail({ source: 'new_arrivals' })).toEqual(['b', 'a']);
    expect(rail({ source: 'new_arrivals', count: 1 })).toEqual(['b']);
  });
  it('bestsellers = products flagged Bestseller, most sold first', () => {
    expect(rail({ source: 'bestsellers' })).toEqual(['b', 'c']);
  });
  it('nothing flagged = empty rows (the page shows its coming-soon box / hides the row)', () => {
    const none: Snapshot = { ...snap, live: snap.live.map((p) => ({ ...p, is_new: 0, is_bestseller: 0 })) as any };
    expect(rail({ source: 'new_arrivals' }, none)).toEqual([]);
    expect(rail({ source: 'bestsellers' }, none)).toEqual([]);
  });
  it('missing flag columns (migration not applied) read as 0 and never throw', () => {
    const old: Snapshot = { ...snap, live: snap.live.map(({ is_new, is_bestseller, ...rest }: any) => rest) as any };
    expect(rail({ source: 'new_arrivals' }, old)).toEqual([]);
    expect(rail({ source: 'bestsellers' }, old)).toEqual([]);
    expect(rail({ source: 'sale' }, old)).toEqual(['b', 'c']);
  });
  it('sale, collection and manual sources', () => {
    expect(rail({ source: 'sale' })).toEqual(['b', 'c']);
    expect(rail({ source: 'collection', collection: 'shiva' })).toEqual(['a']);
    expect(rail({ source: 'collection', collection: 'nope' })).toEqual([]);
    expect(rail({ source: 'manual', products: [{ product: 'c' }, { product: 'gone' }, { product: 'a' }] })).toEqual(['c', 'a']);
  });
  it('resolves hotspot and banner products, skipping ones that are not live', () => {
    const r = resolvePage(page(
      { type: 'ShopHero', props: { ...hero, hotspots: [{ product: 'a', x: 1, y: 1 }, { product: 'gone', x: 2, y: 2 }] } },
      { type: 'FeaturedBanner', props: { id: 'b', product: 'b' } },
      { type: 'FeaturedBanner', props: { id: 'b2', product: '' } },
    ) as any, snap);
    expect(Object.keys(r.products).sort()).toEqual(['a', 'b']);
    expect(r.products.a.collection).toEqual({ slug: 'shiva', name: 'Shiva' });
    expect(r.products.b.is_new).toBe(true);
    expect(r.products.b.is_bestseller).toBe(true);
  });
});

describe('the default page (SAATHUM-SHOP-EDITOR-2)', () => {
  const d = buildDefaultPage({ brandName: BRAND.name });
  it('has all five mockup sections, in order, even with nothing configured', () => {
    expect(d.content.map((c) => [c.type, c.props.id])).toEqual([
      ['ShopHero', 'hero'], ['CollectionGrid', 'collections'], ['ProductRail', 'new-arrivals'], ['FeaturedBanner', 'banner'], ['ProductRail', 'bestsellers'],
    ]);
  });
  it('the banner carries the mockup copy and needs no product', () => {
    const b = d.content[3].props as any;
    expect(b.eyebrow).toBe('Featured · Navratri drop');
    expect(b.title).toBe('The Lotus & Diya tee — light for every home.');
    expect(b.ctaLabel).toBe('See the tee →');
    expect(b.ctaHref).toBe('/shop/all');
    expect(b.product).toBe('');
  });
  it('the View all links point at the flagged lists', () => {
    expect((d.content[2].props as any).linkHref).toBe('/shop/all?tag=new');
    expect((d.content[4].props as any).linkHref).toBe('/shop/all?tag=best');
  });
});
