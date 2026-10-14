import '../../styles/hf-dashboard.css';

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
export default function DashboardNav({ account, bookingOn, active }: { account: DashboardAccount; bookingOn: boolean; active: 'overview' | 'profile' }) {
  const hostReady = account.host?.status === 'live' && !account.closing;
  const links = [
    ['/dashboard', 'Overview', 'overview'], ['/dashboard/profile', 'Profile', 'profile'],
    ['/wallet', 'Wallet'], ['/wallet#hfw-hist', 'Calls'], ['/bookings', 'My appointments'],
    ['/marketplace', 'Explore hosts'],
    ...(!account.closing ? [['/hosts/onboarding', account.host ? (account.host.status === 'live' ? 'Host profile' : 'Continue profile') : 'Become a host']] : []),
    ...(hostReady && bookingOn ? [['/hosts/bookings', 'Host calendar'], ['/hosts/availability', 'Availability']] : []),
    ['/help', 'Help Center'], ['/account/close', 'Close my account'], ['/sign-out', 'Sign out'],
  ];
  return <nav className="hfd-nav" aria-label="Dashboard menu"><p className="hfd-menu-title">Your dashboard</p><div className="hfd-menu-links">{links.map(([href, label, key]) => <a key={href} href={href} aria-current={key === active ? 'page' : undefined}>{label}</a>)}</div></nav>;
}
