/* [HF-DASH-SHELL-2] One route table for every signed-in account screen. The sidebar, the mobile menu and the
 * in-dashboard router all read this list, so a screen is added in exactly one place. Paths live under /dashboard. */
export type DashSection =
  | 'overview' | 'profile' | 'wallet' | 'calls' | 'appointments'
  | 'host' | 'host-calendar' | 'availability' | 'earnings'
  | 'support' | 'close';

export type DashGroup = 'me' | 'explore' | 'host' | 'account';

export interface DashRoute {
  section: DashSection;
  path: string;
  label: string;
  icon: string;
  group: DashGroup;
  /** Only shown to a host whose profile is live. */
  hostOnly?: boolean;
  /** Needs the appointments feature (hfBookingsEnabled). */
  needsBookings?: boolean;
  title: string;
}

export const DASH_ROUTES: DashRoute[] = [
  { section: 'overview', path: '/dashboard', label: 'Overview', icon: 'home', group: 'me', title: 'Dashboard' },
  { section: 'profile', path: '/dashboard/profile', label: 'Profile', icon: 'profile', group: 'me', title: 'Profile' },
  { section: 'wallet', path: '/dashboard/wallet', label: 'Wallet', icon: 'wallet', group: 'me', title: 'Wallet' },
  { section: 'calls', path: '/dashboard/calls', label: 'Calls', icon: 'calls', group: 'me', title: 'Calls' },
  { section: 'appointments', path: '/dashboard/appointments', label: 'My appointments', icon: 'calendar', group: 'me', needsBookings: true, title: 'My appointments' },
  { section: 'host', path: '/dashboard/host', label: 'Host profile', icon: 'star', group: 'host', title: 'Host profile' },
  { section: 'host-calendar', path: '/dashboard/host/calendar', label: 'Host calendar', icon: 'calendar', group: 'host', hostOnly: true, needsBookings: true, title: 'Host calendar' },
  { section: 'availability', path: '/dashboard/host/availability', label: 'Availability', icon: 'clock', group: 'host', hostOnly: true, needsBookings: true, title: 'Availability' },
  { section: 'earnings', path: '/dashboard/host/earnings', label: 'Earnings', icon: 'money', group: 'host', hostOnly: true, title: 'Earnings' },
  { section: 'support', path: '/dashboard/support', label: 'Support', icon: 'help', group: 'account', title: 'Support' },
  { section: 'close', path: '/dashboard/close', label: 'Close my account', icon: 'close', group: 'account', title: 'Close my account' },
];

const clean = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The route for a pathname, or null when the path is not a dashboard screen. */
export function dashRouteFor(pathname: string): DashRoute | null {
  const p = clean(pathname);
  return DASH_ROUTES.find(r => r.path === p) ?? null;
}

export function dashPath(section: DashSection): string {
  return DASH_ROUTES.find(r => r.section === section)?.path ?? '/dashboard';
}
