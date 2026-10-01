import { describe, it, expect } from 'vitest';
import { PRINT_SPECS, maxSharpInches, fitForProduct } from './specs';
import { classifyKind, mapPartnerStatus, printroveLogin, PrintroveProvider } from './printrove';
import { estimatePrintCostRupees } from './specs';
import type { Env } from '../../types';
import { builtInCatalog } from './manual';

describe('maxSharpInches', () => {
  it('divides pixels by 300 DPI to one decimal', () => {
    expect(maxSharpInches(4680, 5880)).toEqual({ w: 15.6, h: 19.6 });
    expect(maxSharpInches(1000, 1000)).toEqual({ w: 3.3, h: 3.3 });
    expect(maxSharpInches(0, 0)).toEqual({ w: 0, h: 0 });
  });
});

describe('fitForProduct', () => {
  it('is great at >= 300 DPI across the full area width', () => {
    const r = fitForProduct(5000, 5000, 'mens_tee', 'front'); // 5000 / 15.6 = 320 DPI
    expect(r.verdict).toBe('great');
    expect(r.full_area_dpi).toBe(321);
    expect(r.sharp_w_in).toBe(16.7);
  });
  it('is good between 250 and 299 DPI', () => {
    expect(fitForProduct(4200, 4200, 'mens_tee', 'front').verdict).toBe('good'); // 269
  });
  it('is small_only when only a smaller print stays sharp', () => {
    const r = fitForProduct(2000, 2000, 'mens_tee', 'front'); // 128 DPI full width, 500 DPI at 4 in
    expect(r.verdict).toBe('small_only');
    expect(r.sharp_w_in).toBe(6.7);
  });
  it('is too_small under 150 DPI even at 4 in (under 600 px)', () => {
    expect(fitForProduct(599, 599, 'mens_tee', 'front').verdict).toBe('too_small');
    expect(fitForProduct(600, 600, 'mens_tee', 'front').verdict).toBe('small_only');
  });
  it('uses each kind and side area (polo chest is 4 in, back 14 in)', () => {
    expect(fitForProduct(1200, 1200, 'polo', 'front').verdict).toBe('great'); // 300 DPI on 4 in
    expect(fitForProduct(1200, 1200, 'polo', 'back').verdict).toBe('small_only'); // 86 DPI on 14 in
  });
  it('falls back to the men\'s tee area for an unknown kind', () => {
    expect(fitForProduct(5000, 5000, 'other', 'front').verdict).toBe('great');
  });
});

describe('PRINT_SPECS', () => {
  it('holds the partner limits', () => {
    expect(PRINT_SPECS.min_dpi).toBe(300);
    expect(PRINT_SPECS.max_px).toBe(5000);
    expect(PRINT_SPECS.max_upload_bytes).toBe(15 * 1024 * 1024);
    expect(Object.keys(PRINT_SPECS.areas)).toHaveLength(12);
  });
});

describe('manual built-in catalogue', () => {
  it('has one product per kind, 6 colours x 6 sizes, cost unknown', () => {
    const c = builtInCatalog();
    expect(c).toHaveLength(12);
    expect(c[0].variants).toHaveLength(36);
    expect(c.every((p) => p.variants.every((v) => v.base_cost_paise === null))).toBe(true);
    expect(new Set(c.flatMap((p) => p.variants.map((v) => v.provider_variant_id))).size).toBe(12 * 36);
  });
});

describe('classifyKind', () => {
  it('maps Printrove product ids to Studio kinds; everything else is other', () => {
    expect(classifyKind('460')).toBe('mens_tee');
    expect(classifyKind('462')).toBe('womens_tee');
    expect(classifyKind('561')).toBe('kids_tee');
    expect(classifyKind('560')).toBe('toddler_tee');
    expect(classifyKind('463')).toBe('hoodie');
    expect(classifyKind('1012')).toBe('sweatshirt');
    expect(classifyKind('1182')).toBe('polo');
    expect(classifyKind('464')).toBe('crop_top');
    expect(classifyKind('1087')).toBe('crop_hoodie');
    expect(classifyKind('1216')).toBe('oversized_tee');
    expect(classifyKind('1440')).toBe('oversized_tee');
    expect(classifyKind('461')).toBe('full_sleeve_tee');
    expect(classifyKind('1453')).toBe('vneck_tee');
    expect(classifyKind('1371')).toBe('other'); // oversized hoodie: not offered yet
    expect(classifyKind('856')).toBe('other'); // mugs
  });
});

describe('fitForProduct with the partner area', () => {
  it('uses the supplied area over PRINT_SPECS', () => {
    expect(fitForProduct(4800, 6000, 'oversized_tee', 'front', [16, 20]).full_area_dpi).toBe(300);
    expect(fitForProduct(4680, 5880, 'oversized_tee', 'front').full_area_dpi).toBe(300);
  });
});

