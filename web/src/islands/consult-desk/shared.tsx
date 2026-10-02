/* [AUMFE-CONSULT-F3-1 2026-10-02] Consultant desk — shared bits: sign-in + consultant guard, the desk shell (topbar, bottom nav on
 * phones, sidebar on desktop), formatting helpers. Look = Specs/consultants-mockup/DeskToday + FileAstroDesktop.
 * Access: signed-in + a consultant (GET /desk/me; 403 -> "This page is for consultants"). Brand name only through BRAND. */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { signInUrlForHere } from '../../lib/authRedirect';
import { captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { errMessage, errStatus, getDeskEarnings, getDeskMe, SignedOutError } from '../../lib/consultDeskApi';
import type { DeskEarnings, DeskMe } from '../../lib/consultDeskApi';
import './desk.css';

/* ── formatting ── */

const IST = 'Asia/Kolkata';
export const inr = (n: number): string => Math.round(n).toLocaleString('en-IN');
export function timeIst(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST }).toUpperCase();
}
export function slotRange(a: number, b: number): string {
  const ta = timeIst(a); const tb = timeIst(b);
  const ap = ta.slice(-2); const bp = tb.slice(-2);
  return ap === bp ? `${ta.slice(0, -3)}–${tb}` : `${ta}–${tb}`;
}
export function dayIst(ms: number, withWeekday = true): string {
  return new Date(ms).toLocaleDateString('en-IN', { weekday: withWeekday ? 'short' : undefined, day: 'numeric', month: 'short', timeZone: IST });
}
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function inMinutes(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h >= 24 ? `${Math.floor(h / 24)} d` : `${h} h ${m % 60} min`;
}
export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '·';
}
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}
export const DISC_CHIP: Record<string, string> = { astrology: 'neel', numerology: 'gold', palmistry: 'red', face_reading: 'red', tarot: 'neel' };
export const DISC_CAT: Record<string, string> = { astrology: 'cat-astro', numerology: 'cat-numero', palmistry: 'cat-palm', face_reading: 'cat-face', tarot: 'cat-tarot' };

/* ── icons (paths from the mockup nav) ── */

