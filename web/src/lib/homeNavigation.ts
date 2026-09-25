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
/** Primary header button (brief §5.1). */
export const BOOK_CTA = { href: '/marketplace', label: 'Book a puja' };

// rebrand: reviewed — [SAATHUM-REBRAND-1 2026-09-25] Menu per the Puja & Havan
// brief §5.1: Pujas · Havans · By intention · How it works · About. Footer keeps
// Cookies and Grievance Redressal (IT Rules 2021) beyond the brief's Trust list;
// "Our priests" and "Follow us" wait until a priests page and social accounts exist.
export const HOME_HEADER_LINKS = [
  { href: '/marketplace?q=Puja', label: 'Pujas' },
  { href: '/marketplace?q=Havan', label: 'Havans' },
  { href: '/#experiences', label: 'By intention' },
  { href: '/how-it-works', label: 'How it works' },
  // [SAATHUM-ARCHIVE-2 2026-09-25] About removed from menus by owner (page archived).
];
export const HOME_FOOTER_COLUMNS = [
  { title: 'Rituals', links: [
    { href: '/marketplace?q=Puja', label: 'All pujas' },
    { href: '/marketplace?q=Havan', label: 'All havans' },
    { href: '/#experiences', label: 'By intention' },
    { href: '/marketplace?q=Festival', label: 'Festival pujas' },
  ] },
  { title: 'Company', links: [
    { href: '/how-it-works', label: 'How it works' },
    { href: '/help', label: 'Help centre' },
    { href: '/contact', label: 'Contact' },
  ] },
  { title: 'Trust', links: [
    { href: '/refunds', label: 'Refund policy' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
    { href: '/cookies', label: 'Cookies' },
    // [SAATHUM-ENTITY-1 2026-09-25] Grievance Redressal page removed by owner.
  ] },
];
