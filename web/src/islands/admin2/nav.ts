// [ADMIN2-SHELL 2026-09-26] Admin 2 menu — single source for the sidebar, the
// icon rail, the phone tab bar and its "More" sheet. Keys are what
// Admin2.astro's `active` prop takes. Contract: Specs/SPEC-2026-09-26-ADMIN-2.md.
import {
  ChartColumn, CalendarDays, Ticket, IndianRupee, ShieldCheck, Undo2, Users, Tags, Gift, QrCode, Globe, LogOut, Sparkles, MonitorPlay, ShoppingBag, Shirt, LayoutGrid, Megaphone, BadgePercent, Settings2, type LucideIcon,
} from 'lucide-react';

export type AdminKey = 'overview' | 'events' | 'bookings' | 'payments' | 'refunds' | 'customers' | 'prices' | 'chadhava' | 'upi' | 'verify' | 'ai' | 'freevideos'
  | 'shop-orders' | 'shop-products' | 'shop-collections' | 'shop-promote' | 'shop-coupons' | 'shop-settings';

export interface AdminNavItem { key: AdminKey; label: string; short: string; href: string; icon: LucideIcon; /** Optional group heading shown above the first item of a run (e.g. "Shop"). */ group?: string }

export const ADMIN_NAV: AdminNavItem[] = [
  { key: 'overview', label: 'Analytics', short: 'Analytics', href: '/admin', icon: ChartColumn }, // [ADMIN2-ANALYTICS] key stays 'overview'
  { key: 'events', label: 'Events', short: 'Events', href: '/admin/events', icon: CalendarDays },
  { key: 'freevideos', label: 'Free videos', short: 'Free', href: '/admin/free-videos', icon: MonitorPlay }, // [SAATHUM-FREEVIDEOS-ADMIN-1]
  { key: 'bookings', label: 'Bookings', short: 'Bookings', href: '/admin/bookings', icon: Ticket },
  { key: 'payments', label: 'Payments', short: 'Payments', href: '/admin/payments', icon: IndianRupee },
  { key: 'verify', label: 'Payment verification', short: 'Verify', href: '/admin/verify', icon: ShieldCheck }, // [SAATHUM-UPI3]
  { key: 'refunds', label: 'Refunds', short: 'Refunds', href: '/admin/refunds', icon: Undo2 },
  { key: 'customers', label: 'Users', short: 'Users', href: '/admin/users', icon: Users }, // [ADMIN2-USERS] key stays 'customers'
  { key: 'prices', label: 'Prices', short: 'Prices', href: '/admin/prices', icon: Tags },
  { key: 'chadhava', label: 'Chadhava', short: 'Chadhava', href: '/admin/chadhava', icon: Gift }, // [SAATHUM-CHADHAVA]
  { key: 'upi', label: 'UPI settings', short: 'UPI', href: '/admin/upi', icon: QrCode }, // [SAATHUM-UPI-SETTINGS]
  { key: 'ai', label: 'AI assistant', short: 'AI', href: '/admin/ai', icon: Sparkles }, // [SAATHUM-PREETI-1]
  // [SAATHUM-SHOP-ADMIN-1] Shop group (spec §5.5). Keep these contiguous: the heading renders above the first.
  { key: 'shop-orders', label: 'Orders', short: 'Orders', href: '/admin/shop', icon: ShoppingBag, group: 'Shop' },
  { key: 'shop-products', label: 'Products', short: 'Products', href: '/admin/shop/products', icon: Shirt, group: 'Shop' },
  { key: 'shop-collections', label: 'Categories', short: 'Categories', href: '/admin/shop/collections', icon: LayoutGrid, group: 'Shop' },
  { key: 'shop-promote', label: 'Promote to cards', short: 'Promote', href: '/admin/shop/promote', icon: Megaphone, group: 'Shop' },
  { key: 'shop-coupons', label: 'Coupons', short: 'Coupons', href: '/admin/shop/coupons', icon: BadgePercent, group: 'Shop' },
  { key: 'shop-settings', label: 'Shop settings', short: 'Shop settings', href: '/admin/shop/settings', icon: Settings2, group: 'Shop' },
];

/** Phone tab bar: these five, then "More" (the rest + View site + Logout). */
export const ADMIN_PHONE_TABS: AdminKey[] = ['overview', 'events', 'bookings', 'payments', 'refunds'];

export const ADMIN_VIEW_SITE = { label: 'View site', href: '/', icon: Globe };
/** Logout goes through /sign-out (ends the Clerk session, lands on `/`). */
export const ADMIN_LOGOUT = { label: 'Logout', href: '/sign-out?from=admin2', icon: LogOut };
