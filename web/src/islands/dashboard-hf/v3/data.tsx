/* [HF-DASH-V3-1] One shared load for the dashboard shell: insights, summary, wallet, saved influencers and profile.
 * Every part is independent: a part that fails is `null` + an error flag, and the screen shows its own "Try again".
 * Worker: GET /api/hf/me/insights, /api/hf/me/summary, /api/hf/wallet, /api/hf/favourites, /api/hf/me/profile (routes/hf_dash_v3.ts). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { fetchWallet, hfCall, type HfResult, type WalletInfo } from '../../../lib/hfCallsApi';
import { getDashSummary, partsFailed, type DashSummary } from '../../../lib/hfDashApi';
import { listFavourites, type FavouriteHost } from '../../../lib/hfFavouritesApi';
import { capture, captureException } from '../../../lib/analytics';
import type { PriceTier } from '../../../lib/hfStdPlan';
import { readShell, writeShell } from './dashCache'; // [HF-DASH-CACHE-1]

export interface Insights {
  ok: boolean;
  talkDaily: { day: string; seconds: number; paise: number; calls: number }[];
  month: { calls: number; seconds: number; paise: number; missed: number };
  lastMonth: { calls: number; seconds: number; paise: number };
  topFraands: { slug: string | null; name: string; seconds: number }[];
  talkedTo: number; streakDays: number;
  pendingReviews: { callId: string; hostName: string; hostSlug: string | null; at: number; seconds: number }[];
  blockedCount: number;
}
export interface DashProfile { ok: boolean; firstName: string | null; lastName: string | null; username: string | null; displayName: string | null; city: string | null; languages: string[]; talkAbout: string | null; joinedAt: number | null }
/** A saved influencer, with the price block the worker now adds ([HF-DASH-V3-1]) so HostCallActions can start a real call. */
export type Fav = FavouriteHost & { languages?: string[]; topics?: string[]; plan?: string; pricePerMin?: number; pricePaisePerMin?: number; priceLabel?: string; priceTiers?: PriceTier[]; womenOnly?: boolean; space?: 'women' | 'lgbtq' | null; videoKycVerified?: boolean; channelVerified?: boolean; channelPlatform?: string | null; followers?: number | null; callerLevel?: 'everyone' | 'video_kyc' };

export const getInsights = () => hfCall<Insights>('GET', '/api/hf/me/insights');
export const getProfile = () => hfCall<DashProfile>('GET', '/api/hf/me/profile');
export const putProfile = (body: Partial<{ firstName: string; lastName: string; city: string | null; languages: string[]; talkAbout: string | null }>) => hfCall<DashProfile>('PUT', '/api/hf/me/profile', body);
export interface Prefs { ok: boolean; notifyWhatsapp: boolean; apptReminders: boolean }
export const getPrefs = () => hfCall<Prefs>('GET', '/api/hf/me/prefs');
/** [HF-APPT-REMIND-1] Send only the switch that changed. */
export const putPrefs = (body: Partial<Pick<Prefs, 'notifyWhatsapp' | 'apptReminders'>>) => hfCall<Prefs>('PUT', '/api/hf/me/prefs', body);
export interface BlockItem { key: string; name: string; slug: string | null; at: number }
export const getBlocks = () => hfCall<{ ok: boolean; items: BlockItem[] }>('GET', '/api/hf/blocks');
export const unblock = (key: string) => hfCall<{ ok: boolean }>('DELETE', `/api/hf/blocks/${encodeURIComponent(key)}`);
export const blockFromCall = (callId: string, reason: string) => hfCall<{ ok: boolean }>('POST', `/api/hf/calls/${encodeURIComponent(callId)}/block`, { reason });
export const reviewCall = (callId: string, stars: number, text: string) => hfCall<{ ok: boolean }>('POST', `/api/hf/calls/${encodeURIComponent(callId)}/review`, { stars, ...(text.trim() ? { text: text.trim() } : {}) });
export interface Ticket { id: string; topic: string; status: string; createdAt: number }
export const getTickets = () => hfCall<{ ok: boolean; items: Ticket[] }>('GET', '/api/hf/support/tickets');
export const sendTicket = (topic: string, message: string) => hfCall<{ ok: boolean; id: string }>('POST', '/api/hf/support/tickets', { topic, message });

/** Rupees the person can spend right now, in paise (rupee wallet, token wallet or the older paid + test balance). */
export function spendablePaise(w: WalletInfo | null): number | null {
  if (!w) return null;
  if (w.mode === 'rupees' && w.wallet) return w.wallet.availablePaise;
  if (w.mode === 'tokens' && w.tokens) return Math.round(Number(w.tokens.balance) * 100);
  return Math.round((w.spendable ?? 0) * 100);
}

