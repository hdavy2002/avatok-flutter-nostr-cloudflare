// Dashboard 2 event screens — shared types, formatters, fetch + state UI.
// [DASH2-EVENTS 2026-09-25]. Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md.
//
// Screen islands never mount a ClerkProvider (DashNav owns it); they read the
// session JWT through getActiveTokenWaited(), and on a 401 force ONE fresh mint
// (a cached Clerk JWT from a backgrounded tab is often already expired).
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { getActiveTokenWaited } from '../../lib/clerk';
import { request, ApiError, type RequestOptions } from '../../lib/apiClient';
import { cfImage } from '../../lib/config';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import './dash2.css';

// ─────────────────────────── wire types ───────────────────────────
export interface Listing {
  id: string;
  title: string;
  description?: string | null;
  category: string;
  category_label?: string | null;
  deity?: string;
  image_url?: string | null;
  starts_at: number | null;
  duration_min?: number | null;
  price_paise: number;
  seats_left?: number;
  status: string;
  book_url: string;
}
export interface CatalogResponse {
  categories: { id: string; label: string; count: number }[];
  groups: { category: { id: string; label: string }; items: Listing[] }[];
}
export type EventState = 'pending_payment' | 'upcoming' | 'live' | 'ended';
export interface EventItem {
  order_id: string | null;
  payment_id?: string | null;
  listing: Listing;
  state: EventState;
  schedule_state?: string;
  starts_at: number | null;
  ends_at: number | null;
  join_url?: string;
  sankalp?: { name?: string; gotra?: string; wish?: string; family?: string[] };
  replay: { available: boolean; until?: number };
  youtube_video_id?: string;
}
export interface EventsResponse { now: number; items: EventItem[] }

// ─────────────────────────── fetch ───────────────────────────
export class NoSessionError extends Error {
  constructor() { super('no_session'); this.name = 'NoSessionError'; }
}

/** Authed GET/PUT against the worker with a single forced-refresh retry on 401. */
export async function authedRequest<T>(path: string, opts: Omit<RequestOptions, 'auth'> = {}): Promise<T> {
  const first = await getActiveTokenWaited();
  if (!first) throw new NoSessionError();
  try {
    return await request<T>(path, { ...opts, auth: first });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const fresh = await getActiveTokenWaited(5000, { skipCache: true });
    if (!fresh || fresh === first) throw e;
    return request<T>(path, { ...opts, auth: fresh });
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof NoSessionError) return 'Your session ended. Reload the page to sign in again.';
  if (e instanceof ApiError) {
    const b = e.body as { message?: unknown } | undefined;
    if (b && typeof b.message === 'string' && b.message) return b.message;
    if (e.status >= 500) return 'Our server had a problem. Please try again.';
    return 'Something went wrong. Please try again.';
  }
  return 'Could not reach Saathum. Check your connection and try again.';
}

// ─────────────────────────── formatting (IST) ───────────────────────────
const IST = 'Asia/Kolkata';
export const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
const fullDayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' });

/** "Sat, 4 Oct · 6:30 PM IST" */
export function fmtIstDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Time to be announced';
  const d = new Date(ms);
  const parts = dayFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')}, ${get('day')} ${get('month')} · ${timeFmt.format(d)} IST`;
}
/** "4 Oct 2026" */
export function fmtIstDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return fullDayFmt.format(new Date(ms));
}
export function fmtDuration(min: number | null | undefined): string {
  if (!min || min <= 0) return '';
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
/** Integer paise → "₹1,500" (2 decimals only when not whole rupees). "Free" for 0. */
export function fmtRupees(paise: number | null | undefined): string {
  if (!paise) return 'Free';
  const r = paise / 100;
  return `₹${Number.isInteger(r) ? inr.format(r) : r.toFixed(2)}`;
}

/** IST calendar-day start (epoch ms) for the day containing `ms`. */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}
/** "YYYY-MM-DD" (IST) for an epoch ms. */
export function istYmd(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
/** "YYYY-MM-DD" read as an IST date → its start-of-day epoch ms. */
export function ymdToIstStart(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_OFFSET_MS;
}

export function listingImage(url: string | null | undefined, width = 640): string | null {
  if (!url) return null;
  return cfImage(url, { width, fit: 'cover' });
}
export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

// ─────────────────────────── hooks ───────────────────────────
/** True below the phone breakpoint (<640px), tracked live. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639.98px)');
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// ─────────────────────────── state UI ───────────────────────────
export function Shimmer({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('d2-shimmer rounded-md', className)} />;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="dash-surface flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <p className="font-dash text-lg font-bold text-grand-teal">We couldn’t load this</p>
      <p className="max-w-md text-[15px] font-semibold text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}><RotateCw /> Try again</Button>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="dash-surface relative flex flex-col items-center gap-3 overflow-hidden px-6 py-12 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-secondary/60 to-transparent" />
      <span className="relative flex h-14 w-14 items-center justify-center rounded-full border border-border/60 bg-card text-grand-teal shadow-[var(--dash-shadow)]">
        {icon}
      </span>
      <p className="relative font-dash text-lg font-bold text-grand-teal">{title}</p>
      {body && <p className="relative max-w-md text-[15px] font-semibold text-muted-foreground">{body}</p>}
      {action && <div className="relative mt-1">{action}</div>}
    </div>
  );
}
