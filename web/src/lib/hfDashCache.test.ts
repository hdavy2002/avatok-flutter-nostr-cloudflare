// [HF-DASH-CACHE-1] cachedFetch (dedupe / ttl / only good answers) and the single shared /api/config request.
// @ts-ignore vitest is installed in worker/node_modules only (same as hfPayoutApi.test.ts)
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./clerk', () => ({ ACTIVE_SESSION_CHANGED: 'site:active-session-changed', activeSessionSignedOut: () => false, getActiveTokenWaited: async () => 'tok' }));
const requestMock = vi.fn();
vi.mock('./apiClient', () => ({ ApiError: class extends Error {}, request: (...a: unknown[]) => requestMock(...a) }));

import { cachedFetch, cachedPeek, clearCachedFetch, isCacheable } from './hfCallsApi';
import { publicConfig, resetPublicConfigForTests } from './hfConfig';

beforeEach(() => { clearCachedFetch(); requestMock.mockReset(); resetPublicConfigForTests(); });

describe('cachedFetch', () => {
  it('shares one request between callers in flight', async () => {
    const fn = vi.fn(async () => 'a');
    const [x, y] = await Promise.all([cachedFetch('k', fn), cachedFetch('k', fn)]);
    expect([x, y, fn.mock.calls.length]).toEqual(['a', 'a', 1]);
  });
  it('serves a fresh answer from memory and refetches after the ttl or when forced', async () => {
    const fn = vi.fn(async () => 'a');
    await cachedFetch('k', fn, 60_000); await cachedFetch('k', fn, 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await cachedFetch('k', fn, 60_000, true);
    expect(fn).toHaveBeenCalledTimes(2);
    await cachedFetch('k', fn, 0);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('keeps only good answers', async () => {
    await cachedFetch('bad', async () => ({ ok: false }));
    await cachedFetch('nil', async () => null);
    expect(cachedPeek('bad')).toBeUndefined();
    expect(cachedPeek('nil')).toBeUndefined();
    await cachedFetch('good', async () => ({ ok: true, n: 1 }));
    expect(cachedPeek('good')?.v).toEqual({ ok: true, n: 1 });
    expect(isCacheable({ ok: false })).toBe(false);
  });
  it('clearCachedFetch forgets everything and drops answers still in flight', async () => {
    let done: (v: string) => void = () => undefined;
    const slow = cachedFetch('s', () => new Promise<string>(r => { done = r; }));
    clearCachedFetch(); done('late'); await slow;
    expect(cachedPeek('s')).toBeUndefined();
  });
});

describe('publicConfig', () => {
  it('asks /api/config once however many callers', async () => {
    requestMock.mockResolvedValue({ hfBookingsEnabled: true });
    const all = await Promise.all([publicConfig(), publicConfig(), publicConfig(), publicConfig(), publicConfig()]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(all[4].hfBookingsEnabled).toBe(true);
  });
  it('a failure means every flag off', async () => {
    requestMock.mockRejectedValue(new Error('down'));
    expect(await publicConfig()).toEqual({});
  });
});
