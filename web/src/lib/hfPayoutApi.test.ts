// [HF-CLOSE-UPI-1] UPI ID helpers for the website payout setup.
import { describe, it, expect } from 'vitest';
import { cleanUpi, maskUpi, UPI_RE } from './hfPayoutApi';

describe('payout setup helpers', () => {
  it('cleans and validates like the worker', () => {
    expect(cleanUpi(' Asha@OkHDFC ')).toBe('asha@okhdfc');
    expect(UPI_RE.test('asha@okhdfc')).toBe(true);
    expect(UPI_RE.test('nope')).toBe(false);
    expect(UPI_RE.test('a@b')).toBe(false);
  });
  it('masks the name part, never shows the full UPI', () => {
    expect(maskUpi('ashalatha@okhdfc')).toBe('as*******@okhdfc');
    expect(maskUpi('ab@ybl')).toBe('a**@ybl');
    expect(maskUpi('ashalatha@okhdfc')).not.toContain('ashalatha');
  });
});
