import '../../styles/hf-dashboard.css';
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
  events: 'The previous events screen has been retired. Your current host appointments are in My appointments.',
  consultations: 'The previous consultations screen has been retired. Your current host appointments are in My appointments.',
};
export function DashboardIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z', profile: 'M20 21v-2a8 8 0 0 0-16 0v2ZM16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    wallet: 'M3 7V4h15v3M3 7h18v14H3ZM16 12h5v5h-5Z', calls: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4c0 5-18-2-18-12Z',
    calendar: 'M4 5h16v16H4ZM4 10h16M8 2v6M16 2v6', search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    clock: 'M12 7v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', help: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    close: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', out: 'M9 3H3v18h6M8 12h13m-5-5 5 5-5 5',
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.profile} /></svg>;
}
export default function DashboardNav({ account, bookingOn, active }: { account: DashboardAccount; bookingOn: boolean; active: 'overview' | 'profile' }) {
  const hostReady = account.host?.status === 'live' && !account.closing;
  const links = [
    { href: '/dashboard', label: 'Overview', icon: 'home', key: 'overview' },
    { href: '/dashboard/profile', label: 'Profile', icon: 'profile', key: 'profile' },
    { href: '/wallet', label: 'Wallet', icon: 'wallet' },
    { href: '/wallet#hfw-hist', label: 'Calls', icon: 'calls' },
    { href: '/bookings', label: 'My appointments', icon: 'calendar' },
    { href: '/marketplace', label: 'Explore hosts', icon: 'search', divider: true },
    { href: '/hosts/onboarding', label: account.host ? 'Host profile' : 'Become a host', icon: 'profile', disabled: account.closing, note: 'Account closing' },
    { href: '/hosts/bookings', label: 'Host calendar', icon: 'calendar', disabled: !hostReady || !bookingOn, note: !hostReady ? 'Host only' : 'Opens soon' },
    { href: '/hosts/availability', label: 'Availability', icon: 'clock', disabled: !hostReady || !bookingOn, note: !hostReady ? 'Host only' : 'Opens soon' },
    { href: '/help', label: 'Help Center', icon: 'help', divider: true },
    { href: '/account/close', label: 'Close my account', icon: 'close' },
    { href: '/sign-out', label: 'Sign out', icon: 'out' },
  ];
  return <nav className="hfd-nav" aria-label="Dashboard menu"><div className="hfd-brand"><strong>{BRAND.name}<span aria-hidden="true"> ♥</span></strong><small>Real People. Kinder Days.</small></div><div className="hfd-menu-links">{links.map(item => item.disabled
    ? <span key={item.href} className="hfd-menu-item hfd-disabled" aria-disabled="true"><DashboardIcon name={item.icon} /><span>{item.label}<small>{item.note}</small></span></span>
    : <a key={item.href} className={`hfd-menu-item${item.divider ? ' hfd-divider' : ''}`} href={item.href} aria-current={item.key === active ? 'page' : undefined}><DashboardIcon name={item.icon} /><span>{item.label}</span></a>)}</div></nav>;
}
