/* [HF-DASH-CACHE-1] useCached: stale-while-revalidate for a screen's own GET. Paints the last good answer at once (even an old one), then
 * refreshes quietly when it is older than ttl. A failed refresh never replaces a good answer. Backed by cachedFetch (lib/hfCallsApi.ts):
 * memory only, deduped, cleared on any write and on a session change. `version` > 0 forces a refresh (e.g. after a top-up). */
import { useCallback, useEffect, useState } from 'react';
import { cachedFetch, cachedPeek, isCacheable } from '../../../lib/hfCallsApi';

export function useCached<T>(key: string, fn: () => Promise<T>, ttlMs = 30_000, version = 0): { data: T | undefined; reload: () => void } {
  const [data, setData] = useState<T | undefined>(() => cachedPeek<T>(key)?.v);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const hit = cachedPeek<T>(key);
    if (hit) setData(hit.v);
    cachedFetch(key, fn, ttlMs, version > 0 || tick > 0)
      .then(v => { if (live && isCacheable(v)) setData(v); else if (live && !hit) setData(v); })
      .catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, tick]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { data, reload };
}
