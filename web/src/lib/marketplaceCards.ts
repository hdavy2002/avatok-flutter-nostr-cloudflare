// [MKT-SSR-1 2026-09-30] The ONE loader for the /marketplace listing set, shared by
// the server render (pages/marketplace.astro) and the island's client fallback
// (islands/marketplace/MarketplaceV2.tsx), so both always see the same cards.
//
// /api/explore (≤ 3 pages × 30, pages follow the cursor so they are sequential)
// plus /api/explore/live-now, fetched alongside. A live-now failure is not fatal:
// the upcoming list still renders. An /api/explore failure throws.
import type { Card } from './types';
import { getExplore, getLiveNow } from './apiClient';

export const MARKETPLACE_PAGES = 3;
export const MARKETPLACE_PAGE_SIZE = 30;

export async function loadMarketplaceCards(
  signal?: AbortSignal,
  onLiveNowError?: (err: unknown) => void,
): Promise<Card[]> {
  const liveP = getLiveNow(signal).catch((err) => {
    if (!signal?.aborted) onLiveNowError?.(err);
    return { listings: [] as Card[] };
  });
  const cards: Card[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MARKETPLACE_PAGES; page++) {
    const res = await getExplore({ limit: MARKETPLACE_PAGE_SIZE, cursor }, signal);
    cards.push(...(res.listings ?? []));
    cursor = res.cursor ?? undefined;
    if (!cursor) break;
  }
  const live = await liveP;
  cards.push(...(live.listings ?? []));
  return cards;
}
