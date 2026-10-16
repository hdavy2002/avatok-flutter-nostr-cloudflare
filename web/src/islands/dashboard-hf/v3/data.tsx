/* [HF-DASH-V3-1] One shared load for the dashboard shell: insights, summary, wallet, saved influencers and profile.
 * Every part is independent: a part that fails is `null` + an error flag, and the screen shows its own "Try again".
 * Worker: GET /api/hf/me/insights, /api/hf/me/summary, /api/hf/wallet, /api/hf/favourites, /api/hf/me/profile (routes/hf_dash_v3.ts). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchWallet, hfCall, type HfResult, type WalletInfo } from '../../../lib/hfCallsApi';
import { getDashSummary, partsFailed, type DashSummary } from '../../../lib/hfDashApi';
import { listFavourites, type FavouriteHost } from '../../../lib/hfFavouritesApi';
import { capture, captureException } from '../../../lib/analytics';
import type { PriceTier } from '../../../lib/hfStdPlan';

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
export type Fav = FavouriteHost & { languages?: string[]; topics?: string[]; plan?: string; pricePerMin?: number; pricePaisePerMin?: number; priceLabel?: string; priceTiers?: PriceTier[]; womenOnly?: boolean };

export const getInsights = () => hfCall<Insights>('GET', '/api/hf/me/insights');
export const getProfile = () => hfCall<DashProfile>('GET', '/api/hf/me/profile');
export const putProfile = (body: Partial<{ firstName: string; lastName: string; city: string | null; languages: string[]; talkAbout: string | null }>) => hfCall<DashProfile>('PUT', '/api/hf/me/profile', body);
export const getPrefs = () => hfCall<{ ok: boolean; notifyWhatsapp: boolean }>('GET', '/api/hf/me/prefs');
export const putPrefs = (notifyWhatsapp: boolean) => hfCall<{ ok: boolean; notifyWhatsapp: boolean }>('PUT', '/api/hf/me/prefs', { notifyWhatsapp });
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

export function DashDataProvider({ uid, favouritesOn, nav, children }: { uid: string; favouritesOn: boolean; nav: number; children: ReactNode }) {
  const [insights, setInsights] = useState<Part<Insights>>(empty);
  const [summary, setSummary] = useState<Part<DashSummary>>(empty);
  const [wallet, setWallet] = useState<Part<WalletInfo>>(empty);
  const [favs, setFavs] = useState<Part<Fav[]>>(empty);
  const [profile, setProfile] = useState<Part<DashProfile>>(empty);
  const gen = useRef(0);

  const load = useCallback(<T,>(name: string, fn: () => Promise<HfResult<T>>, set: (p: Part<T>) => void) => {
    const run = gen.current;
    fn().then(r => {
      if (run !== gen.current) return;
      if (r.ok) set({ data: r.data, failed: false });
      else { set({ data: null, failed: true }); if (r.status !== 401 && r.status !== 0) captureException(new Error(`hf_dash3_${name}_${r.status}_${r.code}`), { area: 'hf_dash_v3', part: name, status: r.status }); }
    }).catch(e => { if (run === gen.current) { set({ data: null, failed: true }); captureException(e, { area: 'hf_dash_v3', part: name }); } });
  }, []);

  const reload = useCallback((part?: 'insights' | 'summary' | 'wallet' | 'favs' | 'profile') => {
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

  useEffect(() => { gen.current++; reload(); }, [uid, nav, reload]);
  // Refresh presence and balance every minute while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') { reload('favs'); reload('wallet'); } }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  return <Ctx.Provider value={{ insights, summary, wallet, favs, profile, reload }}>{children}</Ctx.Provider>;
}
