/** Homepage-only navigation; shared/default chrome keeps its existing menus. */
export const HOME_HEADER_LINKS = [
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/help', label: 'Wiki' },
  { href: '/pricing-fees', label: 'Pricing' },
  { href: '/ideas', label: 'Ideas' },
  { href: '/#experiences', label: 'Experiences' },
  { href: '/organisers', label: 'For organisers' },
];
export const HOME_FOOTER_COLUMNS = [
  { title: 'Bazaar', links: [
    // marketGroups.ts defines these public groups; marketplace reads ?group=.
    { href: '/marketplace?group=india_goes_live', label: 'Live streaming' },
    { href: '/marketplace?group=book_their_time', label: '1:1 consultations' },
    { href: '/marketplace', label: 'Explore marketplace' },
    { href: '/marketplace', label: 'Explore events' },
    { href: '/#experiences', label: 'Experiences' },
    { href: '/help', label: 'Help' },
    { href: '/help/booking-and-paying/join-a-live-show', label: 'Joining a live event' },
  ] },
  { title: 'Creators', links: [
    { href: '/sign-up', label: 'Start selling' },
    { href: '/dashboard', label: 'Creator dashboard' },
    { href: '/payouts', label: 'Payouts' },
    { href: '/community-guidelines', label: 'Safety' },
    { href: '/organisers', label: 'For organisers' },
    { href: '/organisers#guides', label: 'Guides' },
    { href: '/pricing-fees', label: 'Pricing & Fees' },
  ] },
  { title: 'Company', links: [
    { href: '/about', label: 'About' },
    { href: '/help', label: 'Help centre' },
    { href: '/careers', label: 'Careers' },
    { href: '/contact', label: 'Contact' },
    { href: '/terms', label: 'Terms of Service' },
    { href: '/privacy', label: 'Privacy Policy' },
    { href: '/terms#status', label: 'Who we are' },
    { href: '/refunds', label: 'Refunds & cancellations' },
    { href: '/terms', label: 'Terms' },
    { href: '/privacy', label: 'Privacy' },
  ] },
];
