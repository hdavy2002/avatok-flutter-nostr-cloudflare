/**
 * [SAATHUM-ARCHIVE-1 2026-09-25] OWNER DECISION: Saa Thum is now a simple site
 * selling Puja & Havan booking. The pages below served the old creator
 * marketplace (sellers, consultations, UGC, wallet). They are ARCHIVED, NOT
 * DELETED — the owner plans to bring them back later.
 *
 * What "archived" means here:
 *   - the page file and its URL stay live (old links, Play-listing URLs and
 *     gateway reviewers still resolve — nothing 404s),
 *   - it is removed from every header/footer menu (homeNavigation.ts,
 *     SiteFooter.astro),
 *   - Base.astro renders it with robots noindex,
 *   - sitemap-pages.xml.ts leaves it out.
 *
 * TO RESTORE A PAGE: delete its entry here and add its link back to
 * homeNavigation.ts (HOME_FOOTER_COLUMNS). That is the whole undo.
 * Do NOT delete any of these page files.
 */
export const ARCHIVED_PAGES: ReadonlyArray<{ path: string; label: string; reason: string; prefix?: boolean }> = [
  { path: '/marketplace-terms', label: 'Marketplace Terms', reason: 'marketplace-only terms' },
  { path: '/consultation-terms', label: 'Consultation Terms', reason: '1:1 consultations dropped' },
  { path: '/acceptable-use', label: 'Acceptable Use', reason: 'rules for user-posted content' },
  { path: '/community-guidelines', label: 'Community Guidelines / Safety', reason: 'UGC rules' },
  { path: '/dmca', label: 'DMCA', reason: 'no user uploads' },
  { path: '/biometric-retention', label: 'Biometric Data', reason: 'creator face checks' },
  { path: '/child-safety', label: 'Child Safety', reason: 'UGC/live-stream obligation' },
  { path: '/recording', label: 'Recording & Consent', reason: 'creator live/1:1 recording' },
  { path: '/pricing-fees', label: 'Pricing & Fees', reason: 'platform fees charged to sellers' },
  { path: '/tokens', label: 'Tokens & Wallet', reason: 'wallet not used for bookings' },
  { path: '/payouts', label: 'Payouts', reason: 'seller payouts' },
  { path: '/organisers', label: 'For organisers / Guides', reason: 'seller onboarding' },
  // [WEB-CAREERS-GONE-1 2026-09-27] /careers DELETED (410), no longer archived — see pages/careers.astro.
  // [WEB-ABOUT-FOLK-1 2026-09-27] /about UN-archived by owner — rebuilt on the folk
  // shell and back in the header + footer menus (lib/homeNavigation.ts).
  { path: '/grievance', label: 'Grievance Redressal', reason: 'owner removed 2026-09-25' },
  // [SAATHUM-REBRAND-1 2026-09-25] Creator-earning content, off-brand for a puja service.
  { path: '/ideas', label: 'Creator ideas', reason: 'creator earning ideas' },
  { path: '/global-ideas', label: 'Global creator ideas', reason: 'creator earning ideas' },
  { path: '/pricing', label: 'Creator pricing', reason: 'creator plans' },
  // [WEB-SEO-REBRAND-1 2026-09-27] Seller/listing rules page from the marketplace era.
  { path: '/prohibited-services', label: 'Prohibited Services', reason: 'rules for outside sellers' },
  // [WEB-BLOG-RITUALS-1 2026-09-27] /blog removed from the archive: the old posts were
  // DELETED by owner decision; /blog now 301s to /rituals and old posts answer 410
  // (src/pages/blog/[...slug].astro).
];

export const ARCHIVED_PATHS: ReadonlySet<string> = new Set(ARCHIVED_PAGES.map((p) => p.path));

/** True for an archived page path (trailing slash tolerated). */
export function isArchivedPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (ARCHIVED_PATHS.has(p)) return true;
  // prefix entries also cover everything below them (e.g. /blog/*)
  return ARCHIVED_PAGES.some((e) => e.prefix && p.startsWith(e.path + '/'));
}
