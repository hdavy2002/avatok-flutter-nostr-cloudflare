/** Homepage-only navigation; shared/default chrome keeps its existing menus. */
// [SAATHUM-ARCHIVE-1 2026-09-25] OWNER DECISION: Saa Thum is now a simple
// Puja & Havan booking site. The marketplace stays (renamed, showing
// Saa Thum's own internal listings — no outside creators). Creator/seller,
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
// [MKT-V2-4 2026-09-27] OWNER DECISION: one "Explore" link to /marketplace replaces Pujas · Havans · By intention (not the word "Marketplace").
export const HOME_HEADER_LINKS = [
  // [WEB-NAV-HOME-1 2026-09-27] OWNER DECISION: Home is the first menu item.
  { href: '/', label: 'Home' },
  { href: '/marketplace', label: 'Explore' },
  { href: '/how-it-works', label: 'How it works' },
  // [WEB-BLOG-RITUALS-1 2026-09-27] OWNER DECISION: "Blog" menu item = the Puja &
  // Havan Guide at /rituals (the new blog). The old /blog articles were removed.
  { href: '/rituals/', label: 'Blog' },
  // [WEB-HIW-2 2026-09-27] OWNER DECISION: Help centre is a header menu item, after How it works.
  { href: '/help', label: 'Help centre' },
  // [WEB-ABOUT-FOLK-1 2026-09-27] OWNER DECISION: "About us" is back in the header
  // (the 2026-09-25 archive of /about is reversed — see lib/archivedPages.ts).
  { href: '/about', label: 'About us' },
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
    // [WEB-BLOG-RITUALS-1 2026-09-27] Blog = the Puja & Havan Guide.
    { href: '/rituals/', label: 'Blog' },
    { href: '/help', label: 'Help centre' },
    // [WEB-ABOUT-FOLK-1 2026-09-27] OWNER DECISION: About us in the footer too.
    { href: '/about', label: 'About us' },
    { href: '/contact', label: 'Contact' },
  ] },
  { title: 'Trust', links: [
    { href: '/refunds', label: 'Refund policy' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
    { href: '/cookies', label: 'Cookies' },
    // [WEB-DISCLAIMER-1 2026-09-29] Disclaimer page added by owner.
    { href: '/disclaimer', label: 'Disclaimer' },
    // [WEB-GRIEVANCE-1 2026-09-29] New Saa Thum Grievance Redressal page (owner copy).
    { href: '/grievance', label: 'Grievance Redressal' },
    // [SAATHUM-ENTITY-1 2026-09-25] Grievance Redressal page removed by owner.
  ] },
];
