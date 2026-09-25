// [DASH2-FOUNDATION 2026-09-25] Dashboard 2 menu — single source for the
// sidebar, icon rail and phone tab bar. Keys are what Dashboard2.astro's
// `active` prop takes.
import { CalendarPlus, CalendarCheck, History, Receipt, UserRound, LogOut, type LucideIcon } from 'lucide-react';

export type DashKey = 'book' | 'my-events' | 'past' | 'billing' | 'profile';

export interface DashNavItem { key: DashKey; label: string; short: string; href: string; icon: LucideIcon }

export const DASH_NAV: DashNavItem[] = [
  { key: 'book', label: 'Book events', short: 'Book', href: '/dashboard', icon: CalendarPlus },
  { key: 'my-events', label: 'My events', short: 'My events', href: '/dashboard/my-events', icon: CalendarCheck },
  { key: 'past', label: 'Past events', short: 'Past', href: '/dashboard/past', icon: History },
  { key: 'billing', label: 'Billing', short: 'Billing', href: '/dashboard/billing', icon: Receipt },
  { key: 'profile', label: 'Profile', short: 'Profile', href: '/dashboard/profile', icon: UserRound },
];

/** Logout goes through /sign-out (ends the Clerk session, lands on `/`). */
export const DASH_LOGOUT = { label: 'Logout', href: '/sign-out?from=dash2', icon: LogOut };
