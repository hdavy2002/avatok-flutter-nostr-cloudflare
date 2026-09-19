// Phase-A LOCAL marketplace fetch helpers. These wrap the shared `request`
// from the read-only apiClient for the two §4 reads that don't yet have a named
// helper there (search + categories). We do NOT edit apiClient — we only call
// existing https://api.avatok.ai endpoints (MASTER-PROMPT §4).

import { request } from '../../lib/apiClient';
import type { Card, CardPage } from '../../lib/types';

export interface SearchParams {
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  /**
   * [MARKET-SECTION-1] Epoch MILLISECONDS, matching `listings.starts_at` and the
   * worker's `Number(u.get("from"))`. These were typed `string` and no caller
   * ever passed one; a yyyy-mm-dd here would have parsed to NaN and been
   * silently dropped by the worker's `> 0` guard.
   */
  from?: number;
  to?: number;
  minRating?: number;
  sort?: string;
  category?: string;
  kind?: string;
  /** The bazaar section. See ExploreParams.section. */
  section?: string;
  limit?: number;
  cursor?: string;
}

/** A category as returned by GET /api/explore/categories (has an emoji). */
export interface MarketCategory {
  id: string;
  label: string;
  emoji?: string;
  count?: number;
  /** [MKT-3GROUP-1] Which of the three marketplace groups this category rolls
   *  up into — null for a marketplace-goods category (cars, property,
   *  mobiles, …), which is a different product and untouched by that change. */
  group_id?: string | null;
}

/** GET /api/explore/search — public faceted search (no auth). */
export function searchListings(params: SearchParams = {}, signal?: AbortSignal): Promise<CardPage> {
  return request<CardPage>('/api/explore/search', { query: { ...params }, signal });
}

/** GET /api/explore/categories — public category list (cached 300s upstream). */
export async function getCategories(signal?: AbortSignal): Promise<MarketCategory[]> {
  const res = await request<{ categories: MarketCategory[] }>('/api/explore/categories', { signal });
  return res.categories ?? [];
}

export type { Card, CardPage };
