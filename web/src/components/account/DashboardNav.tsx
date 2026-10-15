import { Fragment, useState } from 'react';
import '../../styles/hf-dashboard.css';
import { DASH_ROUTES, type DashSection } from '../../lib/dashboardRoutes';
import { BRAND } from '../../lib/brand';

export interface DashboardAccount {
  uid: string;
  displayName: string | null;
  closing: boolean;
  host: { status: string; slug: string | null } | null;
}
export const retiredDashboardNotices: Record<string, string> = {
  billing: 'The previous billing screen has been retired. Previous receipts have not been moved into this wallet.',
  orders: 'The previous shop orders screen has been retired. Shop orders are not listed in this account.',
  wishlist: 'The previous shop wishlist has been retired.',
  events: 'The previous events screen has been retired. Your current influencer appointments are in My appointments.',
  consultations: 'The previous consultations screen has been retired. Your current influencer appointments are in My appointments.',
};
export function DashboardIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z', profile: 'M20 21v-2a8 8 0 0 0-16 0v2ZM16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    wallet: 'M3 7V4h15v3M3 7h18v14H3ZM16 12h5v5h-5Z', calls: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4c0 5-18-2-18-12Z',
    calendar: 'M4 5h16v16H4ZM4 10h16M8 2v6M16 2v6', search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    clock: 'M12 7v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', help: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    close: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', out: 'M9 3H3v18h6M8 12h13m-5-5 5 5-5 5',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z', money: 'M3 6h18v12H3ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01',
    heart: 'M12 20s-8-4.6-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.4-8 10-8 10Z',
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.profile} /></svg>;
}
export interface NavState { account: DashboardAccount; bookingOn: boolean; favouritesOn?: boolean; active: DashSection }

/** [HF-DASH-SHELL-2] Sidebar built from DASH_ROUTES. Hosts see a host group; everyone else sees "Become a host".
 * Links are real URLs (deep links and new tabs work); the dashboard router turns a plain click into an in-place switch. */
export default function DashboardNav({ account, bookingOn, favouritesOn = false, active }: NavState) {
  const hostReady = account.host?.status === 'live' && !account.closing;
  const [open, setOpen] = useState(false);
  const route = (s: DashSection) => DASH_ROUTES.find(r => r.section === s)!;
  type Item = { href: string; label: string; icon: string; key?: DashSection; divider?: boolean; disabled?: boolean; note?: string; heading?: string };
  const me: Item[] = DASH_ROUTES.filter(r => r.group === 'me' && !(r.needsFavourites && !favouritesOn)).map(r => ({
    href: r.path, label: r.label, icon: r.icon, key: r.section,
    disabled: !!r.needsBookings && !bookingOn, note: 'Opens soon',
  }));
  const host: Item[] = account.host
    ? DASH_ROUTES.filter(r => r.group === 'host').map((r, i) => ({
      href: r.path, label: r.label, icon: r.icon, key: r.section, divider: i === 0, heading: i === 0 ? 'Hosting' : undefined,
      disabled: (r.hostOnly && !hostReady) || (!!r.needsBookings && !bookingOn), note: r.hostOnly && !hostReady ? 'When your profile is live' : 'Opens soon',
    }))
    : [{ href: '/hosts/onboarding', label: 'Become an influencer', icon: 'star', divider: true, disabled: account.closing, note: 'Account closing' }];
  const items: Item[] = [
    ...me,
    { href: '/marketplace', label: 'Explore influencers', icon: 'search', divider: true },
    ...host,
    { ...{ href: route('support').path, label: route('support').label, icon: route('support').icon, key: 'support' as DashSection }, divider: true },
    { href: route('close').path, label: route('close').label, icon: route('close').icon, key: 'close' },
    { href: '/sign-out', label: 'Sign out', icon: 'out' },
  ];
  const current = DASH_ROUTES.find(r => r.section === active);
  return <nav className={`hfd-nav${open ? ' hfd-nav-open' : ''}`} aria-label="Dashboard menu">
    <div className="hfd-brand"><strong>{BRAND.name}<span aria-hidden="true"> ♥</span></strong><small>Real People. Kinder Days.</small></div>
    <button type="button" className="hfd-menu-toggle" aria-expanded={open} aria-controls="hfd-menu-links" onClick={() => setOpen(v => !v)}>
      <DashboardIcon name={current?.icon ?? 'home'} /><span>{current?.label ?? 'Menu'}</span><span className="hfd-menu-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    <div className="hfd-menu-links" id="hfd-menu-links" onClick={e => { if ((e.target as HTMLElement).closest('a')) setOpen(false); }}>{items.map(item => <Fragment key={item.href}>
      {item.heading && <p className="hfd-menu-heading">{item.heading}</p>}
      {item.disabled
        ? <span className={`hfd-menu-item hfd-disabled${item.divider && !item.heading ? ' hfd-divider' : ''}`} aria-disabled="true"><DashboardIcon name={item.icon} /><span>{item.label}<small>{item.note}</small></span></span>
        : <a className={`hfd-menu-item${item.divider && !item.heading ? ' hfd-divider' : ''}`} href={item.href} aria-current={item.key === active ? 'page' : undefined}><DashboardIcon name={item.icon} /><span>{item.label}</span></a>}
    </Fragment>)}</div>
  </nav>;
}
