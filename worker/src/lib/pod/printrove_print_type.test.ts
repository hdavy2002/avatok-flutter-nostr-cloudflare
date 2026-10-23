import { describe, it, expect } from 'vitest';
import { allowedPrintTypes, PREFERRED_PRINT_TYPE } from './printrove';

describe('[HF-MERCH-PRINT-TYPE-1] allowedPrintTypes', () => {
  it('reads the allowed types from the live Printrove rejection', () => {
    const msg = 'Printrove rejected the request: "print_type" is required for product 460: it can be printed as DTF or DTG, and nothing selects one. Send "print_type" with one of: "DTF", "DTG".';
    expect(allowedPrintTypes(msg)).toEqual(['DTF', 'DTG']);
  });
  it('returns nothing for unrelated errors', () => {
    expect(allowedPrintTypes('Printrove rejected the request: name is required')).toEqual([]);
  });
  it('prefers DTG', () => { expect(PREFERRED_PRINT_TYPE).toBe('DTG'); });
});
