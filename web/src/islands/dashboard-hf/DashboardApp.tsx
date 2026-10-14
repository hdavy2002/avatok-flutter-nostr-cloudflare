/* [HF-DASH-SHELL-2] The signed-in dashboard: one shell (sidebar + content) for every account screen.
 * Each screen has a real URL under /dashboard (see lib/dashboardRoutes.ts) and its own Astro page that mounts this
 * island with that section, so deep links, reloads and new tabs work. A plain click on any /dashboard link inside the
 * shell switches the screen in place (history.pushState), so the sidebar never disappears.
 * Identity: GET /api/hf/me once, shared by every screen; reloaded on site:active-session-changed. */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import SessionBridge from '../calls/SessionBridge';
import DashboardNav, { type DashboardAccount } from '../../components/account/DashboardNav';
import { DashboardEmbed } from '../../components/account/dashboardEmbed';
import { hfCall, signInUrl } from '../../lib/hfCallsApi';
import { bookingsEnabled } from '../../lib/hfBookingsApi';
import { capture, captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { DASH_ROUTES, dashRouteFor, type DashSection } from '../../lib/dashboardRoutes';
import Overview from './sections/Overview';
import Calls from './sections/Calls';
import Earnings from './sections/Earnings';
import HostProfile from './sections/HostProfile';
import Support from './sections/Support';
import HfAccount from '../account/HfAccount';
import HfWallet from '../wallet/HfWallet';
import HostBookings from '../host-bookings/HostBookings';
import HostAvailability from '../host-bookings/HostAvailability';
import AccountClose from '../wallet/AccountClose';
import '../../styles/hf-calls.css';
import '../../styles/hf-bookings.css';
import '../../styles/hf-account.css';

type Phase = 'boot' | 'signedout' | 'error' | 'ready';

export default function DashboardApp({ section: initial }: { section: DashSection }) {
  return <><SessionBridge on /><Shell initial={initial} /></>;
}

function Shell({ initial }: { initial: DashSection }) {
  const [section, setSection] = useState<DashSection>(initial);
  const [nav, setNav] = useState(0); // bumps on every in-place navigation so a revisited screen reloads its data
  const [phase, setPhase] = useState<Phase>('boot');
  const [account, setAccount] = useState<DashboardAccount | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    let disposed = false;
    async function load() {
      const run = ++generation.current;
      const current = () => !disposed && run === generation.current;
      setPhase('boot'); setAccount(null);
      try {
        const me = await hfCall<DashboardAccount>('GET', '/api/hf/me');
        if (!current()) return;
        if (!me.ok) { setPhase(me.status === 401 ? 'signedout' : 'error'); return; }
        const enabled = await bookingsEnabled();
        if (!current()) return;
        setAccount(me.data); setBookingOn(enabled); setPhase('ready');
      } catch (e) {
        captureException(e, { area: 'hf_dashboard', step: 'identity' });
        if (current()) setPhase('error');
      }
    }
    void load();
    const changed = () => { void load(); };
    window.addEventListener('site:active-session-changed', changed);
    return () => { disposed = true; ++generation.current; window.removeEventListener('site:active-session-changed', changed); };
  }, [retry]);

  // Back/forward between dashboard screens.
  useEffect(() => {
    const pop = () => { const r = dashRouteFor(location.pathname); if (r) { setSection(r.section); setNav(n => n + 1); } else location.reload(); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const route = DASH_ROUTES.find(r => r.section === section)!;
  const role = account?.host?.status === 'live' ? 'host' : 'customer';
  useEffect(() => {
    document.title = `${route.title} | ${BRAND.name}`;
    if (phase === 'ready') capture('hf_dash_view', { section, role });
  }, [section, phase, role, route.title]);

  const go = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const next = dashRouteFor(url.pathname);
    if (!next) return;
    e.preventDefault();
    capture('hf_dash_nav', { from: section, to: next.section });
    if (url.pathname + url.search + url.hash !== location.pathname + location.search + location.hash) history.pushState({}, '', url.pathname + url.search + url.hash);
    setSection(next.section); setNav(n => n + 1);
    window.scrollTo({ top: 0 });
  }, [section]);

  if (phase === 'boot') return <main className="hfc-page"><p role="status">Loading your dashboard…</p></main>;
  if (phase === 'signedout') return <main className="hfc-page"><h1>Dashboard</h1><p>Please sign in to see your dashboard.</p><a className="hfc-btn hfc-primary" href={signInUrl(location.pathname + location.search)}>Sign in</a></main>;
  if (phase === 'error' || !account) return <main className="hfc-page"><h1>Dashboard</h1><p>We could not load your dashboard. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => setRetry(n => n + 1)}>Try again</button></main>;

  const hostReady = account.host?.status === 'live' && !account.closing;
  const blocked = (route.hostOnly && !hostReady) || (route.needsBookings && !bookingOn);
  const key = `${section}:${nav}:${account.uid}`;
  let body;
  if (blocked) {
    body = <div className="hfd-section"><header className="hfd-section-head"><h1>{route.title}</h1></header><section className="hfc-card"><p>{route.hostOnly && !hostReady ? 'This opens once your host profile is live.' : 'This opens soon. We’ll let you know on WhatsApp.'}</p><div className="hfd-actions"><a className="hfc-btn hfc-primary" href="/dashboard">Back to overview</a></div></section></div>;
  } else switch (section) {
    case 'overview': body = <Overview key={key} account={account} bookingOn={bookingOn} onAccountChanged={setAccount} />; break;
    case 'profile': body = <HfAccount key={key} />; break;
    case 'wallet': body = <HfWallet key={key} />; break;
    case 'calls': body = <Calls key={key} account={account} />; break;
    case 'appointments': body = <HostBookings key={key} role="customer" />; break;
    case 'host': body = <HostProfile key={key} account={account} />; break;
    case 'host-calendar': body = <HostBookings key={key} role="host" />; break;
    case 'availability': body = <HostAvailability key={key} />; break;
    case 'earnings': body = <Earnings key={key} account={account} />; break;
    case 'support': body = <Support key={key} />; break;
    case 'close': body = <AccountClose key={key} />; break;
  }
  return <main className="hfc-page hfd-page">
    <div className="hfd-layout" onClick={go}>
      <DashboardNav account={account} bookingOn={bookingOn} active={section} />
      <div className="hfd-content"><DashboardEmbed.Provider value={true}>{body}</DashboardEmbed.Provider></div>
    </div>
  </main>;
}
