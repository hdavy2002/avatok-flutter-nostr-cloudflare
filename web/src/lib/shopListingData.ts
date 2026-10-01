// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Server-side loader for /shop/all and /shop/c/<slug>: reads the filters from the
// URL and fetches the first result set, bounded by withDeadline like the other SSR pages. If the API is slow or down
// the page still renders its structure (empty facets) and the island's own client fetch takes over on the next change.
import { listProducts, type ShopFacets, type ShopListResult } from './shopApi';
import { filterParams, parseFilters, type FilterState } from './shopFilters';
import { withDeadline } from './requestDeadline';

export const EMPTY_FACETS: ShopFacets = { collections: [], colours: [], sizes: [], fits: [], prints: [], audiences: [], price: { min: 0, max: 0 } };
const SSR_DEADLINE_MS = 1800;

export async function loadListing(url: URL, baseCollection?: string): Promise<{ filters: FilterState; result: ShopListResult | null }> {
  const filters = parseFilters(url.searchParams, baseCollection);
  try {
    const result = await withDeadline((signal) => listProducts(filterParams(filters), signal), SSR_DEADLINE_MS);
    return { filters, result };
  } catch (err) {
    console.warn('[SHOP-SSR] listing fetch failed; rendering the empty structure', err instanceof Error ? err.message : String(err));
    return { filters, result: null };
  }
}
