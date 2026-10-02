// [DASH2-FOUNDATION 2026-09-25] Dashboard 2 menu — single source for the
// sidebar, icon rail and phone tab bar. Keys are what Dashboard2.astro's
// `active` prop takes.
import { CalendarPlus, CalendarCheck, History, Package, Heart, Receipt, UserRound, LogOut, Wallet, type LucideIcon } from 'lucide-react';
import { usePreview } from '../../lib/preview';

export type DashKey = 'book' | 'my-events' | 'past' | 'orders' | 'wishlist' | 'billing' | 'wallet' | 'profile';

export interface DashNavItem { key: DashKey; label: string; short: string; href: string; icon: LucideIcon;
  /** Small gold pill after the label (the mockup's "New" on My orders). */
  badge?: string }

const ALL_NAV: DashNavItem[] = [
  { key: 'book', label: 'Book events', short: 'Book', href: '/marketplace', icon: CalendarPlus },
  { key: 'my-events', label: 'My events', short: 'My events', href: '/dashboard/my-events', icon: CalendarCheck },
  { key: 'past', label: 'Past events', short: 'Past', href: '/dashboard/past', icon: History },
  { key: 'orders', label: 'My orders', short: 'Orders', href: '/dashboard/orders', icon: Package, badge: 'New' },
  { key: 'wishlist', label: 'Wishlist', short: 'Wishlist', href: '/dashboard/wishlist', icon: Heart },
  { key: 'billing', label: 'Billing', short: 'Billing', href: '/dashboard/billing', icon: Receipt },
  { key: 'wallet', label: 'Wallet', short: 'Wallet', href: '/dashboard/wallet', icon: Wallet },
  { key: 'profile', label: 'Profile', short: 'Profile', href: '/dashboard/profile', icon: UserRound },
];

/** [AUMFE-WALLET-WEB-1] Wallet is admin-preview only until a payment gateway is approved:
 * it shows ONLY while usePreview().guides is true. Static consumers keep DASH_NAV (no wallet). */
export const DASH_NAV: DashNavItem[] = ALL_NAV.filter((i) => i.key !== 'wallet');

/** The menu for the signed-in person (hook). Everyone gets DASH_NAV; previewers also get Wallet after Billing. */
export function useDashNav(): DashNavItem[] {
  const { guides } = usePreview();
  return guides ? ALL_NAV : DASH_NAV;
}

/** Logout goes through /sign-out (ends the Clerk session, lands on `/`). */
export const DASH_LOGOUT = { label: 'Logout', href: '/sign-out?from=dash2', icon: LogOut };
