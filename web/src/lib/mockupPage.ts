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
  'https://fonts.googleapis.com/css2?family=Anton&family=Playfair+Display:ital,wght@0,700;0,900;1,700;1,900&family=Instrument+Sans:wght@400;500;600;700&family=Baloo+2:wght@600;700;800&family=Kalam:wght@400;700&family=Nunito:wght@400;600;700;800;900&display=swap';

// [WEB-AUTH-STATE-1 2026-08-28] Make the comp's baked-in header reflect the
// real session.
//
// These pages are static design documents. Their header is <dc-import>ed at
// runtime from the design origin with "Log in" / "Sign up" hardcoded into the
// markup, and NO Clerk island runs on the page — so a signed-in visitor landing
// here saw a signed-out header and reasonably concluded the login had failed.
// SiteHeader.astro cannot help: this route never renders it.
//
// The signed-in test is the SAME one the rest of the site now uses — the
// `__client_uat` cookie, read synchronously (see lib/authState.ts). The first
// version of this script did a credentialed fetch to Clerk's API instead, which
// worked but was a fourth independent implementation of "are they signed in",
// and slower: the buttons could not be right until a round trip finished.
//
// Written as an injected script rather than a fix in the .dc.html because that
// file is served from the SEPARATE avatok-design Pages project — editing it
// there would not reach this site without a second deploy, and would also alter
// the standalone design preview, which is meant to look signed-out.
const AUTH_SCRIPT = `<script>
(function () {
  function signedIn() {
    try {
      var m = document.cookie.match(/(?:^|;\\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
      if (m && m[1] && m[1] !== '0') return true;
      return !!localStorage.getItem('avatok_guest_jwt');
    } catch (e) { return false; }
  }

  function swap() {
    var links = document.querySelectorAll('a[href$="/sign-in"], a[href$="/sign-up"]');
    if (!links.length) return false;
    links.forEach(function (a) {
      var isIn = /\\/sign-in$/.test(a.getAttribute('href') || '');
      a.setAttribute('href', isIn ? '/dashboard' : '/sign-out');
      // Preserve the comp's own styling classes; only the words change.
      a.textContent = isIn ? 'Dashboard' : 'Sign out';
    });
    return true;
  }

  document.documentElement.setAttribute('data-avatok-auth', signedIn() ? 'in' : 'out');
  if (!signedIn()) return;

  // The header is <dc-import>ed asynchronously, so the anchors may not exist
  // yet. Try now, then watch the DOM until they appear. Give up after 10s so
  // this never observes forever on a page that has no header.
  if (swap()) return;
  var obs = new MutationObserver(function () { if (swap()) obs.disconnect(); });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function () { obs.disconnect(); }, 10000);
})();
</script>`;

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

  // Fragment links need the current path pinned to them. <base> resolves a bare
  // href="#" or href="#slots" against the ASSET ORIGIN, not the current page, so
  // an in-page "read more" or anchor jump navigates to
  // avatok-design.pages.dev/# and leaves the site. Prefixing the pathname makes
  // them resolve on this page again, which is what they always meant.
  // The ORIGIN has to be here too, not just the path: <base> rebases
  // root-relative URLs as well, so href="/zoya-mehta#" still resolves onto the
  // asset origin. Only a fully absolute URL is immune.
  withLinks = withLinks.replaceAll(
    'href="#',
    `href="${escapeHtml(siteUrl.origin + siteUrl.pathname)}#`,
  );

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
<meta name="robots" content="noindex, nofollow" />
${AUTH_SCRIPT}`,
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
