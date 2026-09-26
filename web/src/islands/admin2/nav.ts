// [ADMIN2-SHELL 2026-09-26] Admin 2 menu — single source for the sidebar, the
// icon rail, the phone tab bar and its "More" sheet. Keys are what
// Admin2.astro's `active` prop takes. Contract: Specs/SPEC-2026-09-26-ADMIN-2.md.
import {
  LayoutDashboard, CalendarDays, Ticket, IndianRupee, Undo2, Users, Tags, Globe, LogOut, type LucideIcon,
} from 'lucide-react';

export type AdminKey = 'overview' | 'events' | 'bookings' | 'payments' | 'refunds' | 'customers' | 'prices';

export interface AdminNavItem { key: AdminKey; label: string; short: string; href: string; icon: LucideIcon }

export const ADMIN_NAV: AdminNavItem[] = [
  { key: 'overview', label: 'Overview', short: 'Overview', href: '/admin', icon: LayoutDashboard },
  { key: 'events', label: 'Events', short: 'Events', href: '/admin/events', icon: CalendarDays },
  { key: 'bookings', label: 'Bookings', short: 'Bookings', href: '/admin/bookings', icon: Ticket },
  { key: 'payments', label: 'Payments', short: 'Payments', href: '/admin/payments', icon: IndianRupee },
  { key: 'refunds', label: 'Refunds', short: 'Refunds', href: '/admin/refunds', icon: Undo2 },
  { key: 'customers', label: 'Users', short: 'Users', href: '/admin/users', icon: Users }, // [ADMIN2-USERS] key stays 'customers'
  { key: 'prices', label: 'Prices', short: 'Prices', href: '/admin/prices', icon: Tags },
];

/** Phone tab bar: these five, then "More" (the rest + View site + Logout). */
export const ADMIN_PHONE_TABS: AdminKey[] = ['overview', 'events', 'bookings', 'payments', 'refunds'];

export const ADMIN_VIEW_SITE = { label: 'View site', href: '/', icon: Globe };
/** Logout goes through /sign-out (ends the Clerk session, lands on `/`). */
export const ADMIN_LOGOUT = { label: 'Logout', href: '/sign-out?from=admin2', icon: LogOut };
