/* [HF-CALLS-1] Shared /dashboard: Online/Offline switch (+ heartbeat every 5 min while this tab is visible), today's numbers, recent calls.
 * Worker: GET /api/hosts/me, PUT /api/hosts/me/presence {online}, POST /api/hosts/me/presence/beat, GET /api/hosts/me/calls.
 * Calls list is read defensively (array, or {items|calls, today?}); see the report for the assumed row fields. */
import { useCallback, useEffect, useRef, useState } from 'react';
import SessionBridge from './SessionBridge';
import WithdrawPanel from './WithdrawPanel'; // [HF-PAYOUT-1]
import { API_BASE } from '../../lib/env';
import { callsEnabled, fetchWallet, hfCall, hostPaise, relDate, signInUrl, toMs, type HostPresence, type WalletInfo } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';
import '../../styles/hf-calls.css';
import { bookingError, bookingsEnabled, getBookingSummary, money, type BookingSummary } from '../../lib/hfBookingsApi';
import '../../styles/hf-bookings.css';
import DashboardNav, { retiredDashboardNotices, type DashboardAccount } from '../../components/account/DashboardNav';
import DashboardCalendar from '../../components/account/DashboardCalendar';
import { DashboardIcon } from '../../components/account/DashboardNav';
import { BRAND } from '../../lib/brand';

const BEAT_MS = 5 * 60_000;
const REFRESH_MS = 60_000;

interface MeHost { slug: string | null; status: string; displayName: string | null; presence?: string | null }
interface Row { id: string; status: string; handle: string; at: number | null; minutes: number; earned: number | null; seconds?: number }
interface Today { calls: number; minutes: number; earned: number }

