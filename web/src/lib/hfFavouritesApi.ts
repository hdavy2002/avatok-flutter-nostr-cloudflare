/* [HF-DASH-FRAANDS-1] Saved hosts ("hearts"). Worker routes: /api/hf/favourites (see worker/src/routes/hf_favourites.ts). */
import { publicConfig } from './hfConfig'; // [HF-DASH-CACHE-1]
import { hfCall, type HfResult, type HostPresence } from './hfCallsApi';

export interface FavouriteHost {
  slug: string; displayName: string; photoUrl: string | null; headline: string | null; presence: HostPresence; savedAt: number;
}

/** hfFavouritesEnabled from /api/config (one request per page, shared). Fails closed: any error counts as off. */
export function favouritesEnabled(): Promise<boolean> {
  return publicConfig().then(c => c.hfFavouritesEnabled === true); // [HF-DASH-CACHE-1]
}

export const listFavourites = (): Promise<HfResult<{ ok: true; items: FavouriteHost[]; count: number }>> =>
  hfCall('GET', '/api/hf/favourites');
export const isFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: boolean }>> =>
  hfCall('GET', `/api/hf/favourites/${encodeURIComponent(slug)}`);
export const saveFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: true; count: number }>> =>
  hfCall('PUT', `/api/hf/favourites/${encodeURIComponent(slug)}`);
export const unsaveFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: false; count: number }>> =>
  hfCall('DELETE', `/api/hf/favourites/${encodeURIComponent(slug)}`);
