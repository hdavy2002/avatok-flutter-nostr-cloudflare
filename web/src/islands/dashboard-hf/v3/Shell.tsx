/* [HF-DASH-V3-1] Dashboard shell: full sidebar (wide), icon rail with tooltips (medium), top bar + slide-in drawer + bottom tabs (phones).
 * Menu items are real links under /dashboard, so DashboardApp's click router switches screens in place. "Explore influencers" is not in
 * the menu (owner decision 2026-10-16); the public /marketplace stays reachable from the "Find someone to talk to" buttons. */
import { useState, type ReactNode } from 'react';
import { BRAND } from '../../../lib/brand';
import { formatPaise } from '../../../lib/money';
import { capture } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import type { DashSection } from '../../../lib/dashboardRoutes';
import { useDash, spendablePaise } from './data';
import { Avatar, Dialog, Ic, Marigold, Mogra, Sticker, istDay, istTime } from './ui';

interface Item { key: DashSection | 'signout'; href: string; label: string; icon: string; badge?: number | null; badgeTone?: 'gold' | ''; disabled?: string }

export default function Shell({ account, active, bookingOn, favouritesOn, merchOn = false, children }: { account: DashboardAccount; active: DashSection; bookingOn: boolean; favouritesOn: boolean; merchOn?: boolean; children: ReactNode }) {
  const { insights, summary, wallet, favs, profile } = useDash();
  const [drawer, setDrawer] = useState(false);
  const [bye, setBye] = useState(false);
  const [bell, setBell] = useState(false);
  const hostReady = account.host?.status === 'live' && !account.closing;
  const toRate = insights.data?.pendingReviews.length ?? null;
  const apptsToday = summary.data?.appointmentsToday ?? null;
  const online = favs.data ? favs.data.filter(f => f.presence === 'online').length : null;
  const bal = spendablePaise(wallet.data);
  const firstName = profile.data?.firstName || account.displayName || '';
  const handle = profile.data?.username;

  const groups: { title: string; items: Item[] }[] = [
    { title: 'Mera space', items: [
      { key: 'overview', href: '/dashboard', label: 'Overview', icon: 'home' },
      { key: 'profile', href: '/dashboard/profile', label: 'Profile', icon: 'user' },
      { key: 'wallet', href: '/dashboard/wallet', label: 'Wallet', icon: 'wallet' },
      { key: 'calls', href: '/dashboard/calls', label: 'Calls', icon: 'phone', badge: toRate, badgeTone: 'gold' },
      { key: 'appointments', href: '/dashboard/appointments', label: 'My appointments', icon: 'cal', badge: apptsToday, disabled: bookingOn ? undefined : 'Opens soon' },
      ...(merchOn ? [{ key: 'orders' as const, href: '/dashboard/orders', label: 'My orders', icon: 'bag' }] : []), // [HF-MERCH-FAN-WEB-1]
      ...(favouritesOn ? [{ key: 'fraands' as const, href: '/dashboard/fraands', label: 'My Fraands', icon: 'heart', badge: online }] : []),
    ] },
    { title: 'Influencer', items: account.host ? [
      { key: 'host', href: '/dashboard/host', label: 'Influencer profile', icon: 'star' },
      { key: 'host-calendar', href: '/dashboard/host/calendar', label: 'Influencer calendar', icon: 'cal', disabled: !hostReady ? 'When your profile is live' : bookingOn ? undefined : 'Opens soon' },
      { key: 'availability', href: '/dashboard/host/availability', label: 'Availability', icon: 'clock', disabled: !hostReady ? 'When your profile is live' : bookingOn ? undefined : 'Opens soon' },
      { key: 'earnings', href: '/dashboard/host/earnings', label: 'Earnings', icon: 'money', disabled: !hostReady ? 'When your profile is live' : undefined },
      ...(merchOn && hostReady ? [{ key: 'merch' as const, href: '/dashboard/merch', label: 'Merch', icon: 'shirt' }] : []), // [HF-MERCH-CREATOR-WEB-1]
    ] : [{ key: 'become', href: '/dashboard/become', label: 'Become an influencer', icon: 'star', disabled: account.closing ? 'Account closing' : undefined }] },
    { title: 'Account', items: [
      { key: 'support', href: '/dashboard/support', label: 'Support', icon: 'help' },
      { key: 'close', href: '/dashboard/close', label: 'Close my account', icon: 'trash' },
      { key: 'signout', href: '/sign-out', label: 'Sign out', icon: 'out' },
    ] },
  ];

  const nav = (where: 'side' | 'drawer') => <nav className="h3-nav" aria-label={where === 'side' ? 'Dashboard menu' : 'Dashboard menu (phone)'}>
    <a className="brand" href="/" aria-label={`${BRAND.name} home`}><Ic name="heart" className="" size={26} /><span>{BRAND.name}</span></a>
    <div className="tag">Real people. Kinder days.</div>
    <a className="h3-me" href="/dashboard/profile">
      <Avatar name={firstName} seed={handle || account.uid} />
      <span className="who"><b>{firstName || 'Your profile'}</b>{handle && <small className="muted small">@{handle}</small>}</span>
      <span className="bal">{bal == null ? '—' : formatPaise(bal)}</span>
    </a>
    {groups.map(g => <div key={g.title} style={{ display: 'contents' }}>
      <div className="h3-group"><Marigold size={14} tone={1} />{g.title}</div>
      {g.items.map(it => {
        const on = it.key === active;
        const badge = it.badge ? <span className={`bdg ${it.badgeTone ?? ''}`}>{it.badge}</span> : null;
        if (it.disabled) return <span key={it.key} className="h3-item is-off" aria-label={`${it.label} · ${it.disabled}`} aria-disabled="true"><Ic name={it.icon} /><span className="lbl">{it.label}<small>{it.disabled}</small></span></span>;
        if (it.key === 'signout') return <button key={it.key} type="button" className="h3-item" aria-label={it.label} onClick={() => { setDrawer(false); setBye(true); }}><Ic name={it.icon} /><span className="lbl">{it.label}</span></button>;
        return <a key={it.key} href={it.href} className={`h3-item${on ? ' on' : ''}${it.key === 'close' ? ' danger' : ''}`} aria-label={it.label} aria-current={on ? 'page' : undefined} onClick={() => setDrawer(false)}>
          <Ic name={it.icon} /><span className="lbl">{it.label}</span>{badge}{it.badge ? <i className="pip" /> : null}{on && <span className="flw"><Marigold size={22} tone={1} /></span>}
        </a>;
      })}
    </div>)}
    {!account.host && !account.closing && <div className="h3-sidecard">
      <b style={{ fontFamily: 'var(--head)', fontSize: 16 }}>Got followers?</b><br />
      <span>Apni baatein, apni kamaai. Verify once and take paid calls.</span><br />
      <a className="h3-btn sm gold" style={{ marginTop: 10 }} href="/dashboard/become">Shuru karo →</a>
      <Sticker name="girlboss" w={70} rot={8} />
    </div>}
    <Mogra n={9} />
    <div className="small muted" style={{ textAlign: 'center', padding: '0 8px' }}>Feeling low? Tele-MANAS <b>14416</b> · free, 24×7</div>
  </nav>;

  const bottom: [DashSection, string, string, string][] = [['overview', '/dashboard', 'Home', 'home'], ['fraands', '/dashboard/fraands', 'Fraands', 'heart'], ['calls', '/dashboard/calls', 'Calls', 'phone'], ['appointments', '/dashboard/appointments', 'Bookings', 'cal'], ['wallet', '/dashboard/wallet', 'Wallet', 'wallet']];
  const pendingOne = insights.data?.pendingReviews[0];
  const nextOnline = favs.data?.find(f => f.presence === 'online');

  return <div className="hf3">
    <div className="h3-shell">
      <aside className="h3-side">{nav('side')}</aside>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="h3-top">
          <button type="button" className="h3-iconbtn" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}><Ic name="menu" className="" /></button>
          <a className="brand" href="/dashboard"><Marigold size={24} tone={1} />{BRAND.name}</a>
          <a className="h3-btn sm ghost" href="/dashboard/wallet">{bal == null ? '—' : formatPaise(bal)}</a>
          <button type="button" className="h3-iconbtn" aria-label="Notifications" onClick={() => { setBell(true); capture('hf_dash3_bell_open', {}); }}><Ic name="bell" className="" />{(toRate || nextOnline) ? <i className="dot" /> : null}</button>
        </div>
        <main className="h3-main" id="hf3-main">{children}</main>
        <nav className="h3-bottom" aria-label="Quick menu">{bottom.filter(b => b[0] !== 'fraands' || favouritesOn).map(([k, href, l, i]) => <a key={k} href={href} className={active === k ? 'on' : ''}><Ic name={i} className="" />{l}</a>)}</nav>
      </div>
    </div>
    <div className={`h3-drawer${drawer ? ' open' : ''}`}><div className="scrim" onClick={() => setDrawer(false)} /><div className="panel">{drawer && nav('drawer')}</div></div>

    <Dialog open={bye} onClose={() => setBye(false)} label="Sign out">
      <div style={{ textAlign: 'center' }}><Sticker name="auto" w={140} wiggle /><h2 style={{ marginTop: 8 }}>Hum to chale?</h2>
        <p className="muted">You’ll need a WhatsApp code to sign in again.</p>
        <div className="acts"><a className="h3-btn" href="/sign-out" onClick={() => capture('hf_dash3_signout', {})}>Haan, sign out</a><button type="button" className="h3-btn ghost" onClick={() => setBye(false)}>Nahi, rukta hoon</button></div></div>
    </Dialog>
    <Dialog open={bell} onClose={() => setBell(false)} label="Notifications">
      <h2>Notifications</h2>
      {!nextOnline && !pendingOne && !summary.data?.appointmentsToday && <p className="muted">Sab shaant hai. Nothing new right now.</p>}
      {nextOnline && <div className="h3-rcpt" style={{ alignItems: 'flex-start' }}><Marigold size={26} /><div style={{ flex: 1 }}><b>{nextOnline.displayName} is online</b><div className="small muted">One of your fraands is free to talk right now.</div></div><a className="h3-btn sm rani" href={`/h/${nextOnline.slug}`}>Call</a></div>}
      {!!summary.data?.appointmentsToday && <div className="h3-rcpt" style={{ alignItems: 'flex-start' }}><Ic name="cal" className="" size={24} /><div style={{ flex: 1 }}><b>{summary.data.appointmentsToday} appointment{summary.data.appointmentsToday === 1 ? '' : 's'} today</b><div className="small muted">Open it a few minutes early.</div></div><a className="h3-btn sm ghost" href="/dashboard/appointments">Open</a></div>}
      {pendingOne && <div className="h3-rcpt" style={{ alignItems: 'flex-start' }}><Ic name="star" className="" size={24} /><div style={{ flex: 1 }}><b>Rate your call with {pendingOne.hostName}</b><div className="small muted">{istDay(pendingOne.at)}, {istTime(pendingOne.at)} · two taps, it really helps them.</div></div><a className="h3-btn sm gold" href="/dashboard/calls?tab=rate">Rate</a></div>}
    </Dialog>
  </div>;
}
