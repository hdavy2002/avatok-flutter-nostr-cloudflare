/* [HF-DASH-SHELL-2] The signed-in dashboard: one shell (sidebar + content) for every account screen.
 * Each screen has a real URL under /dashboard (see lib/dashboardRoutes.ts) and its own Astro page that mounts this
 * island with that section, so deep links, reloads and new tabs work. A plain click on any /dashboard link inside the
 * shell switches the screen in place (history.pushState), so the sidebar never disappears.
 * Identity: GET /api/hf/me once, shared by every screen; reloaded on site:active-session-changed. */
import { Component, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { isInfluencer, type DashboardAccount } from '../../components/account/DashboardNav';
import { DashboardEmbed } from '../../components/account/dashboardEmbed';
import { getMe, signInUrl } from '../../lib/hfCallsApi';
import { bookingsEnabled } from '../../lib/hfBookingsApi';
import { favouritesEnabled } from '../../lib/hfFavouritesApi';
import { merchEnabled } from '../../lib/merchApi'; // [HF-MERCH-FAN-WEB-1]
import { onSupportDesk, photoGateStatus, photoModerationEnabled, photosRequiredEnabled, redirectToPhotoOnboarding } from '../../lib/hfPhotosApi'; // [HF-MOD-WEB-PHOTOS] [HF-PHOTO-CROP-WEB]
import { capture, captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { DASH_ROUTES, dashRouteFor, type DashSection } from '../../lib/dashboardRoutes';
import Earnings from './sections/Earnings';
import HostProfile from './sections/HostProfile';
import HostBookings from '../host-bookings/HostBookings';
import HostAvailability from '../host-bookings/HostAvailability';
import '../../styles/hf-calls.css';
import '../../styles/hf-bookings.css';
import '../../styles/hf-account.css';
import '../../styles/hf-dashboard.css'; // host screens keep their existing look inside the new shell
import '../../styles/hf-dash3.css'; // [HF-DASH-V3-1]
import DashShell from './v3/Shell';
import { DashDataProvider } from './v3/data';
import { dropDashCaches, readBoot, writeBoot } from './v3/dashCache'; // [HF-DASH-CACHE-1]
import { ToastProvider } from './v3/ui';
import OverviewV3 from './v3/Overview';
import CallsV3 from './v3/Calls';
import WalletV3 from './v3/Wallet';
import ProfileV3 from './v3/Profile';
import AppointmentsV3 from './v3/Appointments';
import FraandsV3 from './v3/Fraands';
import BecomeV3 from './v3/Become';
import VerificationsV3 from './v3/Verifications'; // [HF-CREATOR-BADGES-1]
import SupportV3 from './v3/Support';
import CloseV3 from './v3/Close';
import PolicyUpdatePrompt from './PolicyUpdatePrompt'; // [HF-POLICY-WITHDRAW-1]
import MerchApp from './merch/MerchApp'; // [HF-MERCH-CREATOR-WEB-1]
import OrdersV3 from './v3/Orders'; // [HF-MERCH-FAN-WEB-1]
import MyPhotoV3 from './v3/MyPhoto'; // [HF-MOD-WEB-PHOTOS]
import { CallOptionCard, useCallOption } from './v3/CallOption'; // [HF-INTRO-B4]
import SafetyV3 from './v3/Safety'; // [HF-CALL-SAFETY-WEB]

type Phase = 'boot' | 'signedout' | 'error' | 'ready';

/** [HF-DASH-SHELL-2] One broken screen must never blank the whole dashboard: the sidebar stays and the screen offers a retry. */
class SectionBoundary extends Component<{ section: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { captureException(error, { area: 'hf_dashboard', section: this.props.section }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="hfc-card" role="alert"><h2>Something went wrong on this screen</h2><p>Please try again. The rest of your dashboard still works.</p><div className="hfd-actions"><button type="button" className="hfc-btn hfc-primary" onClick={() => this.setState({ failed: false })}>Try again</button></div></section>;
  }
}

export default function DashboardApp({ section: initial }: { section: DashSection }) {
  return <><SessionBridge on /><Shell initial={initial} /></>;
}

function Shell({ initial }: { initial: DashSection }) {
  const [section, setSection] = useState<DashSection>(initial);
  const [nav, setNav] = useState(0); // bumps on every in-place navigation so a revisited screen reloads its data
  const [phase, setPhase] = useState<Phase>('boot');
  const [account, setAccount] = useState<DashboardAccount | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [favouritesOn, setFavouritesOn] = useState(false);
  const [merchOn, setMerchOn] = useState(false);
  const [photoOn, setPhotoOn] = useState(false); // [HF-MOD-WEB-PHOTOS]
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);

  // [HF-DASH-CACHE-1] The account on screen, readable inside load() without re-subscribing.
  const accountRef = useRef<DashboardAccount | null>(null);

  useEffect(() => {
    let disposed = false;
    // [HF-DASH-CACHE-1] /api/config is one shared request now, so the five flag checks cost one round trip.
    const loadFlags = async () => {
      const [enabled, favs, merch, photos, photosRequired] = await Promise.all([bookingsEnabled(), favouritesEnabled(), merchEnabled(), photoModerationEnabled(), photosRequiredEnabled()]);
      return { enabled, favs, merch, photos, photosRequired };
    };
    // [HF-PHOTO-CROP-WEB] Mandatory photos: a signed-in member without a clear face photo and a cover goes to the onboarding page first.
    // Fails open (unknown status = let them in). Never runs on the support desk; my-photo, support and close stay reachable.
    // Returns true when the page is leaving for the onboarding page.
    const photoGate = async (me: DashboardAccount, photosRequired: boolean): Promise<boolean> => {
      if (!photosRequired || me.closing || onSupportDesk()) return false;
      const here = dashRouteFor(location.pathname)?.section;
      if (here === 'my-photo' || here === 'support' || here === 'close') return false;
      const st = await photoGateStatus(me.uid);
      return st.complete === false && redirectToPhotoOnboarding('dashboard');
    };
    async function load(useCache: boolean) {
      const run = ++generation.current;
      const current = () => !disposed && run === generation.current;
      // [HF-DASH-CACHE-1] Something is already on screen (or the last visit left a cache for this tab): show it now, refresh behind it.
      let shown = accountRef.current;
      if (!shown && useCache) {
        const c = readBoot<DashboardAccount>();
        if (c) {
          shown = c.me; accountRef.current = c.me;
          setAccount(c.me); setBookingOn(c.flags.bookingOn); setFavouritesOn(c.flags.favouritesOn); setMerchOn(c.flags.merchOn); setPhotoOn(c.flags.photoOn); setPhase('ready');
        }
      }
      if (!shown) { setPhase('boot'); setAccount(null); }
      try {
        // [HF-DASH-CACHE-1] /me (one shared request) and the flags no longer wait for each other.
        const [meR, f] = await Promise.all([getMe<DashboardAccount>({ fresh: true }), loadFlags()]);
        if (!current()) return;
        if (!meR.ok) {
          if (meR.status === 401) { dropDashCaches(); accountRef.current = null; setAccount(null); setPhase('signedout'); return; }
          if (!shown) setPhase('error'); // a failed refresh never takes away what the person is already looking at
          return;
        }
        const me = meR.data;
        if (shown && shown.uid !== me.uid) { dropDashCaches(); shown = null; } // the cache belonged to someone else
        if (!shown && await photoGate(me, f.photosRequired)) return;
        if (!current()) return;
        const flags = { bookingOn: f.enabled, favouritesOn: f.favs, merchOn: f.merch, photoOn: f.photos || f.photosRequired };
        // Skip the state writes when nothing changed, so a background refresh does not re-render the open screen.
        if (!shown || JSON.stringify(shown) !== JSON.stringify(me)) { accountRef.current = me; setAccount(me); }
        setBookingOn(flags.bookingOn); setFavouritesOn(flags.favouritesOn); setMerchOn(flags.merchOn); setPhotoOn(flags.photoOn); setPhase('ready');
        writeBoot(me, flags);
        if (shown) void photoGate(me, f.photosRequired); // cached view: the gate runs behind it and redirects if the photos are missing
      } catch (e) {
        captureException(e, { area: 'hf_dashboard', step: 'identity' });
        if (current() && !shown) setPhase('error');
      }
    }
    void load(true);
    const changed = () => { void load(false); };
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
  const role = isInfluencer(account) && account?.host?.status === 'live' ? 'host' : 'customer';
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

  // [HF-DASH-CACHE-1] No cache yet: draw the shape of the dashboard (not a bare line of text) while the first answer comes.
  if (phase === 'boot') return <div className="hfd-v3"><div className="hf3 h3-bootsk" role="status" aria-label="Loading your dashboard">
    <div className="h3-shell">
      <aside className="h3-side"><div className="h3-nav"><span className="sk" style={{ height: 44 }} /><span className="sk" style={{ height: 96, marginTop: 14 }} />{[0, 1, 2, 3, 4].map(i => <span key={i} className="sk" style={{ height: 36, marginTop: 10 }} />)}</div></aside>
      <main className="h3-main"><span className="sk" style={{ height: 56, maxWidth: 420 }} /><span className="sk card" /><span className="sk card" /><span className="sk card" /><span className="sk card" /></main>
    </div></div></div>;
  if (phase === 'signedout') return <main className="hfc-page"><h1>Dashboard</h1><p>Please sign in to see your dashboard.</p><a className="hfc-btn hfc-primary" href={signInUrl(location.pathname + location.search)}>Sign in</a></main>;
  if (phase === 'error' || !account) return <main className="hfc-page"><h1>Dashboard</h1><p>We could not load your dashboard. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => setRetry(n => n + 1)}>Try again</button></main>;

  const hostReady = isInfluencer(account) && account.host?.status === 'live' && !account.closing;
  // [HF-INFLUENCER-GATE-1] Influencer pages are for approved influencers only; everyone else goes back to the Overview.
  const hostArea = route.group === 'host' && route.section !== 'verifications' && route.section !== 'safety';
  const effSection: DashSection = hostArea && !isInfluencer(account) ? 'overview' : section; // non-influencers see the Overview instead
  const blocked = effSection === section && ((route.hostOnly && !hostReady) || (route.needsBookings && !bookingOn) || (route.needsFavourites && !favouritesOn) || (route.needsMerch && !merchOn) || (route.needsPhotos && !photoOn));
  const key = `${section}:${nav}:${account.uid}`;
  let body;
  if (blocked) {
    body = <div className="hfd-section"><header className="hfd-section-head"><h1>{route.title}</h1></header><section className="hfc-card"><p>{route.hostOnly && !hostReady ? 'This opens once your influencer profile is live.' : 'This opens soon. We’ll let you know on WhatsApp.'}</p><div className="hfd-actions"><a className="hfc-btn hfc-primary" href="/dashboard">Back to overview</a></div></section></div>;
  } else switch (effSection) {
    // [HF-DASH-V3-1] Customer screens are the new dashboard; influencer screens keep their existing components inside the new shell.
    case 'overview': body = <OverviewV3 key={key} account={account} bookingOn={bookingOn} />; break;
    case 'profile': body = <ProfileV3 key={key} account={account} />; break;
    case 'wallet': body = <WalletV3 key={key} />; break;
    case 'calls': body = <CallsV3 key={key} account={account} />; break;
    case 'appointments': body = <AppointmentsV3 key={key} enabled={bookingOn && !account.closing} uid={account.uid} />; break;
    case 'orders': body = <OrdersV3 key={key} />; break;
    case 'my-photo': body = <MyPhotoV3 key={key} account={account} />; break;
    case 'fraands': body = <FraandsV3 key={key} />; break;
    case 'become': body = <BecomeV3 key={key} account={account} />; break;
    case 'verifications': body = <VerificationsV3 key={key} account={account} />; break;
    case 'host': body = <div className="h3-legacy"><HostProfile key={key} account={account} /></div>; break;
    case 'host-calendar': body = <div className="h3-legacy"><HostBookings key={key} role="host" /></div>; break;
    case 'availability': body = <><AvailabilityCallOption /><div className="h3-legacy"><HostAvailability key={key} /></div></>; break;
    case 'earnings': body = <div className="h3-legacy"><Earnings key={key} account={account} /></div>; break;
    case 'safety': body = <SafetyV3 key={key} account={account} />; break;
    case 'merch': body = <MerchApp key={key} />; break;
    case 'support': body = <SupportV3 key={key} />; break;
    case 'close': body = <CloseV3 key={key} />; break;
  }
  return <div className="hfd-v3" onClick={go}>
    <DashDataProvider key={account.uid} uid={account.uid} favouritesOn={favouritesOn} nav={nav}>
      <ToastProvider>
        <PolicyUpdatePrompt uid={account.uid} />
        <DashShell account={account} active={section} bookingOn={bookingOn} favouritesOn={favouritesOn} merchOn={merchOn} photoOn={photoOn}>
          <DashboardEmbed.Provider value={true}><SectionBoundary key={key} section={section}>{body}</SectionBoundary></DashboardEmbed.Provider>
        </DashShell>
      </ToastProvider>
    </DashDataProvider>
  </div>;
}

/** [HF-INTRO-B4] The call option also lives above the availability editor; renders nothing while hfCallOptionEnabled is off. */
function AvailabilityCallOption() {
  const co = useCallOption();
  return co.enabled ? <div style={{ marginBottom: 16 }}><CallOptionCard st={co} /></div> : null;
}
