import { describe, expect, it } from 'vitest';
import { formatLocalStart } from './SpiritualEventShelves';

describe('formatLocalStart', () => {
  it('returns null when there is no start time', () => {
    expect(formatLocalStart(null)).toBeNull();
    expect(formatLocalStart(0)).toBeNull();
  });

  it('produces a machine-readable ISO string and a visible zone label', () => {
    const ms = Date.UTC(2026, 9, 5, 14, 30);
    const result = formatLocalStart(ms);
    expect(result).not.toBeNull();
    expect(result?.iso).toBe(new Date(ms).toISOString());
    expect(result?.zone.length).toBeGreaterThan(0);
    expect(result?.label.length).toBeGreaterThan(0);
  });
});
