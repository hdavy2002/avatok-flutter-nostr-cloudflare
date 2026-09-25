/** Homepage-only navigation; shared/default chrome keeps its existing menus. */
// [SAATHUM-ARCHIVE-1 2026-09-25] OWNER DECISION: Saathum is now a simple
// Puja & Havan booking site. The marketplace stays (renamed, showing
// Saathum's own internal listings — no outside creators). Creator/seller,
// consultation and UGC pages are ARCHIVED, not deleted: they are listed in
// src/lib/archivedPages.ts, so restoring one is: remove it from
// ARCHIVED_PAGES + re-add its link below.
// Previous menu (for restore): Bazaar = Live streaming, 1:1 consultations,
// Explore marketplace, Explore events, Experiences, Help, Joining a live event
// (/help/booking-and-paying/join-a-live-show); Creators = Start selling
// (/sign-up), Creator dashboard (/dashboard), Payouts, Safety
// (/community-guidelines), For organisers, Guides (/organisers#guides),
// Pricing & Fees; Company also had Careers, Who we are (/terms#status) and
// duplicate Terms/Privacy links.

/** Menu label for /marketplace — renamed for the puja/havan catalogue. */
export const MARKETPLACE_LABEL = 'Our Pujas';

export const HOME_HEADER_LINKS = [
  { href: '/marketplace', label: MARKETPLACE_LABEL },
  { href: '/#joining', label: 'How it works' },
  { href: '/help', label: 'Help' },
];
export const HOME_FOOTER_COLUMNS = [
  { title: 'Services', links: [
    { href: '/marketplace', label: MARKETPLACE_LABEL },
    { href: '/#joining', label: 'How it works' },
    { href: '/help', label: 'Help centre' },
  ] },
  { title: 'Company', links: [
    { href: '/about', label: 'About' },
    { href: '/contact', label: 'Contact' },
  ] },
  { title: 'Legal', links: [
    { href: '/terms', label: 'Terms of Service' },
    { href: '/privacy', label: 'Privacy Policy' },
    { href: '/refunds', label: 'Refunds & cancellations' },
    { href: '/cookies', label: 'Cookies' },
    // Required to stay discoverable (India IT Rules 2021 grievance officer).
    { href: '/grievance', label: 'Grievance Redressal' },
  ] },
];
