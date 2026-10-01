import { describe, it, expect } from 'vitest';
import { PRINT_SPECS, maxSharpInches, fitForProduct } from './specs';
import { classifyKind, mapPartnerStatus } from './printrove';
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
    expect(Object.keys(PRINT_SPECS.areas)).toHaveLength(9);
  });
});

describe('manual built-in catalogue', () => {
  it('has one product per kind, 6 colours x 6 sizes, cost unknown', () => {
    const c = builtInCatalog();
    expect(c).toHaveLength(9);
    expect(c[0].variants).toHaveLength(36);
    expect(c.every((p) => p.variants.every((v) => v.base_cost_paise === null))).toBe(true);
    expect(new Set(c.flatMap((p) => p.variants.map((v) => v.provider_variant_id))).size).toBe(9 * 36);
  });
});

describe('classifyKind', () => {
  it('maps product names to Studio kinds', () => {
    expect(classifyKind('Unisex Round Neck T-Shirt', null)).toBe('mens_tee');
    expect(classifyKind("Women's Oversized Tee", 'Women')).toBe('womens_tee');
    expect(classifyKind('Kids Round Neck T-shirt', null)).toBe('kids_tee');
    expect(classifyKind('Toddler Tee', null)).toBe('toddler_tee');
    expect(classifyKind('Pullover Hoodie', null)).toBe('hoodie');
    expect(classifyKind('Crop Hoodie', null)).toBe('crop_hoodie');
    expect(classifyKind('Crop Top', null)).toBe('crop_top');
    expect(classifyKind('Sweatshirt', null)).toBe('sweatshirt');
    expect(classifyKind('Polo T-Shirt', null)).toBe('polo');
    expect(classifyKind('Coffee Mug', 'Drinkware')).toBe('other');
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
