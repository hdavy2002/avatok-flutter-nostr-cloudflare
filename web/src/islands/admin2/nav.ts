// [ADMIN2-SHELL 2026-09-26] Admin 2 menu — single source for the sidebar, the
// icon rail, the phone tab bar and its "More" sheet. Keys are what
// Admin2.astro's `active` prop takes. Contract: Specs/SPEC-2026-09-26-ADMIN-2.md.
import {
  ChartColumn, CalendarDays, Ticket, IndianRupee, ShieldCheck, Undo2, Users, Tags, Gift, QrCode, Globe, LogOut, Sparkles, MonitorPlay, ShoppingBag, Shirt, LayoutGrid, Megaphone, BadgePercent, Settings2, LayoutTemplate, Palette, Printer, BookOpen, Wallet, AudioLines, Eye, Scale, GraduationCap, CalendarCheck, Star, type LucideIcon,
} from 'lucide-react';

export type AdminKey = 'overview' | 'events' | 'bookings' | 'payments' | 'refunds' | 'customers' | 'wallets' | 'prices' | 'chadhava' | 'upi' | 'verify' | 'ai' | 'knowledge' | 'voice-guides' | 'freevideos'
  | 'shop-orders' | 'shop-studio' | 'shop-partner' | 'shop-editor' | 'shop-products' | 'shop-collections' | 'shop-promote' | 'shop-coupons' | 'shop-settings'
  | 'consultants' | 'consultant-bookings' | 'consultant-reviews'
  | 'preview-help' | 'preview-legal';

export interface AdminNavItem { key: AdminKey; label: string; short: string; href: string; icon: LucideIcon; /** Optional group heading shown above the first item of a run (e.g. "Shop"). */ group?: string; /** [AUMFE-POD-FULFIL-1] Small gold pill after the label (e.g. "New"). */ pill?: string }

export const ADMIN_NAV: AdminNavItem[] = [
  { key: 'overview', label: 'Analytics', short: 'Analytics', href: '/admin', icon: ChartColumn }, // [ADMIN2-ANALYTICS] key stays 'overview'
  { key: 'events', label: 'Events', short: 'Events', href: '/admin/events', icon: CalendarDays },
  { key: 'freevideos', label: 'Free videos', short: 'Free', href: '/admin/free-videos', icon: MonitorPlay }, // [SAATHUM-FREEVIDEOS-ADMIN-1]
  { key: 'bookings', label: 'Bookings', short: 'Bookings', href: '/admin/bookings', icon: Ticket },
  { key: 'payments', label: 'Payments', short: 'Payments', href: '/admin/payments', icon: IndianRupee },
  { key: 'verify', label: 'Payment verification', short: 'Verify', href: '/admin/verify', icon: ShieldCheck }, // [SAATHUM-UPI3]
  { key: 'refunds', label: 'Refunds', short: 'Refunds', href: '/admin/refunds', icon: Undo2 },
  { key: 'customers', label: 'Users', short: 'Users', href: '/admin/users', icon: Users }, // [ADMIN2-USERS] key stays 'customers'
  { key: 'wallets', label: 'Wallets', short: 'Wallets', href: '/admin/wallets', icon: Wallet }, // [AUMFE-WALLET-ADMIN-1]
  { key: 'prices', label: 'Prices', short: 'Prices', href: '/admin/prices', icon: Tags },
  { key: 'chadhava', label: 'Chadhava', short: 'Chadhava', href: '/admin/chadhava', icon: Gift }, // [SAATHUM-CHADHAVA]
  { key: 'upi', label: 'UPI settings', short: 'UPI', href: '/admin/upi', icon: QrCode }, // [SAATHUM-UPI-SETTINGS]
  { key: 'ai', label: 'AI assistant', short: 'AI', href: '/admin/ai', icon: Sparkles }, // [SAATHUM-PREETI-1]
  { key: 'knowledge', label: 'Tradition library', short: 'Library', href: '/admin/knowledge', icon: BookOpen }, // [AUMFE-KNOWLEDGE-ADMIN-UI-1]
  { key: 'voice-guides', label: 'Voice guides', short: 'Voice', href: '/admin/voice-guides', icon: AudioLines }, // [AUMFE-VOICE-ADMIN-1]
  // [SAATHUM-SHOP-ADMIN-1] Shop group (spec §5.5). Keep these contiguous: the heading renders above the first.
  { key: 'shop-orders', label: 'Orders', short: 'Orders', href: '/admin/shop', icon: ShoppingBag, group: 'Shop' },
  { key: 'shop-studio', label: 'Studio', short: 'Studio', href: '/admin/shop/studio', icon: Palette, group: 'Shop', pill: 'New' }, // [AUMFE-POD-FULFIL-1] page built by AUMFE-POD-STUDIO-WEB-1
  { key: 'shop-editor', label: 'Edit shop page', short: 'Edit page', href: '/admin/shop/editor', icon: LayoutTemplate, group: 'Shop' }, // [SAATHUM-SHOP-EDITOR-1]
  { key: 'shop-products', label: 'Products', short: 'Products', href: '/admin/shop/products', icon: Shirt, group: 'Shop' },
  { key: 'shop-collections', label: 'Categories', short: 'Categories', href: '/admin/shop/collections', icon: LayoutGrid, group: 'Shop' },
  { key: 'shop-promote', label: 'Promote to cards', short: 'Promote', href: '/admin/shop/promote', icon: Megaphone, group: 'Shop' },
  { key: 'shop-coupons', label: 'Coupons', short: 'Coupons', href: '/admin/shop/coupons', icon: BadgePercent, group: 'Shop' },
  { key: 'shop-settings', label: 'Shop settings', short: 'Shop settings', href: '/admin/shop/settings', icon: Settings2, group: 'Shop' },
  { key: 'shop-partner', label: 'Print partner', short: 'Partner', href: '/admin/shop/partner', icon: Printer, group: 'Shop', pill: 'New' }, // [AUMFE-POD-FULFIL-1]
  // [AUMFE-CONSULT-F4-1] Consultants group (Real Consultants admin). Keep these contiguous: the heading renders above the first.
  { key: 'consultants', label: 'Consultants', short: 'Consultants', href: '/admin/consultants', icon: GraduationCap, group: 'Consultants' },
  { key: 'consultant-bookings', label: 'Consultant bookings', short: 'Sessions', href: '/admin/consultant-bookings', icon: CalendarCheck, group: 'Consultants' },
  { key: 'consultant-reviews', label: 'Consultant reviews', short: 'Reviews', href: '/admin/consultant-reviews', icon: Star, group: 'Consultants' },
  // [AUMFE-HELP-LEGAL-PREVIEW-1] Preview group: hidden-until-gateway help topics and legal sections (admin only).
  { key: 'preview-help', label: 'Help preview', short: 'Help preview', href: '/admin/preview/help', icon: Eye, group: 'Preview' },
  { key: 'preview-legal', label: 'Legal preview', short: 'Legal preview', href: '/admin/preview/legal', icon: Scale, group: 'Preview' },
];

/** Phone tab bar: these five, then "More" (the rest + View site + Logout). */
export const ADMIN_PHONE_TABS: AdminKey[] = ['overview', 'events', 'bookings', 'payments', 'refunds'];

export const ADMIN_VIEW_SITE = { label: 'View site', href: '/', icon: Globe };
/** Logout goes through /sign-out (ends the Clerk session, lands on `/`). */
export const ADMIN_LOGOUT = { label: 'Logout', href: '/sign-out?from=admin2', icon: LogOut };
