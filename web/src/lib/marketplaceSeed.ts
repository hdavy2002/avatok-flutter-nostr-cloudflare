import { request } from './apiClient';
import type { CardPage } from './types';
export interface MarketplaceSeed { page?: CardPage; error?: string }
/** Mirrors the initial client query: group is a presentation filter, not an API param. */
export async function getMarketplaceSeed(q?: string): Promise<MarketplaceSeed> {
  const query = q?.trim() ?? '';
  try {
    const page = await request<CardPage>(query ? '/api/explore/search' : '/api/explore', {
      query: { limit: 24, ...(query ? { q: query } : {}) }, timeoutMs: 1800,
    });
    return { page };
  } catch {
    return { error: 'Could not load listings. Please try again.' };
  }
}
