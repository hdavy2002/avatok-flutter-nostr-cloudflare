/* Shared account schedule for customer tickets and creator operations. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ClerkIsland, getActiveTokenWaited as getActiveToken, SignInButton } from '../../lib/clerk';
import { useAuth } from '@clerk/clerk-react';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { ApiError } from '../../lib/apiClient';
import {
  getCommercialSchedule,
  resendCommercialConfirmation,
  type CommercialScheduleSession,
  type CommercialScheduleView,
} from '../../lib/commercialSessions';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { TicketCard } from './TicketCard';
import { capture } from '../../lib/analytics';

type Role = 'customer' | 'creator';

const VIEWS: Array<{ value: CommercialScheduleView; label: string }> = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'live', label: 'Live now' },
  { value: 'past', label: 'Past' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

function rowKey(row: CommercialScheduleSession): string {
  return `${row.kind}:${row.product_id ?? row.booking_id ?? row.listing_id}`;
}

function displayError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown; reason?: unknown } | null;
    return String(body?.reason ?? body?.error ?? e.error ?? 'The schedule could not be loaded.');
  }
  return e instanceof Error && e.message ? e.message : 'The schedule could not be loaded.';
}

export interface CommercialScheduleProps {
  role: Role;
  kind?: 'live_event' | 'consult_1to1';
  description?: string;
  emptyTitle?: string;
  emptyBody?: string;
}

function CommercialScheduleInner({ role, kind, description, emptyTitle, emptyBody }: CommercialScheduleProps) {
  const { userId, isLoaded } = useAuth();
  const [rowsAccount, setRowsAccount] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState<CommercialScheduleView>('all');
  const [rows, setRows] = useState<CommercialScheduleSession[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverNow, setServerNow] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setRowsAccount(null);
    setCursor(null);
    if (!isLoaded) return;
    void getActiveToken().then((t) => { if (active) { setToken(t); setAuthChecked(true); } });
    return () => { active = false; abortRef.current?.abort(); };
  }, [isLoaded, userId]);

  // A shared device can switch accounts while this island remains mounted.
  // Re-read the session when the page resumes and clear old rows before the
  // next account's response arrives.
  useEffect(() => {
    const refreshAccount = async () => {
      const next = await getActiveToken(1500, { skipCache: true });
      setToken((current) => current === next ? current : next);
    };
    const onVisibility = () => { if (!document.hidden) void refreshAccount(); };
    window.addEventListener('focus', refreshAccount);
    window.addEventListener('pageshow', refreshAccount);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', refreshAccount);
    return () => {
      window.removeEventListener('focus', refreshAccount);
      window.removeEventListener('pageshow', refreshAccount);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', refreshAccount);
    };
  }, []);

  const loadPage = useCallback(async (jwt: string, nextView: CommercialScheduleView, nextCursor: string | null, replace: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    if (replace) setLoading(true); else setLoadingMore(true);
    try {
      const fresh = await getActiveToken(1500, { skipCache: true });
      if (controller.signal.aborted) return;
      if (!fresh) { setToken(null); throw new Error('Please sign in again.'); }
      const result = await getCommercialSchedule(role, fresh, nextView, nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setRowsAccount(userId ?? null);
      setServerNow(Number(result.server_now) || null);
      setCursor(result.next_cursor || null);
      setRows((current) => {
        const incoming = (result.sessions ?? []).filter((row) => !kind || row.kind === kind || (kind === 'live_event' && row.kind === 'live'));
        if (replace || !current) return incoming;
        const seen = new Set(current.map(rowKey));
        return [...current, ...incoming.filter((row) => !seen.has(rowKey(row)))];
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(displayError(e));
      if (replace) setRows(null);
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false); }
    }
  }, [kind, role, userId]);

  useEffect(() => {
    if (!token) { setRows(null); setCursor(null); setError(null); return; }
    setRows(null);
    setCursor(null);
    void loadPage(token, view, null, true);
    return () => abortRef.current?.abort();
  }, [loadPage, token, view]);

  // Reconcile the server window while a tab stays open. This updates Start /
  // Join as opens_at and closes_at pass without trusting a client-only clock.
  useEffect(() => {
    if (!token) return;
    const refresh = () => { if (!document.hidden) void loadPage(token, view, null, true); };
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('online', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('online', refresh); };
  }, [loadPage, token, view]);

  async function resend(orderId: string) {
    if (!token) throw new Error('Sign in to resend this confirmation.');
    const fresh = await getActiveToken(1500, { skipCache: true });
    if (!fresh) throw new Error('Please sign in again.');
    return resendCommercialConfirmation(orderId, fresh);
  }

  if (!authChecked) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /><span className="font-body font-bold text-inkSoft">Checking your account…</span></div>;
  if (!token) return (
    <Card shadow="lg"><div className="flex flex-col gap-3">
      <h2 className="font-display text-[22px] font-semibold text-ink">Sign in to see your {role === 'customer' ? 'tickets and appointments' : 'creator schedule'}</h2>
      <p className="font-body text-[15px] font-bold text-inkSoft">Your schedule is tied to the account that purchased or hosts each session.</p>
      <div><SignInButton mode="modal"><Button variant="lime" label="Sign in" /></SignInButton></div>
    </div></Card>
  );

  const visible = rowsAccount === userId ? rows ?? [] : [];
  return (
    <div className="flex flex-col gap-5">
      {description && <p className="font-body text-[15px] font-bold text-inkSoft">{description}</p>}
      <ScheduleTabs view={view} onChange={(next) => { capture('dashboard_schedule_tab_switch', { view: next }); setView(next); }} />
      {error && <div className="rounded-zine border-zine border-coral bg-paper2 p-3 font-body text-[14px] font-bold text-ink" role="alert">⚠ {error}</div>}
      {serverNow && <p className="font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-inkMute">Times shown in your local timezone · schedule checked {new Date(serverNow).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</p>}
      {loading && !rows ? <div className="flex items-center gap-3 p-4"><Spinner size={22} /><span className="font-body font-bold text-inkSoft">Loading your schedule…</span></div>
        : visible.length ? <div className="flex flex-col gap-3">{visible.map((row) => <TicketCard key={rowKey(row)} session={row} past={view === 'past' || view === 'cancelled'} onResend={role === 'customer' ? resend : undefined} />)}</div>
        : !error ? <Card fillClassName="bg-paper2"><p className="font-body text-[15px] font-bold text-inkSoft">{emptyTitle ?? (role === 'customer' ? 'Nothing here yet.' : 'No sessions in this view.')}</p>{emptyBody && <p className="mt-1 font-body text-[14px] font-bold text-inkMute">{emptyBody}</p>}</Card> : null}
      {cursor && <button type="button" onClick={() => token && void loadPage(token, view, cursor, false)} disabled={loadingMore} className="self-start rounded-full border-zine border-ink bg-paper px-4 py-2.5 font-mono text-[13px] font-bold uppercase tracking-[0.04em] text-ink shadow-zine-xs disabled:opacity-50">{loadingMore ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}

/**
 * [UI-MOTION-1 2026-09-10] transitions.dev's "tabs-sliding" snippet (`.t-*`
 * classes, `src/styles/motion.css`). The pill's position/width are measured
 * off the active tab's DOM node and written inline so the CSS transition
 * tweens between the previous and next rect; first paint and resize snap
 * with no transition so the pill never animates in from `left:0`.
 */
