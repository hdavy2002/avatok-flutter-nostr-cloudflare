// [DEMO-LISTING-1 / DEMO-MARKET-1 2026-08-26] Shared renderer for the bazaar
// design comps served straight out of design/live-streaming/.
//
// These pages are self-contained Design Component documents: an <x-dc> template
// with {{ }} holes, a `class Component extends DCLogic`, and the support.js
// runtime that binds them at load. Astro owns only the URL; the document ships
// verbatim. When a design is signed off, the route it lives on is what gets
// replaced with a real component — this helper goes away with it.
//
// TWO THINGS HERE ARE LOAD-BEARING. Both fail silently if removed.
//
// 1. <base>. support.js resolves components as COMPONENT_DIR + "/" + name +
//    ".dc.html" with COMPONENT_DIR = ".", i.e. relative to the DOCUMENT. Served
//    at /dollykapoor/mock-listing, "./SiteHeader.dc.html" would resolve to
//    /dollykapoor/SiteHeader.dc.html and 404, and every <dc-import> — header,
//    footer, all six TruckBorder strips — would render nothing at all.
//
// 2. The fonts as a <style>@import, never a <link>. support.js removes EVERY
//    <link> element from the document while it renders (the finished page
//    reports querySelectorAll('link').length === 0, even for links sitting in
//    <head> before it runs). The comps name Anton, Playfair Display, Instrument
//    Sans, Silkscreen, Baloo 2 and Kalam throughout their CSS, and with a <link>
//    not one of them downloads: document.fonts comes back empty and everything
//    falls back to a system face that looks close enough to miss.
//
// The runtime assets — support.js, the <dc-import> components, assets/*.png —
// are served from the avatok-design Pages project rather than from this site's
// public/ directory. That is not a preference either: Cloudflare Pages caps
// _routes.json at 100 rules and Astro emits one exclude per static asset, and
// this site already sits near the cap. Adding the comp's ~11 files pushed it to
// 102, which kills the deploy with "Failed to publish your Function. Got error:
// Unknown internal error occurred." — a message that mentions neither routes nor
// limits. avatok-design is published by design-preview.yml from the same folder,
// so the two stay in step.
const ASSET_ORIGIN = 'https://avatok-design.pages.dev/';

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Anton&family=Playfair+Display:ital,wght@0,700;0,900;1,700;1,900&family=Instrument+Sans:wght@400;500;600;700&family=Baloo+2:wght@600;700;800&family=Kalam:wght@400;700&family=Silkscreen:wght@400;700&display=swap';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface MockupPageOptions {
  /** Raw .dc.html document, imported with ?raw. */
  html: string;
  /** Browser tab title. Interpolated into markup, so it is escaped. */
  title: string;
  /** Seconds. Short by default so the next design iteration is not invisible. */
  maxAge?: number;
  /** Where this comp's listing links should land. Defaults to the demo listing. */
  listingHref?: string;
  /** Where this comp's creator links should land. Defaults to the demo profile. */
  profileHref?: string;
}

/**
 * ── EVERY COMP-TO-COMP LINK IS REWRITTEN, AUTOMATICALLY ─────────────────────
 *
 * The comps navigate to each other by bare relative FILENAME ("avaTOK Listing
 * Details.dc.html") so the standalone preview on avatok-design.pages.dev keeps
 * working when the files are opened directly. On this site every page is served
 * with <base href="https://avatok-design.pages.dev/">, so any such link resolves
 * against the PREVIEW origin — a visitor clicking a card silently leaves
 * avatok.ai and lands on a raw .dc page.
 *
 * This used to be handled per route, by passing the one or two targets each page
 * happened to use. That is how the profile page shipped sending its cards to
 * avatok-design.pages.dev: nobody passed `listingHref` there. Opt-in rewriting
 * fails silently every time a comp gains a link nobody remembered to map.
 *
 * So the mapping is a TABLE and every entry is rewritten on every page, in both
 * the markup form (href="…") and the script form ('…'), whether or not the route
 * asked. A new comp is covered by adding one line here.
 */
const COMP_ROUTES: Record<string, (o: Required<Pick<MockupPageOptions, 'listingHref' | 'profileHref'>>) => string> = {
  'avaTOK Listing Details.dc.html': (o) => o.listingHref,
  'avaTOK Creator Profile.dc.html': (o) => o.profileHref,
  'avaTOK Marketplace.dc.html': () => '/marketplace',
  'avaTOK Auth.dc.html': () => '/sign-in',
  'avaTOK Design System.dc.html': () => '/marketplace',
};

/** Absolute, because <base> rebases root-relative paths onto the asset origin too. */
const abs = (path: string, base: URL): string =>
  path.startsWith('http') ? path : new URL(path, base).href;

export function renderMockupPage({
  html,
  title,
  maxAge = 60,
  listingHref,
  profileHref,
  siteUrl,
}: MockupPageOptions & { siteUrl: URL }): Response {
  const targets = {
    listingHref: listingHref ?? '/avatok/mock-listing',
    profileHref: profileHref ?? '/avatok',
  };

  let withLinks = html;
  for (const [filename, resolve] of Object.entries(COMP_ROUTES)) {
    const href = abs(resolve(targets), siteUrl);
    withLinks = withLinks
      .replaceAll(`href="${filename}"`, `href="${escapeHtml(href)}"`)
      .replaceAll(`'${filename}'`, `'${href}'`);
  }

  // Safety net. If a comp gains a link this table does not know about, it would
  // otherwise fall through to the preview origin — the exact failure this table
  // exists to prevent. Send it to the marketplace instead and leave a trace.
  const leaked = withLinks.match(/["']([^"']*\.dc\.html)["']/g);
  if (leaked) {
    console.warn(`[mockupPage] unmapped comp link(s), routed to /marketplace: ${leaked.join(', ')}`);
    withLinks = withLinks.replace(/(["'])([^"']*\.dc\.html)\1/g, `$1${abs('/marketplace', siteUrl)}$1`);
  }

  const patched = withLinks.replace(
    '<head>',
    `<head>
<base href="${ASSET_ORIGIN}" />
<style>@import url("${FONT_CSS}");</style>
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow" />`,
  );

  // noindex above and a short cache here, deliberately: these are design comps on
  // fake data. They must not be indexed as real listings, and must not be cached
  // so long that the next iteration is invisible for an hour.
  return new Response(patched, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}