export function Icon({ d, size = 22 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
export const MIC_SVG = <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" /></svg>;
export const MIC_OFF_SVG = <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 2l20 20M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8M5 10v1a7 7 0 0 0 11.5 5.4M19 10v1c0 .9-.2 1.7-.5 2.5M12 18v4" /></svg>;
export const HANGUP_SVG = <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 15c5-5 13-5 18 0l-2 3-4-2v-3a10 10 0 0 0-6 0v3l-4 2z" /></svg>;
export const SPEAKER_SVG = <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>;

interface NavItem { key: string; label: string; href: string; d: string }
const NAV: NavItem[] = [
  { key: 'today', label: 'Today', href: '/desk', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2' },
  { key: 'bookings', label: 'Bookings', href: '/desk?scope=upcoming', d: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4' },
  { key: 'customers', label: 'Customers', href: '/desk/customers', d: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M22 21c0-3-2-5-5-5.5' },
  { key: 'rate', label: 'Rate', href: '/desk/rate', d: 'M6 4h12M6 9h12M6 4c5 0 7 2 7 5s-2 5-7 5l8 7' },
  { key: 'availability', label: 'More', href: '/desk/availability', d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z' },
];
const SIDE: { key: string; label: string; href: string }[] = [
  { key: 'today', label: 'Today', href: '/desk' },
  { key: 'bookings', label: 'Bookings', href: '/desk?scope=upcoming' },
  { key: 'customers', label: 'Customers', href: '/desk/customers' },
  { key: 'availability', label: 'Availability', href: '/desk/availability' },
  { key: 'rate', label: 'Rate and earnings', href: '/desk/rate' },
  { key: 'wallet', label: 'Wallet', href: '/dashboard/wallet' },
  { key: 'profile', label: 'Profile', href: '/dashboard/profile' },
];

/* ── desk context + guard ── */

interface DeskCtxValue { me: DeskMe; earnings: DeskEarnings | null; firstName: string }
const DeskCtx = createContext<DeskCtxValue | null>(null);
export function useDesk(): DeskCtxValue {
  const v = useContext(DeskCtx);
  if (!v) throw new Error('useDesk outside DeskRoot');
  return v;
}

type Phase = { k: 'loading' } | { k: 'forbidden' } | { k: 'error'; message: string } | { k: 'ready'; v: DeskCtxValue };

function useSignedIn(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { location.replace(signInUrlForHere()); return; }
    setOk(true);
  }, [isLoaded, isSignedIn]);
  return ok;
}
const useGuard: () => boolean = CLERK_PUBLISHABLE_KEY ? useSignedIn : () => true;

function useDeskLoad(enabled: boolean): [Phase, () => void] {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    setPhase({ k: 'loading' });
    void (async () => {
      try {
        const [me, earnings] = await Promise.all([getDeskMe(), getDeskEarnings().catch(() => null)]);
        if (dead) return;
        const first = me.consultant.name.replace(/^(dr\.?|pt\.?|acharya)\s+/i, '').trim().split(/\s+/)[0] ?? me.consultant.name;
        setPhase({ k: 'ready', v: { me, earnings, firstName: first } });
      } catch (e) {
        if (dead) return;
        if (e instanceof SignedOutError) { location.replace(signInUrlForHere()); return; }
        const st = errStatus(e);
        if (st === 401) { location.replace(signInUrlForHere()); return; }
        if (st === 403 || st === 404) { setPhase({ k: 'forbidden' }); return; }
        captureException(e, { where: 'consult_desk_load' });
        setPhase({ k: 'error', message: errMessage(e, 'We could not open your desk just now. Please try again.') });
      }
    })();
    return () => { dead = true; };
  }, [enabled, n]);
  return [phase, () => setN((x) => x + 1)];
}

function Gate({ page, children, aside, nav, back, bare }: { page: string; children: ReactNode; aside?: ReactNode; nav: boolean; back?: { href: string; label: string; right?: ReactNode }; bare?: boolean }) {
  const signed = useGuard();
  const [phase, retry] = useDeskLoad(signed);
  if (phase.k === 'loading') return <div className="cd-center" aria-busy="true"><p className="muted">Opening your desk…</p></div>;
  if (phase.k === 'forbidden') {
    return (
      <div className="cd-center" role="alert">
        <div className="card" style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center', background: '#fff' }}>
          <h1 style={{ fontSize: 24 }}>This page is for {BRAND.name} consultants</h1>
          <p className="muted">Your account is not linked to a consultant profile. If you should have one, ask the {BRAND.name} team to attach your sign-in email.</p>
          <a className="btn" href="/dashboard">Go to my dashboard</a>
        </div>
      </div>
    );
  }
  if (phase.k === 'error') {
    return (
      <div className="cd-center" role="alert">
        <div className="card" style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center', background: '#fff' }}>
          <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
          <p className="muted">{phase.message}</p>
          <button type="button" className="btn" onClick={retry}>Try again</button>
        </div>
      </div>
    );
  }
  if (bare) return <DeskCtx.Provider value={phase.v}>{children}</DeskCtx.Provider>;
  return (
    <DeskCtx.Provider value={phase.v}>
      <Shell page={page} aside={aside} nav={nav} back={back}>{children}</Shell>
    </DeskCtx.Provider>
  );
}

export function SideMenu({ page }: { page: string }) {
  return (
    <aside className="side cd-side" aria-label="Desk menu">
      <span className="logo" style={{ padding: '0 14px 16px' }}>{BRAND.name} desk</span>
      {SIDE.map((i) => <a key={i.key} href={i.href} className={i.key === page ? 'on' : undefined} aria-current={i.key === page ? 'page' : undefined}>{i.label}</a>)}
    </aside>
  );
}

function Shell({ page, children, aside, nav, back }: { page: string; children: ReactNode; aside?: ReactNode; nav: boolean; back?: { href: string; label: string; right?: ReactNode } }) {
  const { me, earnings, firstName } = useDesk();
  const today = useMemo(() => dayIst(Date.now()), []);
  const wallet = earnings?.wallet_rupees;
  return (
    <div className={`cd-shell${aside ? ' cd-has-aside' : ''}`}>
      <SideMenu page={page} />
      <div className="cd-col">
        {back ? (
          <header className="topbar cd-top">
            <a href={back.href} style={{ fontWeight: 800, textDecoration: 'none' }}>← {back.label}</a>
            {back.right}
          </header>
        ) : (
          <header className="topbar cd-top">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
              <img className="sticker" src={me.consultant.photo_url} alt="" style={{ width: 44, height: 44, borderWidth: 3 }} />
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
                <strong>Namaste, {firstName} ji</strong>
                <span className="hint">{today}</span>
              </div>
            </div>
            {typeof wallet === 'number' ? <a className="chip" href="/dashboard/wallet" style={{ textDecoration: 'none' }}>Wallet ₹{inr(wallet)}</a> : null}
          </header>
        )}
        <main className={`cd-main${nav ? '' : ' cd-main-nonav'}`}>{children}</main>
      </div>
      {aside ? <aside className="cd-aside">{aside}</aside> : null}
      {nav ? (
        <nav className="cd-bottomnav" aria-label="Desk">
          {NAV.map((i) => (
            <a key={i.key} href={i.href} className={i.key === page || (i.key === 'availability' && page === 'availability') ? 'on' : undefined} aria-current={i.key === page ? 'page' : undefined}>
              <Icon d={i.d} />{i.label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export interface DeskRootProps { page: string; children: ReactNode; aside?: ReactNode; nav?: boolean; back?: { href: string; label: string; right?: ReactNode }; /** children draw their own shell (the file page) */ bare?: boolean }
/** One island root per desk page: error boundary + Clerk + consultant guard + shell. */
export function DeskRoot({ page, children, aside, nav = true, back, bare }: DeskRootProps) {
  return (
    <IslandBoundary island="consult_desk">
      <ClerkIsland>
        <Gate page={page} aside={aside} nav={nav} back={back} bare={bare}>{children}</Gate>
      </ClerkIsland>
    </IslandBoundary>
  );
}
