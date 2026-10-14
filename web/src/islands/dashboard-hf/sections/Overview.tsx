/* [HF-DASH-SHELL-2] Overview screen of the dashboard (was the body of islands/calls/HostDashboard.tsx).
 * Identity comes from the shell (DashboardApp); this screen loads host presence, today's calls and the booking summary.
 * Worker: GET /api/hosts/me, PUT /api/hosts/me/presence {online}, POST /api/hosts/me/presence/beat, GET /api/hosts/me/calls,
 * GET /api/hf/wallet, GET /api/hosts/me/bookings/summary. Host earnings and withdrawals now live on /dashboard/host/earnings. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/env';
import { callsEnabled, hfCall, relDate, type HostPresence } from '../../../lib/hfCallsApi';
import { bookingError, getBookingSummary, money, type BookingSummary } from '../../../lib/hfBookingsApi';
import { retiredDashboardNotices, DashboardIcon, type DashboardAccount } from '../../../components/account/DashboardNav';
import DashboardCalendar from '../../../components/account/DashboardCalendar';
import { BRAND } from '../../../lib/brand';
import { BEAT_MS, REFRESH_MS, STATUS_NOTE, parseCalls, rowText, type MeHost, type Row, type Today } from '../hostActivity';

export default function Overview({ account, bookingOn, onAccountChanged }: { account: DashboardAccount; bookingOn: boolean; onAccountChanged: (a: DashboardAccount) => void }) {
  const [host, setHost] = useState<MeHost | null>(null);
  const [hostUnavailable, setHostUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const eligible = useRef(false);
  const [on, setOn] = useState(false);
  const [presence, setPresence] = useState<HostPresence>('offline');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const [callsError, setCallsError] = useState('');
  const [appointmentsToday, setAppointmentsToday] = useState<number | null>(null);
  const [bookingSummary, setBookingSummary] = useState<BookingSummary | null>(null);
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
      if (!bookingOn) { setBookingSummary(null); setBookingErrorText(''); return; }
      try {
        const summary = await getBookingSummary();
        if (current()) { setBookingSummary(summary); setBookingErrorText(''); }
      } catch (error) { if (current()) { setBookingSummary(null); setBookingErrorText(bookingError(error).message); } }
    } catch { if (current()) { setToday(null); setRows([]); setCallsError('We could not refresh your activity. Please try again.'); } }
  }, [bookingOn]);

  useEffect(() => {
    let disposed = false;
    const run = ++generation.current;
    const current = () => !disposed && run === generation.current;
    eligible.current = false; presenceRef.current = 'offline';
    setHost(null); setHostUnavailable(false); setOn(false); setPresence('offline'); setRows([]); setToday(null); setCallsError('');
    void (async () => {
      // A host lookup is only needed for an existing host; customers never invoke host APIs.
      if (!account.host || account.closing) return;
      try {
        const me = await hfCall<{ host: MeHost | null }>('GET', '/api/hosts/me');
        if (!current()) return;
        if (!me.ok) { setHostUnavailable(true); return; }
        const h = me.data.host;
        setHost(h);
        if (h && (h.status !== account.host?.status || h.slug !== account.host?.slug)) onAccountChanged({ ...account, host: { status: h.status, slug: h.slug } });
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
      } catch { if (current()) { eligible.current = false; setHost(null); setHostUnavailable(true); } }
    })();
    return () => { disposed = true; ++generation.current; eligible.current = false; presenceRef.current = 'offline'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.uid, account.host?.status, account.closing, loadCalls, retry]);

  const isLive = host?.status === 'live' && !account.closing;
  const online = presence === 'online' || presence === 'busy';
  useEffect(() => {
    if (!isLive) return;
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
  }, [isLive, on, loadCalls]);

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

  const notice = retiredDashboardNotices[new URLSearchParams(window.location.search).get('retired') ?? ''];
  const hostStatus = host?.status ?? account.host?.status;
  const initials = (account.displayName || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase();
  return <>
    <header className="hfd-heading"><div><p className="hfd-greeting">Hi, {account.displayName || 'there'}</p><h1>Your dashboard</h1><p>Here’s what’s happening with your {BRAND.name} space today.</p></div><div className="hfd-welcome"><span className="hfd-host-badge">{isLive ? '★ You’re a host' : '♡ Your space'}</span><small>{isLive ? 'Your host profile is live.' : 'Real people. Meaningful conversations.'}</small></div><a className="hfd-avatar" href="/dashboard/profile" aria-label={account.displayName ? `${account.displayName} profile` : 'Your profile'}>{initials || <DashboardIcon name="profile" />}</a><div className="hfd-kindness">Same people.<br />Brighter tomorrows. <span aria-hidden="true">♥</span></div></header>
    {notice && <aside className="hfd-notice" role="status">{notice} <a href="/dashboard/support">Contact support</a> if you need help with an earlier record.</aside>}
    {account.closing && <aside className="hfd-notice" role="status"><strong>Your account is being closed.</strong> Hosting and profile editing are paused. <a href="/dashboard/close">Manage account closure</a></aside>}
    {hostUnavailable && <aside className="hfd-notice" role="status">Your account is available, but we could not load your host activity. <button type="button" className="hfb-text-button" onClick={() => setRetry(value => value + 1)}>Retry host activity</button></aside>}
    <div className="hfd-top-grid">
      {!isLive && !hostUnavailable && !account.closing && <section className="hfc-card"><h2>{hostStatus ? 'Your host profile' : 'Share your time as a host'}</h2><p>{hostStatus ? (STATUS_NOTE[hostStatus] ?? 'Your profile is not live yet.') : 'Create a host profile when you’re ready to take calls. You can keep exploring and booking appointments anytime.'}</p><a className="hfc-btn hfc-primary" href={hostStatus ? '/dashboard/host' : '/hosts/onboarding'}>{hostStatus ? 'Continue my profile' : 'Become a host'}</a></section>}
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
      <section className="hfc-card hfd-glance"><h2>Today at a glance</h2><div className="hfd-stat-grid"><div className="hfd-stat-tile"><span className="hfd-icon-circle"><DashboardIcon name="calls" /></span><div><h3>Calls today</h3><strong>{today?.calls ?? '—'}</strong><p>{isLive ? 'Moments of meaningful conversation.' : 'Your calls are in Calls.'}</p></div></div><div className="hfd-stat-tile hfd-peach"><span className="hfd-icon-circle"><DashboardIcon name="calendar" /></span><div><h3>Appointments today</h3><strong>{appointmentsToday ?? '—'}</strong><p>Scheduled time to connect.</p></div></div><div className="hfd-stat-tile"><span className="hfd-icon-circle"><DashboardIcon name="profile" /></span><div><h3>New Fraands</h3><strong>—</strong><p>Not available yet.</p></div></div></div>{callsError && <p className="hfc-err" role="status">{callsError} <button type="button" className="hfb-text-button" onClick={() => void loadCalls()}>Retry</button></p>}</section>
    </div>
    <div className="hfd-main-grid"><DashboardCalendar key={account.uid} uid={account.uid} host={isLive} enabled={bookingOn && !account.closing} onTodayCount={setAppointmentsToday} /><div className="hfd-summary-stack">
      <section className="hfc-card hfd-expected"><div className="hfd-card-head"><h2>Expected earnings</h2>{isLive ? <a href="/dashboard/host/earnings">Earnings →</a> : <span>Upcoming bookings</span>}</div><strong className="hfd-amount">{isLive && bookingSummary ? money(bookingSummary.expectedHostNetPaise) : '—'}</strong><p className="hfd-muted">{isLive ? 'Estimated earnings on hold. Final amounts depend on completed calls and platform fees.' : 'Become a host to earn from your conversations.'}</p>{bookingErrorText && <p role="status">{bookingErrorText} <button type="button" className="hfb-text-button" onClick={() => void loadCalls()}>Retry</button></p>}<div className="hfd-encouragement">Keep going! Meaningful conversations create real impact.</div></section>
      <section className="hfc-card hfd-recent" aria-labelledby="hfc-recent"><div className="hfd-card-head"><h2 id="hfc-recent">Recent calls</h2><a href="/dashboard/calls">View all →</a></div>{!isLive ? <p className="hfd-muted">Find all your calls in <a href="/dashboard/calls">Calls</a>.</p> : callsError ? <p role="status">{callsError}</p> : !today ? <p role="status">Loading calls…</p> : rows.length === 0 ? <div className="hfd-recent-empty"><span className="hfd-icon-circle"><DashboardIcon name="calls" /></span><div><strong>No calls yet</strong><p>Your recent calls will appear here.</p></div></div> : <ul className="hfc-calls">{rows.slice(0, 3).map(r => <li key={r.id}><strong>{r.handle}</strong><span>{rowText(r)}</span>{r.at && <small>{relDate(r.at)}</small>}</li>)}</ul>}<p className="hfd-call-privacy">You only see a caller’s handle, never their number. Calls are not recorded.</p></section>
    </div></div>
    <footer className="hfd-footer"><span aria-hidden="true">♥</span> Meaningful conversations. A kinder, brighter world.</footer>
  </>;
}