type Part<T> = { data: T | null; failed: boolean };
export interface DashData {
  insights: Part<Insights>; summary: Part<DashSummary>; wallet: Part<WalletInfo>; favs: Part<Fav[]>; profile: Part<DashProfile>;
  reload: (part?: 'insights' | 'summary' | 'wallet' | 'favs' | 'profile') => void;
}
const empty = { data: null, failed: false };
const Ctx = createContext<DashData>({ insights: empty, summary: empty, wallet: empty, favs: empty, profile: empty, reload: () => undefined });
export const useDash = () => useContext(Ctx);

/** [HF-DASH-CACHE-1] Shell data is kept across screen changes. A revisit only refreshes it in the background when it is older than this. */
export const SHELL_STALE_MS = 45_000;
type PartName = 'insights' | 'summary' | 'wallet' | 'favs' | 'profile';

export function DashDataProvider({ uid, favouritesOn, nav, children }: { uid: string; favouritesOn: boolean; nav: number; children: ReactNode }) {
  // [HF-DASH-CACHE-1] Start from the last visit's data (sessionStorage, this uid only) so the shell paints at once; the load below refreshes it.
  const [snap] = useState(() => readShell(uid));
  const seed = <T,>(v: unknown): Part<T> => (v != null ? { data: v as T, failed: false } : empty);
  const [insights, setInsights] = useState<Part<Insights>>(() => seed(snap?.insights));
  const [summary, setSummary] = useState<Part<DashSummary>>(() => seed(snap?.summary));
  const [wallet, setWallet] = useState<Part<WalletInfo>>(() => seed(snap?.wallet));
  const [favs, setFavs] = useState<Part<Fav[]>>(() => (favouritesOn ? seed(snap?.favs) : empty));
  const [profile, setProfile] = useState<Part<DashProfile>>(() => seed(snap?.profile));
  const gen = useRef(0);
  const loadedAt = useRef(0);

  const load = useCallback(<T,>(name: string, fn: () => Promise<HfResult<T>>, set: Dispatch<SetStateAction<Part<T>>>) => {
    const run = gen.current;
    // [HF-DASH-CACHE-1] A failed background refresh keeps the data already on screen; only an empty part shows its "Try again".
    const fail = () => set(p => (p.data ? p : { data: null, failed: true }));
    fn().then(r => {
      if (run !== gen.current) return;
      if (r.ok) set({ data: r.data, failed: false });
      else { fail(); if (r.status !== 401 && r.status !== 0) captureException(new Error(`hf_dash3_${name}_${r.status}_${r.code}`), { area: 'hf_dash_v3', part: name, status: r.status }); }
    }).catch(e => { if (run === gen.current) { fail(); captureException(e, { area: 'hf_dash_v3', part: name }); } });
  }, []);

  const reload = useCallback((part?: PartName) => {
    if (!part) loadedAt.current = Date.now();
    if (!part || part === 'insights') load('insights', getInsights, setInsights);
    if (!part || part === 'summary') {
      const t0 = performance.now();
      load('summary', async () => { const r = await getDashSummary(); if (r.ok) capture('hf_dash_summary_load', { ms: Math.round(performance.now() - t0), parts_failed: partsFailed(r.data), role: r.data.role, surface: 'dash_v3' }); return r; }, setSummary);
    }
    if (!part || part === 'wallet') load('wallet', fetchWallet, setWallet);
    if (!part || part === 'profile') load('profile', getProfile, setProfile);
    if (!part || part === 'favs') {
      if (favouritesOn) load('favs', async () => { const r = await listFavourites(); return r.ok ? { ok: true as const, data: r.data.items as Fav[] } : r; }, setFavs);
      else setFavs({ data: [], failed: false });
    }
  }, [load, favouritesOn]);

  useEffect(() => { gen.current++; reload(); }, [uid, reload]);
  // [HF-DASH-CACHE-1] Moving between screens (or Back, or returning to the tab) no longer reloads the shell: only when the data is older than SHELL_STALE_MS.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (Date.now() - loadedAt.current > SHELL_STALE_MS) reload(); }, [nav, reload]);
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > SHELL_STALE_MS) reload(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [reload]);
  // Refresh presence and balance every minute while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') { reload('favs'); reload('wallet'); } }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  // [HF-DASH-CACHE-1] Keep the last good shell data for the next visit (debounced; skipped while everything is still empty).
  useEffect(() => {
    if (!insights.data && !summary.data && !wallet.data && !profile.data && !favs.data) return;
    const t = setTimeout(() => writeShell(uid, { insights: insights.data, summary: summary.data, wallet: wallet.data, profile: profile.data, favs: favs.data }), 500);
    return () => clearTimeout(t);
  }, [uid, insights, summary, wallet, profile, favs]);

  return <Ctx.Provider value={{ insights, summary, wallet, favs, profile, reload }}>{children}</Ctx.Provider>;
}
