import { describe, it, expect } from 'vitest';
import {
  computeShopQuote, normalizeProductInput, slugify, toShopCard, parseColours, parseSizes, parseImages,
  type ProductRow, type CouponRow,
} from './shop_logic';

const prod = (over: Partial<ProductRow> = {}): ProductRow => ({
  id: 'prd-aaaa1111', slug: 'om-tee', name: 'Om Tee', collection_id: 'col-1', description: '', fit: 'Regular',
  print_type: 'Big front print', audience: 'Adults', price_rupees: 499, mrp_rupees: 699,
  colours_json: JSON.stringify([{ name: 'Black', hex: '#222222' }, { name: 'White', hex: '#ffffff' }]),
  sizes_json: JSON.stringify(['S', 'M', 'L']), images_json: JSON.stringify([{ url: 'https://x.test/a.jpg', label: 'Front' }]),
  badge: '', status: 'live', printrove_ref: null, sold_count: 0, seo_title: null, seo_description: null,
  archived_at: null, created_at: 1, updated_at: 1, ...over,
});
const coupon = (over: Partial<CouponRow> = {}): CouponRow => ({
  code: 'OM10', kind: 'pct', value: 10, min_order_rupees: 0, max_uses: null, used_count: 0, valid_until: null, active: 1, ...over,
});
const map = (...ps: ProductRow[]) => new Map(ps.map((p) => [p.id, p]));
const NOW = 1_800_000_000_000;

describe('computeShopQuote', () => {
  it('prices a single line with GST added and free shipping', () => {
    const r = computeShopQuote({ items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 2 }], products: map(prod()), coupon: null, gstRatePct: 18, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quote.subtotal_rupees).toBe(998);
      expect(r.quote.gst_rupees).toBe(180); // 179.64 -> 180
      expect(r.quote.total_rupees).toBe(1178);
      expect(r.quote.shipping_rupees).toBe(0);
    }
  });
  it('merges duplicate lines', () => {
    const r = computeShopQuote({ items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 2 }, { product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 3 }], products: map(prod()), coupon: null, gstRatePct: 18, now: NOW });
    expect(r.ok && r.quote.lines.length === 1 && r.quote.lines[0].qty === 5).toBe(true);
  });
  it('rejects non-live products, bad colour/size/qty', () => {
    const base = { products: map(prod({ status: 'draft' })), coupon: null, gstRatePct: 18, now: NOW };
    expect(computeShopQuote({ ...base, items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 1 }] })).toMatchObject({ ok: false, error: 'product_unavailable', line: 0 });
    const live = { products: map(prod()), coupon: null, gstRatePct: 18, now: NOW };
    expect(computeShopQuote({ ...live, items: [{ product_id: 'prd-aaaa1111', colour: 'Red', size: 'M', qty: 1 }] })).toMatchObject({ error: 'invalid_colour' });
    expect(computeShopQuote({ ...live, items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'XXL', qty: 1 }] })).toMatchObject({ error: 'invalid_size' });
    expect(computeShopQuote({ ...live, items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 11 }] })).toMatchObject({ error: 'invalid_qty' });
    expect(computeShopQuote({ ...live, items: [] })).toMatchObject({ ok: false });
  });
  it('applies pct and flat coupons and GST on the discounted amount', () => {
    const items = [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 2 }];
    const a = computeShopQuote({ items, products: map(prod()), coupon: coupon(), gstRatePct: 18, now: NOW });
    expect(a.ok && a.quote.discount_rupees).toBe(100); // 99.8 -> 100
    expect(a.ok && a.quote.taxable_rupees).toBe(898);
    const b = computeShopQuote({ items, products: map(prod()), coupon: coupon({ kind: 'flat', value: 5000 }), gstRatePct: 18, now: NOW });
    expect(b.ok && b.quote.discount_rupees).toBe(997); // capped at subtotal-1
  });
  it('reports coupon errors', () => {
    const items = [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 1 }];
    const run = (c: CouponRow) => computeShopQuote({ items, products: map(prod()), coupon: c, gstRatePct: 18, now: NOW });
    expect(run(coupon({ active: 0 }))).toMatchObject({ error: 'coupon_invalid' });
    expect(run(coupon({ valid_until: NOW - 1 }))).toMatchObject({ error: 'coupon_expired' });
    expect(run(coupon({ max_uses: 1, used_count: 1 }))).toMatchObject({ error: 'coupon_invalid' });
    expect(run(coupon({ min_order_rupees: 1000 }))).toMatchObject({ error: 'coupon_min_order' });
  });
  it('charges no GST at rate 0', () => {
    const r = computeShopQuote({ items: [{ product_id: 'prd-aaaa1111', colour: 'Black', size: 'M', qty: 1 }], products: map(prod()), coupon: null, gstRatePct: 0, now: NOW });
    expect(r.ok && r.quote.gst_rupees).toBe(0);
    expect(r.ok && r.quote.total_rupees).toBe(499);
  });
});

describe('helpers', () => {
  it('slugify', () => {
    expect(slugify('  Om Namah Shivaya! Tee  ')).toBe('om-namah-shivaya-tee');
    expect(slugify('!!!')).toBe('');
  });
  it('parsers tolerate junk', () => {
    expect(parseColours('nope')).toEqual([]);
    expect(parseSizes('[1,"S"]')).toEqual(['S']);
    expect(parseImages('[{"url":"https://a"}]')).toEqual([{ url: 'https://a', label: '' }]);
  });
  it('toShopCard computes off_pct and first image', () => {
    const c = toShopCard(prod(), { slug: 'om', name: 'Om' });
    expect(c.off_pct).toBe(29);
    expect(c.image_url).toBe('https://x.test/a.jpg');
    expect(c.collection).toEqual({ slug: 'om', name: 'Om' });
  });
});

describe('normalizeProductInput', () => {
  const good = { name: 'Om Tee', price_rupees: 499, colours: [{ name: 'Black', hex: '#222222' }], sizes: ['S', 'M'] };
  it('accepts a minimal product', () => {
    const r = normalizeProductInput(good, { partial: false });
    expect(r.errors).toEqual([]);
    expect(r.value.name).toBe('Om Tee');
  });
  it('reports field errors', () => {
    const r = normalizeProductInput({ ...good, price_rupees: 0, colours: [{ name: 'X', hex: 'red' }], images: [{ url: 'http://x' }], mrp_rupees: 10 }, { partial: false });
    const fields = r.errors.map((e) => e.field);
    expect(fields).toContain('price_rupees');
    expect(fields).toContain('colours');
    expect(fields).toContain('images');
  });
  it('partial only checks present keys', () => {
    expect(normalizeProductInput({ status: 'live' }, { partial: true }).errors).toEqual([]);
    expect(normalizeProductInput({ status: 'bogus' }, { partial: true }).errors).toHaveLength(1);
  });
});
