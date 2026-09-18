import { request } from './apiClient';
import type { CardPage } from './types';
export interface MarketplaceSeed { page?: CardPage; error?: string }
/**
 * Mirrors the initial client query: group is a presentation filter, not an API param.
 *
 * [WEB-GATEWAY-E 2026-09-18] `examples: 1` asks the worker to mix the 8 badged,
 * non-bookable EXAMPLE listings in alongside real ones — this is the SSR seed
 * for the web marketplace page and the homepage's featured-sessions rail, the
 * two surfaces the owner wants examples visible on. The worker still refuses
 * unless its own `exampleListingsEnabled` switch is also on (routes/listings.ts
 * exampleFilter), so this param alone can never surface them if the owner has
 * turned examples off at launch. The Flutter app never sends this param, so it
 * never sees them regardless of this switch.
 */
export async function getMarketplaceSeed(q?: string, opts?: { timeoutMs?: number }): Promise<MarketplaceSeed> {
  const query = q?.trim() ?? '';
  try {
    const page = await request<CardPage>(query ? '/api/explore/search' : '/api/explore', {
      query: { limit: 24, examples: 1, ...(query ? { q: query } : {}) }, timeoutMs: opts?.timeoutMs ?? 1800,
    });
    return { page };
  } catch {
    return { error: 'Could not load listings. Please try again.' };
  }
}
