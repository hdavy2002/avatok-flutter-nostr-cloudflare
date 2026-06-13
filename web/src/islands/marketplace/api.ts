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
  from?: string;
  to?: string;
  minRating?: number;
  sort?: string;
  category?: string;
  kind?: string;
  limit?: number;
  cursor?: string;
}

/** A category as returned by GET /api/explore/categories (has an emoji). */
export interface MarketCategory {
  id: string;
  label: string;
  emoji?: string;
  count?: number;
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