describe('estimatePrintCostRupees', () => {
  const v = { print_cost: { front: { rate_per_sq_in_rupees: 0.9, min_price_rupees: 90 } } };
  it('is the minimum for small prints and rate x area for big ones', () => {
    expect(estimatePrintCostRupees(v, 'front', 4, 4)).toBe(90); // 14.4 < 90
    expect(estimatePrintCostRupees(v, 'front', 12, 14)).toBe(151.2); // 0.9 x 168
  });
  it('is null when there are no rates for that side', () => {
    expect(estimatePrintCostRupees(v, 'back', 4, 4)).toBeNull();
    expect(estimatePrintCostRupees({}, 'front', 4, 4)).toBeNull();
  });
});

describe('printroveLogin', () => {
  const env = (o: Record<string, string>) => o as unknown as Env;
  it('reads the single PRINTROVE_LOGIN JSON secret', () => {
    expect(printroveLogin(env({ PRINTROVE_LOGIN: '{"email":" a@b.test ","password":"p w"}' }))).toEqual({ email: 'a@b.test', password: 'p w' });
  });
  it('falls back to the two old secrets', () => {
    expect(printroveLogin(env({ PRINTROVE_EMAIL: 'a@b.test', PRINTROVE_PASSWORD: 'x' }))).toEqual({ email: 'a@b.test', password: 'x' });
  });
  it('is null when absent, malformed or incomplete (and never falls back past a bad PRINTROVE_LOGIN)', () => {
    expect(printroveLogin(env({}))).toBeNull();
    expect(printroveLogin(env({ PRINTROVE_LOGIN: 'not json' }))).toBeNull();
    expect(printroveLogin(env({ PRINTROVE_LOGIN: '{"email":"a@b.test"}' }))).toBeNull();
    expect(printroveLogin(env({ PRINTROVE_LOGIN: 'oops', PRINTROVE_EMAIL: 'a@b.test', PRINTROVE_PASSWORD: 'x' }))).toBeNull();
  });
});

describe('PrintroveProvider.mapProduct (real detail shape)', () => {
  const variant = (over: Record<string, unknown>) => ({
    id: 1001, name: 'Black / S', weight: 180, gst: 5, stock_status: 'in_stock',
    front_print_width: 4680, front_print_height: 5880, back_print_width: 4680, back_print_height: 5880,
    base_price: 165, front_rate_per_square_inch: 0.9, front_minimum_printing_price: 90, back_rate_per_square_inch: 0.9, back_minimum_printing_price: 90,
    color: 'Black', color_code: '#000000', size: 'S', ...over,
  });
  const body = { status: 'success', product: { id: 460, name: 'Half Sleeve Round Neck T-Shirt', gst: 5, variants: [
    variant({}), variant({ id: 1002, size: 'M' }), variant({ id: 1003, color: 'Maroon', color_code: '800000', stock_status: 'out_of_stock' }),
  ] } };
  const p = new PrintroveProvider({} as Env).mapProduct(body, 'mens_tee', '460', 'x', "Men's Clothing");

  it('maps variants, rupees to paise, hex and weight; skips out-of-stock', () => {
    expect(p?.variants).toHaveLength(2);
    expect(p?.variants[0]).toMatchObject({ provider_variant_id: '1001', colour: 'Black', colour_hex: '#000000', size: 'S', base_cost_paise: 16500, weight_g: 180 });
    expect(p?.variants[0].print_cost?.front).toEqual({ rate_per_sq_in_rupees: 0.9, min_price_rupees: 90 });
  });
  it('derives the print area in inches from px at 300 DPI', () => {
    expect(p?.print_area_in).toEqual({ front: [15.6, 19.6], back: [15.6, 19.6] });
    expect(p?.category).toBe("Men's Clothing");
  });
  it('returns null when nothing is in stock', () => {
    expect(new PrintroveProvider({} as Env).mapProduct({ product: { variants: [variant({ stock_status: 'out_of_stock' })] } }, 'mens_tee', '460', 'x', null)).toBeNull();
  });
});

describe('mapPartnerStatus', () => {
  it('maps known words and keeps unknown ones as sent', () => {
    expect(mapPartnerStatus('Delivered')).toBe('delivered');
    expect(mapPartnerStatus('Undelivered')).toBe('problem');
    expect(mapPartnerStatus('Shipped')).toBe('shipped');
    expect(mapPartnerStatus('In production')).toBe('printing');
    expect(mapPartnerStatus('Cancelled')).toBe('cancelled');
    expect(mapPartnerStatus('Order placed')).toBe('sent');
  });
});
