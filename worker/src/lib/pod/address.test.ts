import { describe, it, expect } from 'vitest';
import { splitAddressForPartner, deliveryPhone10 } from './address';

const ok = (r: ReturnType<typeof splitAddressForPartner>) => {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('unreachable');
  return r;
};

describe('splitAddressForPartner', () => {
  it('splits a short two-line address into two valid lines without losing a word', () => {
    const r = ok(splitAddressForPartner({ line1: '12 Rajpur Road', line2: 'Near Clock Tower' }));
    expect(r.address1.length).toBeGreaterThanOrEqual(3);
    expect(r.address2.length).toBeGreaterThanOrEqual(3);
    expect(`${r.address1} ${r.address2}`.split(' ')).toEqual('12 Rajpur Road, Near Clock Tower'.split(' '));
  });

  it('keeps every line 3-50 chars and never cuts a word', () => {
    const line1 = 'Flat 402, Shree Ganesh Residency, Building B, Opposite Shivaji Park Main Gate';
    const r = ok(splitAddressForPartner({ line1, line2: 'Dadar West', landmark: 'Next to the old temple' }));
    const lines = [r.address1, r.address2, r.address3].filter(Boolean) as string[];
    for (const l of lines) { expect(l.length).toBeGreaterThanOrEqual(3); expect(l.length).toBeLessThanOrEqual(50); }
    const original = [line1, 'Dadar West', 'Next to the old temple'].join(', ').split(' ');
    expect(lines.join(' ').split(' ')).toEqual(original);
  });

  it('splits a one-line address that fits in one row into two valid lines', () => {
    const r = ok(splitAddressForPartner({ line1: 'Hill View Apartments' }));
    expect(r.address1.length).toBeGreaterThanOrEqual(3);
    expect(r.address2.length).toBeGreaterThanOrEqual(3);
    expect(`${r.address1} ${r.address2}`).toBe('Hill View Apartments');
  });

  it('uses a filler address2 when a single word cannot be split', () => {
    const r = ok(splitAddressForPartner({ line1: 'Sadan' }));
    expect(r.address1).toBe('Sadan');
    expect(r.address2).toBe('N/A');
  });

  it('breaks a single word longer than 50 chars', () => {
    const r = ok(splitAddressForPartner({ line1: 'A'.repeat(60) }));
    expect(r.address1).toHaveLength(50);
    expect(r.address2).toHaveLength(10);
  });

  it('fixes a trailing line shorter than 3 chars by moving a word down', () => {
    const a = 'a'.repeat(24), b = 'b'.repeat(23);
    const r = ok(splitAddressForPartner({ line1: `${a} ${b} yy` })); // naive wrap leaves a 2-char tail
    expect(r.address1).toBe(a);
    expect(r.address2).toBe(`${b} yy`);
  });

  it('fails rather than cut a word when a 2-char tail follows one unbreakable word', () => {
    expect(splitAddressForPartner({ line1: `${'x'.repeat(48)} yy` }).ok).toBe(false);
  });

  it('fails (never truncates) over 150 chars', () => {
    const r = splitAddressForPartner({ line1: 'word '.repeat(40) });
    expect(r.ok).toBe(false);
  });

  it('fails when empty or under 3 chars', () => {
    expect(splitAddressForPartner({ line1: '  ', line2: '' }).ok).toBe(false);
    expect(splitAddressForPartner({ line1: 'ab' }).ok).toBe(false);
  });

  it('collapses messy whitespace', () => {
    const r = ok(splitAddressForPartner({ line1: '  12   MG   Road ', line2: ' Sector  4 ' }));
    expect(`${r.address1} ${r.address2}`).not.toMatch(/\s{2,}/);
  });
});

describe('deliveryPhone10', () => {
  it('uses the address phone when it is a valid Indian mobile, stripping prefixes', () => {
    expect(deliveryPhone10('9876543210', null)).toBe('9876543210');
    expect(deliveryPhone10('+91 98765-43210', null)).toBe('9876543210');
    expect(deliveryPhone10('919876543210', null)).toBe('9876543210');
    expect(deliveryPhone10('09876543210', null)).toBe('9876543210');
  });
  it('falls back to the verified +91 WhatsApp number', () => {
    expect(deliveryPhone10('', '+919123456789')).toBe('9123456789');
    expect(deliveryPhone10(null, '+919123456789')).toBe('9123456789');
    expect(deliveryPhone10('12345', '+919123456789')).toBe('9123456789');
  });
  it('returns null when only a non-Indian or invalid number exists', () => {
    expect(deliveryPhone10('', '+14155550123')).toBeNull();
    expect(deliveryPhone10('', null)).toBeNull();
    expect(deliveryPhone10('1234567890', null)).toBeNull(); // does not start 6-9
    expect(deliveryPhone10(undefined, undefined)).toBeNull();
  });
  it('prefers the address phone over WhatsApp', () => {
    expect(deliveryPhone10('9000000001', '+919000000002')).toBe('9000000001');
  });
});