function ScheduleTabs({ view, onChange }: { view: CommercialScheduleView; onChange: (v: CommercialScheduleView) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<Partial<Record<CommercialScheduleView, HTMLButtonElement | null>>>({});

  const moveTo = useCallback((animate: boolean) => {
    const tab = tabRefs.current[view];
    const pill = pillRef.current;
    if (!tab || !pill) return;
    if (!animate) {
      const prev = pill.style.transition;
      pill.style.transition = 'none';
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      void pill.offsetWidth;
      pill.style.transition = prev;
    } else {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
    }
  }, [view]);

  useLayoutEffect(() => { moveTo(true); }, [moveTo]);
  useEffect(() => {
    const onResize = () => moveTo(false);
    requestAnimationFrame(onResize);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [moveTo]);

  return (
    <div ref={barRef} className="t-tabs" role="tablist" aria-label="Schedule views">
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {VIEWS.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          ref={(el) => { tabRefs.current[item.value] = el; }}
          aria-selected={view === item.value}
          onClick={() => onChange(item.value)}
          className="t-tab font-mono text-[12px] font-bold uppercase tracking-[0.04em]"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function CommercialSchedule(props: CommercialScheduleProps) {
  if (!CLERK_PUBLISHABLE_KEY) return <p>Sign-in is temporarily unavailable.</p>;
  return <ClerkIsland><CommercialScheduleInner {...props} /></ClerkIsland>;
}

export default CommercialSchedule;
