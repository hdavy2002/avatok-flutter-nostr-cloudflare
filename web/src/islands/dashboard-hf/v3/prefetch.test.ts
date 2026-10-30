// [HF-DASH-COLD-1] Cold-boot prefetch: results are handed out only for the uid /me confirmed, once, and never after 401 / another uid / expiry.
// @ts-ignore vitest is installed in worker/node_modules only (same as hfDashCache.test.ts)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ok = (data: unknown) => ({ ok: true as const, data });
const hfCall = vi.fn(async (_m: string, path: string) => ok({ path }));
vi.mock('../../../lib/hfCallsApi', () => ({ hfCall: (...a: unknown[]) => (hfCall as any)(...a), fetchWallet: () => (hfCall as any)('GET', '/api/hf/wallet') }));
vi.mock('../../../lib/hfDashApi', () => ({ getDashSummary: () => (hfCall as any)('GET', '/api/hf/me/summary') }));
vi.mock('../../../lib/hfFavouritesApi', () => ({ listFavourites: () => (hfCall as any)('GET', '/api/hf/favourites') }));
const getMyPhotos = vi.fn(async () => ({ complete: false, missing: ['cover'] }));
vi.mock('../../../lib/hfPhotosApi', () => ({ getMyPhotos: () => getMyPhotos() }));
let photosRequired = true;
vi.mock('../../../lib/hfConfig', () => ({ publicConfig: async () => ({ hfPhotosRequiredEnabled: photosRequired }) }));
vi.mock('../../../lib/hfBookingsApi', () => ({ listBookings: async () => ({ bookings: [] }) }));
vi.mock('../../../lib/hfSafetyApi', () => ({ getSafetyMe: () => (hfCall as any)('GET', '/api/hf/safety/me') }));

import { confirmPrefetch, discardPrefetch, hasPrefetch, startColdPrefetch, takePrefetch } from './prefetch';

beforeEach(() => { discardPrefetch(); hfCall.mockClear(); getMyPhotos.mockClear(); photosRequired = true; });
afterEach(() => { vi.useRealTimers(); });

describe('cold prefetch', () => {
  it('starts every uid-free read once, before /me answers', () => {
    startColdPrefetch({ overview: true, photos: true });
    const paths = hfCall.mock.calls.map((c: unknown[]) => c[1]).sort();
    expect(paths).toEqual(['/api/hf/favourites', '/api/hf/me/insights', '/api/hf/me/policy-update', '/api/hf/me/profile', '/api/hf/me/summary', '/api/hf/safety/me', '/api/hf/wallet']);
  });
  it('hands nothing out until /me confirmed the uid, then only for that uid', async () => {
    startColdPrefetch({ overview: true, photos: true });
    expect(takePrefetch('u1', 'summary')).toBeNull();
    confirmPrefetch('u1');
    expect(takePrefetch('u2', 'summary')).toBeNull();
    expect(await takePrefetch('u1', 'summary')).toEqual(ok({ path: '/api/hf/me/summary' }));
  });
  it('consumes a taken entry (used once) but not when consume is false', () => {
    startColdPrefetch({ overview: true, photos: true }); confirmPrefetch('u1');
    expect(takePrefetch('u1', 'policy')).not.toBeNull();
    expect(takePrefetch('u1', 'policy')).toBeNull();
    expect(takePrefetch('u1', 'wallet', false)).not.toBeNull();
    expect(takePrefetch('u1', 'wallet', false)).not.toBeNull();
  });
  it('discards everything on 401 / a different uid', () => {
    startColdPrefetch({ overview: true, photos: true }); confirmPrefetch('u1');
    confirmPrefetch('u2'); // /me answered another person
    expect(hasPrefetch()).toBe(false);
    expect(takePrefetch('u2', 'wallet')).toBeNull();
    startColdPrefetch({ overview: true, photos: true }); confirmPrefetch('u1'); discardPrefetch();
    expect(takePrefetch('u1', 'wallet')).toBeNull();
  });
  it('expires after the age limit', () => {
    vi.useFakeTimers();
    startColdPrefetch({ overview: true, photos: true }); confirmPrefetch('u1');
    vi.advanceTimersByTime(16_000);
    expect(takePrefetch('u1', 'wallet')).toBeNull();
  });
  it('only reads the photo gate when the photosRequired flag is on, and only the Overview screen prefetches bookings', async () => {
    startColdPrefetch({ overview: false, photos: true }); confirmPrefetch('u1');
    expect(takePrefetch('u1', 'bookings')).toBeNull();
    expect(await takePrefetch('u1', 'photos')).toEqual({ complete: false, missing: ['cover'] });
    photosRequired = false; getMyPhotos.mockClear();
    startColdPrefetch({ overview: false, photos: true }); confirmPrefetch('u1');
    expect(await takePrefetch('u1', 'photos')).toBeNull();
    expect(getMyPhotos).not.toHaveBeenCalled();
    startColdPrefetch({ overview: false, photos: false }); confirmPrefetch('u1');
    expect(takePrefetch('u1', 'photos')).toBeNull();
  });
  it('a failing read becomes a failed result, never a rejection', async () => {
    hfCall.mockImplementationOnce(async () => { throw new Error('boom'); });
    startColdPrefetch({ overview: false, photos: false }); confirmPrefetch('u1');
    const r = await takePrefetch('u1', 'insights');
    expect(r && (r as { ok: boolean }).ok).toBe(false);
  });
});
