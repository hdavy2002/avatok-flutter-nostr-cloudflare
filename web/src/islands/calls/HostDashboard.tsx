/* [HF-CALLS-1] /hosts/dashboard: Online/Offline switch (+ heartbeat every 5 min while this tab is visible), today's numbers, recent calls.
 * Worker: GET /api/hosts/me, PUT /api/hosts/me/presence {online}, POST /api/hosts/me/presence/beat, GET /api/hosts/me/calls.
 * Calls list is read defensively (array, or {items|calls, today?}); see the report for the assumed row fields. */
import { useCallback, useEffect, useRef, useState } from 'react';
import SessionBridge from './SessionBridge';
import WithdrawPanel from './WithdrawPanel'; // [HF-PAYOUT-1]
import { API_BASE } from '../../lib/env';
import { callsEnabled, fetchWallet, hfCall, hostPaise, looksSignedOut, relDate, signInUrl, toMs, type HostPresence, type WalletInfo } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';
import '../../styles/hf-calls.css';
import { bookingError, bookingsEnabled, dateLabel, getBookingSummary, money, type BookingSummary } from '../../lib/hfBookingsApi';
import '../../styles/hf-bookings.css';

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
  const [host, setHost] = useState<MeHost | null>(null);
  const [on, setOn] = useState(false);
  const [presence, setPresence] = useState<HostPresence>('offline');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [today, setToday] = useState<Today>({ calls: 0, minutes: 0, earned: 0 });
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [bookingSummary, setBookingSummary] = useState<BookingSummary | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [bookingErrorText, setBookingErrorText] = useState('');
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  const loadCalls = useCallback(async () => {
    const r = await hfCall<unknown>('GET', '/api/hosts/me/calls');
    if (r.ok) { const p = parseCalls(r.data); setRows(p.rows); setToday(p.today); }
    const w = await fetchWallet(); // [HF-WALLET-1] earnings breakdown
    if (w.ok) setWallet(w.data);
    const enabled = await bookingsEnabled(); setBookingOn(enabled);
    if (!enabled) { setBookingSummary(null); setBookingErrorText(''); return; }
    try { setBookingSummary(await getBookingSummary()); setBookingErrorText(''); }
    catch (error) { setBookingErrorText(bookingError(error).message); }
  }, []);

  useEffect(() => {
    if (looksSignedOut()) { setPhase('signedout'); return; }
    let live = true;
    (async () => {
      setOn(await callsEnabled());
      const me = await hfCall<{ host: MeHost | null }>('GET', '/api/hosts/me');
      if (!live) return;
      if (!me.ok) { setPhase(me.status === 401 ? 'signedout' : 'error'); return; }
      const h = me.data.host;
      setHost(h);
      if (h && h.status === 'live') {
        let p: string | null | undefined = h.presence;
        if (!p && h.slug) {
          try { const res = await fetch(`${API_BASE}/api/hosts/public/${encodeURIComponent(h.slug)}`, { cache: 'no-store' }); if (res.ok) p = ((await res.json()) as { status?: string }).status; } catch { /* default offline */ }
        }
        if (live) setPresence(p === 'online' || p === 'busy' ? p : 'offline');
        await loadCalls();
      }
      if (live) setPhase('ready');
    })();
    return () => { live = false; };
  }, [loadCalls]);

  const isLive = host?.status === 'live';
  const online = presence === 'online' || presence === 'busy';

  // heartbeat while this tab is visible and the host is online; recent calls refresh on the same rhythm
  useEffect(() => {
    if (phase !== 'ready' || !isLive) return;
    const beat = () => { if (document.visibilityState === 'visible' && presenceRef.current !== 'offline') void hfCall('POST', '/api/hosts/me/presence/beat'); };
    const refresh = () => { if (document.visibilityState === 'visible') void loadCalls(); };
    const b = setInterval(beat, BEAT_MS);
    const r = setInterval(refresh, REFRESH_MS);
    const vis = () => { if (document.visibilityState === 'visible') { beat(); refresh(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(b); clearInterval(r); document.removeEventListener('visibilitychange', vis); };
  }, [phase, isLive, loadCalls]);

  const toggle = async () => {
    setBusy(true); setMsg('');
    const goOnline = !online;
    const r = await hfCall<{ ok: boolean; presence: string }>('PUT', '/api/hosts/me/presence', { online: goOnline });
    setBusy(false);
    if (r.ok) { const p = r.data.presence; setPresence(p === 'online' || p === 'busy' ? p : 'offline'); return; }
    setMsg(r.status === 401 ? 'Please sign in again.' : r.message || 'We could not change that. Please try again.');
  };

  if (phase === 'boot') return <main className="hfc-page"><p role="status">Loading your dashboard…</p></main>;
  if (phase === 'signedout') {
    return <main className="hfc-page"><h1>Host dashboard</h1><p>Please sign in to see your calls.</p><a className="hfc-btn hfc-primary" href={signInUrl('/hosts/dashboard')}>Sign in</a></main>;
  }
  if (phase === 'error') {
    return <main className="hfc-page"><h1>Host dashboard</h1><p>We could not load your dashboard. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></main>;
  }

  if (!host || !isLive) {
    return (
      <main className="hfc-page">
        <SessionBridge on />
        <h1>Host dashboard</h1>
        <div className="hfc-card">
          <h2>{host ? 'You’re not live yet' : 'You’re not a host yet'}</h2>
          <p>{host ? (STATUS_NOTE[host.status] ?? 'Your profile is not live yet.') : 'Set up your host profile to start taking calls.'}</p>
          <a className="hfc-btn hfc-primary" href="/hosts/onboarding">{host ? 'Continue my profile' : 'Become a host'}</a>
        </div>
      </main>
    );
  }

  return (
    <main className="hfc-page">
      <SessionBridge on />
      <h1>Hi {(host.displayName || '').split(/\s+/)[0] || 'there'}</h1>
      <section className="hfc-card hfc-switch-wrap" aria-labelledby="hfc-state">
        <button type="button" role="switch" aria-checked={online} aria-labelledby="hfc-state" className="hfc-switch" onClick={toggle} disabled={busy || !on} />
        <p className="hfc-state" id="hfc-state">{!on ? 'Calls open soon' : online ? 'You’re online' : 'You’re offline'}</p>
        <p className="hfc-sub" style={{ margin: 0, color: '#785979' }}>
          {!on ? 'Calling isn’t switched on yet. We’ll tell you on WhatsApp when it is.'
            : online ? (presence === 'busy' ? 'You’re on a call right now.' : 'Callers can call you now. Keep this page open, or switch off when you’re done.')
              : 'Switch on when you’re ready to take calls. People who asked to be told will get a WhatsApp.'}
        </p>
        {msg && <p className="hfc-err" role="alert">{msg}</p>}
      </section>

      {bookingOn && <section className="hfc-card hfb-card" aria-labelledby="hfb-on-hold">
        <div className="hfb-section-head"><h2 id="hfb-on-hold">Expected earnings on hold</h2><a className="hfb-button hfb-small" href="/hosts/bookings">View bookings</a></div>
        {bookingSummary ? <>
          <div className="hfc-stats"><div className="hfc-stat"><strong>{money(bookingSummary.expectedHostNetPaise)}</strong><span>estimated host earnings</span></div><div className="hfc-stat"><strong>{bookingSummary.upcomingCount}</strong><span>upcoming bookings</span></div></div>
          {bookingSummary.nextBooking ? <p className="hfb-muted">Next: {dateLabel(bookingSummary.nextBooking.startUtc, bookingSummary.nextBooking.hostTimezone)} · {bookingSummary.nextBooking.hostTimezone}</p> : <p className="hfb-muted">No upcoming bookings yet.</p>}
        </> : bookingErrorText ? <p role="status" className="hfb-muted">{bookingErrorText} <button className="hfb-text-button" type="button" onClick={() => void loadCalls()}>Retry</button></p> : <p role="status">Loading booking summary…</p>}
        <p className="hfb-muted">This estimate is separate from earned wallet money. Completed calls move actual earnings to your wallet; withdrawal timing is shown there.</p>
        <div className="hfb-actions"><a className="hfb-button" href="/hosts/availability">Manage availability</a><a className="hfb-button" href="/hosts/bookings">All bookings</a></div>
      </section>}

      <section className="hfc-card" aria-labelledby="hfc-today">
        <h2 id="hfc-today">Today</h2>
        <div className="hfc-stats">
          <div className="hfc-stat"><strong>{today.calls}</strong><span>calls</span></div>
          <div className="hfc-stat"><strong>{today.minutes}</strong><span>minutes</span></div>
          <div className="hfc-stat"><strong>{formatPaise(Math.round(today.earned * 100))}</strong><span>earned today</span></div>
        </div>
      </section>

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

      <WithdrawPanel onChanged={() => void loadCalls()} />

      <section className="hfc-card" aria-labelledby="hfc-recent">
        <h2 id="hfc-recent">Recent calls</h2>
        {rows.length === 0 ? <p>No calls yet. They’ll show up here.</p> : (
          <ul className="hfc-calls">
            {rows.map(r => (
              <li key={r.id}><strong>{r.handle}</strong><span>{rowText(r)}</span>{r.at && <small>{relDate(r.at)}</small>}</li>
            ))}
          </ul>
        )}
        <p className="hfc-sub" style={{ margin: 0, color: '#785979', fontSize: '.875rem' }}>You only see a caller’s handle, never their number. Calls are not recorded.</p>
      </section>
    </main>
  );
}
