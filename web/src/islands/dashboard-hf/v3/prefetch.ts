/* [HF-DASH-COLD-1] Cold-boot prefetch. With no last-visit cache the dashboard used to run a strict chain:
 *   token -> /me -> photo gate -> (shell data + screen data).
 * None of those reads needs the uid (they are all token-authenticated), so DashboardApp starts them together with /me and the
 * screens adopt the promises when they mount. Nothing is requested twice.
 * Safety: the results are only handed out after /me has answered, and only for the uid /me answered (confirmPrefetch).
 * A 401, a different uid or an age over MAX_AGE_MS discards everything (takePrefetch then returns null and the caller
 * makes its normal request). Prefetched promises never reject (errors become a failed HfResult / null). */
import { hfCall, fetchWallet, type HfResult, type WalletInfo } from '../../../lib/hfCallsApi';
import { getDashSummary, type DashSummary } from '../../../lib/hfDashApi';
import { listFavourites } from '../../../lib/hfFavouritesApi';
import { getMyPhotos, type MyPhotos } from '../../../lib/hfPhotosApi';
import { publicConfig } from '../../../lib/hfConfig';
import { listBookings } from '../../../lib/hfBookingsApi';
import { getSafetyMe } from '../../../lib/hfSafetyApi';
import type { Insights, DashProfile } from './data';

export const getInsights = () => hfCall<Insights>('GET', '/api/hf/me/insights');
export const getProfile = () => hfCall<DashProfile>('GET', '/api/hf/me/profile');

export const PREFETCH_MAX_AGE_MS = 15_000;
const failed = <T,>(): HfResult<T> => ({ ok: false, status: 0, code: 'network', message: '', body: {} });
const safe = <T,>(p: () => Promise<HfResult<T>>): Promise<HfResult<T>> => { try { return p().catch(() => failed<T>()); } catch { return Promise.resolve(failed<T>()); } };

export interface PrefetchMap {
  insights: HfResult<Insights>; summary: HfResult<DashSummary>; wallet: HfResult<WalletInfo>; profile: HfResult<DashProfile>;
  favs: HfResult<{ ok: true; items: unknown[]; count: number }>;
  policy: HfResult<unknown>; safety: HfResult<Awaited<ReturnType<typeof getSafetyMe>> extends HfResult<infer D> ? D : never>;
  bookings: Awaited<ReturnType<typeof listBookings>> | null; photos: MyPhotos | null;
}
export type PrefetchName = keyof PrefetchMap;
interface Store { at: number; t0: number; uid: string | null; p: { [K in PrefetchName]?: Promise<PrefetchMap[K]> } }
let store: Store | null = null;

/** Start the cold-path reads now. `overview` also starts the Overview screen's own first reads. Replaces any earlier prefetch. */
export function startColdPrefetch(opts: { overview: boolean; photos: boolean }): void {
  const s: Store = { at: Date.now(), t0: typeof performance !== 'undefined' ? performance.now() : 0, uid: null, p: {} };
  s.p.insights = safe(getInsights);
  s.p.summary = safe(() => getDashSummary());
  s.p.wallet = safe(fetchWallet);
  s.p.profile = safe(getProfile);
  s.p.favs = safe(() => listFavourites()) as Promise<PrefetchMap['favs']>; // used only when the favourites flag ends up on
  s.p.policy = safe(() => hfCall('GET', '/api/hf/me/policy-update'));
  s.p.safety = safe(() => getSafetyMe()) as Promise<PrefetchMap['safety']>; // the shell (menu badge) reads it on every screen
  if (opts.overview) {
    const from = new Date(Date.now() - 60 * 60_000).toISOString(), to = new Date(Date.now() + 60 * 86_400_000).toISOString();
    s.p.bookings = listBookings('customer', from, to).catch(() => null); // adopted only when the bookings flag is on
  }
  // The photo gate only matters when hfPhotosRequiredEnabled is on; /api/config is one shared, token-less request that is long done before the token is ready.
  if (opts.photos) s.p.photos = publicConfig().then(c => (c.hfPhotosRequiredEnabled === true ? getMyPhotos() : null)).catch(() => null);
  store = s;
}

/** /me answered with this uid: from now on the prefetched results may be used for that uid only. */
export function confirmPrefetch(uid: string): void {
  if (!store) return;
  if (store.uid && store.uid !== uid) { store = null; return; }
  store.uid = uid;
}
/** /me answered 401 / another person / the session changed: forget everything. */
export function discardPrefetch(): void { store = null; }

function valid(uid: string): Store | null {
  if (!store || store.uid !== uid || Date.now() - store.at > PREFETCH_MAX_AGE_MS) return null;
  return store;
}
/** The prefetched promise for this uid, or null (no prefetch, other uid, too old, or already taken). `consume` removes it so it is used once. */
export function takePrefetch<N extends PrefetchName>(uid: string, name: N, consume = true): Promise<PrefetchMap[N]> | null {
  const s = valid(uid);
  const p = s?.p[name] as Promise<PrefetchMap[N]> | undefined;
  if (!s || !p) return null;
  if (consume) delete s.p[name];
  return p;
}
/** performance.now() when the prefetch started (for load-time telemetry), or null. */
export function prefetchT0(uid: string): number | null { return valid(uid)?.t0 ?? null; }
export function hasPrefetch(): boolean { return store !== null; }

/* No listener on site:active-session-changed on purpose: Clerk fires it when it finishes loading, i.e. exactly while the cold prefetch is in
 * flight. Identity is guarded by confirmPrefetch(uid) instead (every /me answer is checked against the uid the prefetch was confirmed for). */
