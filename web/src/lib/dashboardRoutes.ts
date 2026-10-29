/* [HF-DASH-SHELL-2] One route table for every signed-in account screen. The sidebar, the mobile menu and the
 * in-dashboard router all read this list, so a screen is added in exactly one place. Paths live under /dashboard. */
export type DashSection =
  | 'overview' | 'profile' | 'wallet' | 'calls' | 'appointments' | 'fraands'
  | 'orders' | 'host' | 'host-calendar' | 'availability' | 'earnings' | 'merch'
  | 'support' | 'close' | 'become' | 'my-photo' | 'verifications' | 'safety';

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
  /** Needs the saved-hosts feature (hfFavouritesEnabled). Hidden from the menu while it is off. */
  needsFavourites?: boolean;
  /** [HF-MERCH-CREATOR-WEB-1][HF-MERCH-FAN-WEB-1] Needs the merch shop (hfMerchEnabled). Hidden from the menu while it is off. */
  needsMerch?: boolean;
  /** [HF-MOD-WEB-PHOTOS] Needs the photo safety check (hfPhotoModerationEnabled). Hidden from the menu while it is off. */
  needsPhotos?: boolean;
  title: string;
}

export const DASH_ROUTES: DashRoute[] = [
  { section: 'overview', path: '/dashboard', label: 'Overview', icon: 'home', group: 'me', title: 'Dashboard' },
  { section: 'profile', path: '/dashboard/profile', label: 'Profile', icon: 'profile', group: 'me', title: 'Profile' },
  { section: 'wallet', path: '/dashboard/wallet', label: 'Wallet', icon: 'wallet', group: 'me', title: 'Wallet' },
  { section: 'calls', path: '/dashboard/calls', label: 'Calls', icon: 'calls', group: 'me', title: 'Calls' },
  { section: 'appointments', path: '/dashboard/appointments', label: 'My appointments', icon: 'calendar', group: 'me', needsBookings: true, title: 'My appointments' },
  { section: 'orders', path: '/dashboard/orders', label: 'My orders', icon: 'bag', group: 'me', needsMerch: true, title: 'My orders' },
  { section: 'my-photo', path: '/dashboard/my-photo', label: 'My photo & cover', icon: 'profile', group: 'me', needsPhotos: true, title: 'My photo & cover' },
  { section: 'fraands', path: '/dashboard/fraands', label: 'My Fraands', icon: 'heart', group: 'me', needsFavourites: true, title: 'My Fraands' },
  { section: 'host', path: '/dashboard/host', label: 'Influencer profile', icon: 'star', group: 'host', title: 'Influencer profile' },
  { section: 'host-calendar', path: '/dashboard/host/calendar', label: 'Influencer calendar', icon: 'calendar', group: 'host', hostOnly: true, needsBookings: true, title: 'Influencer calendar' },
  { section: 'availability', path: '/dashboard/host/availability', label: 'Availability', icon: 'clock', group: 'host', hostOnly: true, needsBookings: true, title: 'Availability' },
  { section: 'earnings', path: '/dashboard/host/earnings', label: 'Earnings', icon: 'money', group: 'host', hostOnly: true, title: 'Earnings' },
  { section: 'merch', path: '/dashboard/merch', label: 'Merch', icon: 'shirt', group: 'host', hostOnly: true, needsMerch: true, title: 'Merch' },
  // [HF-CREATOR-BADGES-1] Trust badges: phone, channel, video KYC, special space, who can call.
  { section: 'verifications', path: '/dashboard/verifications', label: 'My verifications', icon: 'shield', group: 'host', title: 'My verifications' },
  // [HF-CALL-SAFETY-WEB] Strikes, appeals, paused state and the call rules. Open to every signed-in account (a paused fan sees their status here too).
  { section: 'safety', path: '/dashboard/host/safety', label: 'Safety', icon: 'shield', group: 'host', title: 'Safety' },
  // [HF-DASH-V3-1] For people who are not influencers yet: perks, live onboarding progress and an earnings estimate.
  { section: 'become', path: '/dashboard/become', label: 'Become an influencer', icon: 'star', group: 'account', title: 'Become an influencer' },
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
