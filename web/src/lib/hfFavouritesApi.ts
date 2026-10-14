/* [HF-DASH-FRAANDS-1] Saved hosts ("hearts"). Worker routes: /api/hf/favourites (see worker/src/routes/hf_favourites.ts). */
import { request } from './apiClient';
import { hfCall, type HfResult, type HostPresence } from './hfCallsApi';

export interface FavouriteHost {
  slug: string; displayName: string; photoUrl: string | null; headline: string | null; presence: HostPresence; savedAt: number;
}

let favouritesConfig: Promise<boolean> | null = null;
/** hfFavouritesEnabled from /api/config (one request per page). Fails closed: any error counts as off. */
export function favouritesEnabled(): Promise<boolean> {
  if (!favouritesConfig) favouritesConfig = request<{ hfFavouritesEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
    .then(c => c?.hfFavouritesEnabled === true).catch(() => false);
  return favouritesConfig;
}

export const listFavourites = (): Promise<HfResult<{ ok: true; items: FavouriteHost[]; count: number }>> =>
  hfCall('GET', '/api/hf/favourites');
export const isFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: boolean }>> =>
  hfCall('GET', `/api/hf/favourites/${encodeURIComponent(slug)}`);
export const saveFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: true; count: number }>> =>
  hfCall('PUT', `/api/hf/favourites/${encodeURIComponent(slug)}`);
export const unsaveFavourite = (slug: string): Promise<HfResult<{ ok: true; saved: false; count: number }>> =>
  hfCall('DELETE', `/api/hf/favourites/${encodeURIComponent(slug)}`);
