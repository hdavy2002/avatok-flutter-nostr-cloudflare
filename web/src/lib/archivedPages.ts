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
// [WEB-OLD-PAGES-GONE-1 2026-09-27] OWNER DECISION: every page that used to be listed
// here was DELETED (not archived) — the files are gone and the URLs answer 410 Gone
// via src/middleware.ts (GONE_EXACT / GONE_PREFIXES). The list is empty on purpose;
// the machinery stays so a future page can be archived again in one line.
export const ARCHIVED_PAGES: ReadonlyArray<{ path: string; label: string; reason: string; prefix?: boolean }> = [];

export const ARCHIVED_PATHS: ReadonlySet<string> = new Set(ARCHIVED_PAGES.map((p) => p.path));

/** True for an archived page path (trailing slash tolerated). */
export function isArchivedPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (ARCHIVED_PATHS.has(p)) return true;
  // prefix entries also cover everything below them (e.g. /blog/*)
  return ARCHIVED_PAGES.some((e) => e.prefix && p.startsWith(e.path + '/'));
}