const STATUS_NOTE: Record<string, string> = {
  draft: 'You haven’t finished your profile yet.',
  generating: 'We’re preparing your profile.',
  pending_host: 'Your profile is ready. Please check it and send it for review.',
  pending_review: 'Our team is checking your profile. We’ll WhatsApp you when you’re live, usually within 24 hours.',
  paused: 'Your profile is paused for now. Please contact support if you’re not sure why.',
  rejected: 'Your profile needs some changes before it can go live.',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function normRow(x: Record<string, unknown>): Row {
  const paise = num(x.hostEarningPaise) ?? num(x.earningPaise);
  return {
    id: String(x.id ?? Math.random()),
    status: String(x.status ?? ''),
    handle: String(x.callerHandle ?? x.handle ?? x.caller ?? 'A caller'),
    at: toMs((x.connectedAt ?? x.createdAt ?? x.startedAt ?? null) as number | string | null),
    minutes: num(x.billedMinutes) ?? 0,
    seconds: num(x.billableSeconds) ?? undefined,
    earned: num(x.hostEarningRupees) ?? num(x.earnedRupees) ?? (paise != null ? paise / 100 : null),
  };
}
function parseCalls(d: unknown): { rows: Row[]; today: Today } {
  const obj = (Array.isArray(d) ? { items: d } : (d ?? {})) as Record<string, unknown>;
  if (!Array.isArray(obj.items) && !Array.isArray(obj.calls)) throw new Error('Invalid call response');
  const list = (Array.isArray(obj.items) ? obj.items : Array.isArray(obj.calls) ? obj.calls : []) as Record<string, unknown>[];
  const rows = list.map(normRow);
  const t = obj.today as Record<string, unknown> | undefined;
  if (t && typeof t === 'object') {
    return { rows, today: { calls: num(t.calls) ?? 0, minutes: num(t.minutes) ?? 0, earned: num(t.earningRupees) ?? num(t.earnedRupees) ?? ((num(t.earningPaise) ?? 0) / 100) } };
  }
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todays = rows.filter(r => r.status === 'completed' && r.at != null && r.at >= start.getTime());
  return { rows, today: { calls: todays.length, minutes: todays.reduce((a, r) => a + r.minutes, 0), earned: todays.reduce((a, r) => a + (r.earned ?? 0), 0) } };
}
function rowText(r: Row): string {
  switch (r.status) {
    case 'completed': return `${r.seconds != null ? `${Math.floor(r.seconds / 60)} min ${r.seconds % 60} s` : `${r.minutes} min`}${r.earned != null ? ` · ${formatPaise(Math.round(r.earned * 100))}` : ''}`;
    case 'connected': return 'On a call now';
    case 'ringing_host': case 'ringing_caller': return 'Ringing';
    case 'host_declined': return 'You declined';
    case 'no_answer': return 'Missed';
    case 'caller_no_answer': return 'Caller didn’t pick up';
    case 'blocked': return 'Ended and blocked';
    default: return 'Not connected';
  }
}

export default function HostDashboard() {
  const [phase, setPhase] = useState<'boot' | 'signedout' | 'error' | 'ready'>('boot');
  const [account, setAccount] = useState<DashboardAccount | null>(null);
  const [hostUnavailable, setHostUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const eligible = useRef(false);
  const [host, setHost] = useState<MeHost | null>(null);
  const [on, setOn] = useState(false);
  const [presence, setPresence] = useState<HostPresence>('offline');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const [callsError, setCallsError] = useState('');
  const [appointmentsToday, setAppointmentsToday] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [bookingSummary, setBookingSummary] = useState<BookingSummary | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [bookingErrorText, setBookingErrorText] = useState('');
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  const loadCalls = useCallback(async (run = generation.current) => {
    const current = () => run === generation.current && eligible.current;
    if (!current()) return;
    try {
      const r = await hfCall<unknown>('GET', '/api/hosts/me/calls');
      if (!current()) return;
      if (r.ok) { const p = parseCalls(r.data); setRows(p.rows); setToday(p.today); setCallsError(''); }
      else { setToday(null); setRows([]); setCallsError('We could not load your calls.'); }
      const w = await fetchWallet();
      if (!current()) return;
      if (w.ok) setWallet(w.data);
      const enabled = await bookingsEnabled();
      if (!current()) return;
      setBookingOn(enabled);
      if (!enabled) { setBookingSummary(null); setBookingErrorText(''); return; }
      try {
        const summary = await getBookingSummary();
        if (current()) { setBookingSummary(summary); setBookingErrorText(''); }
      } catch (error) { if (current()) { setBookingSummary(null); setBookingErrorText(bookingError(error).message); } }
    } catch { if (current()) { setToday(null); setRows([]); setCallsError('We could not refresh your activity. Please try again.'); } }
  }, []);

  useEffect(() => {
    let disposed = false;
    async function load() {
      const run = ++generation.current;
      const current = () => !disposed && run === generation.current;
      eligible.current = false; presenceRef.current = 'offline';
      setPhase('boot'); setAccount(null); setHost(null); setHostUnavailable(false); setOn(false); setPresence('offline');
      setBusy(false); setMsg(''); setRows([]); setToday(null); setCallsError(''); setAppointmentsToday(null);
      setWallet(null); setBookingSummary(null); setBookingOn(false); setBookingErrorText('');
      let loadedIdentity = false;
      try {
        const identity = await hfCall<DashboardAccount>('GET', '/api/hf/me');
        if (!current()) return;
        if (!identity.ok) { setPhase(identity.status === 401 ? 'signedout' : 'error'); return; }
        setAccount(identity.data);
        loadedIdentity = true;
        const appointmentsEnabled = await bookingsEnabled();
        if (!current()) return;
        setBookingOn(appointmentsEnabled);
        // A host lookup is only needed for an existing host; customers never invoke host APIs.
        if (identity.data.host && !identity.data.closing) {
          const me = await hfCall<{ host: MeHost | null }>('GET', '/api/hosts/me');
          if (!current()) return;
          if (!me.ok) {
            if (me.status === 401) { setAccount(null); setPhase('signedout'); }
            else { setHostUnavailable(true); setPhase('ready'); }
            return;
          }
          const h = me.data.host;
          setHost(h);
          setAccount({ ...identity.data, host: h });
          if (h?.status === 'live') {
            eligible.current = true;
            const enabled = await callsEnabled();
            if (!current()) return;
            setOn(enabled);
            let p = h.presence;
            if (!p && h.slug) {
              try {
                const res = await fetch(`${API_BASE}/api/hosts/public/${encodeURIComponent(h.slug)}`, { cache: 'no-store' });
                if (res.ok) p = ((await res.json()) as { status?: string }).status;
              } catch { /* default offline */ }
            }
            if (!current()) return;
            setPresence(p === 'online' || p === 'busy' ? p : 'offline');
            await loadCalls(run);
          }
        }
        if (current()) setPhase('ready');
      } catch {
        if (current()) {
          // Identity already loaded: keep common account actions available when hosting is unreachable.
          if (loadedIdentity) { eligible.current = false; setHost(null); setHostUnavailable(true); setPhase('ready'); }
          else setPhase('error');
        }
      }
    }
    void load();
    const changed = () => { void load(); };
    window.addEventListener('site:active-session-changed', changed);
    return () => {
      disposed = true; ++generation.current; eligible.current = false; presenceRef.current = 'offline';
      window.removeEventListener('site:active-session-changed', changed);
    };
  }, [loadCalls, retry]);

  const isLive = host?.status === 'live' && !account?.closing;
  const online = presence === 'online' || presence === 'busy';
  useEffect(() => {
    if (phase !== 'ready' || !isLive) return;
    const run = generation.current;
    const current = () => run === generation.current && eligible.current;
    const beat = () => {
      if (current() && on && document.visibilityState === 'visible' && presenceRef.current !== 'offline') {
        void hfCall('POST', '/api/hosts/me/presence/beat', undefined, { isCurrent: current }).catch(() => {});
      }
    };
    const refresh = () => { if (current() && document.visibilityState === 'visible') void loadCalls(run); };
    const b = setInterval(beat, BEAT_MS);
    const r = setInterval(refresh, REFRESH_MS);
    const vis = () => { if (document.visibilityState === 'visible') { beat(); refresh(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(b); clearInterval(r); document.removeEventListener('visibilitychange', vis); };
  }, [phase, isLive, on, loadCalls]);

  const toggle = async () => {
    if (!eligible.current || !on || busy) return;
    const run = generation.current;
    setBusy(true); setMsg('');
    try {
      const r = await hfCall<{ ok: boolean; presence: string }>('PUT', '/api/hosts/me/presence', { online: !online }, { isCurrent: () => run === generation.current && eligible.current });
      if (run !== generation.current || !eligible.current) return;
      if (r.ok) { const p = r.data.presence; setPresence(p === 'online' || p === 'busy' ? p : 'offline'); }
      else setMsg(r.status === 401 ? 'Please sign in again.' : r.message || 'We could not change that. Please try again.');
    } catch { if (run === generation.current) setMsg('We could not reach the server. Please try again.'); }
    finally { if (run === generation.current) setBusy(false); }
  };

  if (phase === 'boot') return <main className="hfc-page"><p role="status">Loading your dashboard…</p></main>;
  if (phase === 'signedout') {
    return <main className="hfc-page"><h1>Dashboard</h1><p>Please sign in to see your dashboard.</p><a className="hfc-btn hfc-primary" href={signInUrl('/dashboard')}>Sign in</a></main>;
  }
  if (phase === 'error') {
    return <main className="hfc-page"><h1>Dashboard</h1><p>We could not load your dashboard. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></main>;
  }

  if (!account) return null;
  const notice = retiredDashboardNotices[new URLSearchParams(window.location.search).get('retired') ?? ''];
  const hostStatus = host?.status ?? account.host?.status;
  const session = generation.current;
  const initials = (account.displayName || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase();
  return (
    <main className="hfc-page hfd-page">
      <SessionBridge on />
      <div className="hfd-layout"><DashboardNav account={account} bookingOn={bookingOn} active="overview" /><div className="hfd-content">
      <header className="hfd-heading"><div><p className="hfd-greeting">Hi, {account.displayName || 'there'}</p><h1>Your dashboard</h1><p>Here’s what’s happening with your {BRAND.name} space today.</p></div><div className="hfd-welcome"><span className="hfd-host-badge">{isLive ? '★ You’re a host' : '♡ Your space'}</span><small>{isLive ? 'Your host profile is live.' : 'Real people. Meaningful conversations.'}</small></div><div className="hfd-avatar" aria-label={account.displayName ? `${account.displayName} profile` : 'Your profile'}>{initials || <DashboardIcon name="profile" />}</div><div className="hfd-kindness">Same people.<br />Brighter tomorrows. <span aria-hidden="true">♥</span></div></header>
      {notice && <aside className="hfd-notice" role="status">{notice} <a href="/help">Contact support</a> if you need help with an earlier record.</aside>}
      {account.closing && <aside className="hfd-notice" role="status"><strong>Your account is being closed.</strong> Hosting and profile editing are paused. <a href="/account/close">Manage account closure</a></aside>}
      {hostUnavailable && <aside className="hfd-notice" role="status">Your account is available, but we could not load your host activity. <button type="button" className="hfb-text-button" onClick={() => setRetry(value => value + 1)}>Retry host activity</button></aside>}
      <div className="hfd-top-grid">
      {!isLive && !hostUnavailable && !account.closing && <section className="hfc-card"><h2>{hostStatus ? 'Your host profile' : 'Share your time as a host'}</h2><p>{hostStatus ? (STATUS_NOTE[hostStatus] ?? 'Your profile is not live yet.') : 'Create a host profile when you’re ready to take calls. You can keep exploring and booking appointments anytime.'}</p><a className="hfc-btn hfc-primary" href="/hosts/onboarding">{hostStatus ? 'Continue my profile' : 'Become a host'}</a></section>}
      {isLive && <section className="hfc-card hfc-switch-wrap hfd-status" aria-labelledby="hfc-state"><h2>Host status</h2>
        <button type="button" role="switch" aria-checked={online} aria-labelledby="hfc-state" className="hfc-switch" onClick={toggle} disabled={busy || !on} />
        <p className="hfc-state" id="hfc-state">{!on ? 'Calls open soon' : online ? 'Online' : 'Offline'}</p>
        <p className="hfc-sub" style={{ margin: 0, color: '#785979' }}>
          {!on ? 'Calling isn’t switched on yet. We’ll tell you on WhatsApp when it is.'
            : online ? (presence === 'busy' ? 'You’re on a call right now.' : 'Callers can call you now. Keep this page open, or switch off when you’re done.')
              : 'Switch on when you’re ready to take calls. People who asked to be told will get a WhatsApp.'}
        </p>
        <p className="hfd-gentle-note">🌿 Take a break anytime. Switch offline when you don’t want to receive new calls.</p>
        {msg && <p className="hfc-err" role="alert">{msg}</p>}
      </section>}
      <section className="hfc-card hfd-glance"><h2>Today at a glance</h2><div className="hfd-stat-grid"><div className="hfd-stat-tile"><span className="hfd-icon-circle"><DashboardIcon name="calls" /></span><div><h3>Calls today</h3><strong>{today?.calls ?? '—'}</strong><p>{isLive ? 'Moments of meaningful conversation.' : 'Your call history is in your wallet.'}</p></div></div><div className="hfd-stat-tile hfd-peach"><span className="hfd-icon-circle"><DashboardIcon name="calendar" /></span><div><h3>Appointments today</h3><strong>{appointmentsToday ?? '—'}</strong><p>Scheduled time to connect.</p></div></div><div className="hfd-stat-tile"><span className="hfd-icon-circle"><DashboardIcon name="profile" /></span><div><h3>New Fraands</h3><strong>—</strong><p>Not available yet.</p></div></div></div>{callsError && <p className="hfc-err" role="status">{callsError} <button type="button" className="hfb-text-button" onClick={() => void loadCalls()}>Retry</button></p>}</section>
      </div><div className="hfd-main-grid"><DashboardCalendar key={`${account.uid}:${session}`} uid={account.uid} host={isLive} enabled={bookingOn && !account.closing} onTodayCount={setAppointmentsToday} /><div className="hfd-summary-stack">
      <section className="hfc-card hfd-expected"><div className="hfd-card-head"><h2>Expected earnings</h2><span>Upcoming bookings</span></div><strong className="hfd-amount">{isLive && bookingSummary ? money(bookingSummary.expectedHostNetPaise) : '—'}</strong><p className="hfd-muted">{isLive ? 'Estimated earnings on hold. Final amounts depend on completed calls and platform fees.' : 'Become a host to earn from your conversations.'}</p>{bookingErrorText && <p role="status">{bookingErrorText} <button type="button" className="hfb-text-button" onClick={() => void loadCalls()}>Retry</button></p>}<div className="hfd-encouragement">Keep going! Meaningful conversations create real impact.</div></section>
      <section className="hfc-card hfd-recent" aria-labelledby="hfc-recent"><div className="hfd-card-head"><h2 id="hfc-recent">Recent calls</h2><a href="/wallet#hfw-hist">View all →</a></div>{!isLive ? <p className="hfd-muted">Find your calls in <a href="/wallet#hfw-hist">wallet history</a>.</p> : callsError ? <p role="status">{callsError}</p> : !today ? <p role="status">Loading calls…</p> : rows.length === 0 ? <div className="hfd-recent-empty"><span className="hfd-icon-circle"><DashboardIcon name="calls" /></span><div><strong>No calls yet</strong><p>Your recent calls will appear here.</p></div></div> : <ul className="hfc-calls">{rows.slice(0, 3).map(r => <li key={r.id}><strong>{r.handle}</strong><span>{rowText(r)}</span>{r.at && <small>{relDate(r.at)}</small>}</li>)}</ul>}<p className="hfd-call-privacy">You only see a caller’s handle, never their number. Calls are not recorded.</p></section>
      </div></div>
      <footer className="hfd-footer"><span aria-hidden="true">♥</span> Meaningful conversations. A kinder, brighter world.</footer>
      {isLive && <div className="hfd-finances">


      <section className="hfc-card"><h2>Today’s earnings</h2><div className="hfc-stats"><div className="hfc-stat"><strong>{today ? formatPaise(Math.round(today.earned * 100)) : '—'}</strong><span>earned today</span></div><div className="hfc-stat"><strong>{today?.minutes ?? '—'}</strong><span>connected minutes</span></div></div></section>
      {wallet?.host && (() => { const hp = hostPaise(wallet.host); return (
        <section className="hfc-card" aria-labelledby="hfc-earn">
          <h2 id="hfc-earn">Your earnings</h2>
          <p className="hfc-sub" style={{ margin: 0 }}>{wallet.mode === 'rupees' ? 'Standard plan: you earn ₹2.00 for every connected minute.' : 'Your earnings use the rate agreed for each call.'}</p>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{formatPaise(hp.pending)}</strong><span>pending (releases after 7 days)</span></div>
            <div className="hfc-stat"><strong>{formatPaise(hp.available)}</strong><span>available to withdraw</span></div>
            <div className="hfc-stat"><strong>{formatPaise(hp.total)}</strong><span>total earned</span></div>
            {hp.test > 0 && <div className="hfc-stat"><strong>{formatPaise(hp.test)}</strong><span>from test credits, not withdrawable</span></div>}
          </div>
          {(hp.openPayout > 0 || hp.paidOut > 0) && <p className="hfc-sub" style={{ margin: 0 }}>Withdrawals: {formatPaise(hp.openPayout)} in progress · {formatPaise(hp.paidOut)} paid out</p>}
          {wallet.host?.payouts && wallet.host.payouts.length > 0 && (
            <ul className="hfc-calls">
              {wallet.host.payouts.map(p => (
                <li key={p.id}><strong>Withdrawal · {p.status}</strong><span>{formatPaise(p.amountPaise)}</span><small>{relDate(p.paidAt ?? p.createdAt)}</small></li>
              ))}
            </ul>
          )}
          <p className="hfc-sub" style={{ margin: 0 }}><a href="/wallet">See wallet and history</a></p>
        </section>
      ); })()}

      <WithdrawPanel key={`${account.uid}:${session}`} isCurrent={() => session === generation.current && eligible.current} onChanged={() => { if (session === generation.current) void loadCalls(session); }} />

      </div>}
      </div></div>
    </main>
  );
}
