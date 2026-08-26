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
  /**
   * Send the comp's in-page jumps to a route on THIS site instead of the asset
   * origin. The marketplace comp navigates with
   * `window.location.href = 'avaTOK Listing Details.dc.html'`, a bare relative
   * filename — which <base> resolves against avatok-design.pages.dev, so a
   * visitor clicking a card would silently leave avatok.ai mid-flow.
   *
   * Pass a FULLY ABSOLUTE url (`new URL(path, Astro.url).href`). <base> rebases
   * root-relative paths as well, so '/foo' lands on the asset origin too — which
   * looks identical in the code and still walks the visitor off the site.
   */
  listingHref?: string;
  /**
   * Where the comp's creator name / avatar / host photo should go. Same
   * absolute-URL requirement as listingHref.
   */
  profileHref?: string;
}

/** The comp's hardcoded navigation target, as it appears in the .dc.html. */
const COMP_LISTING_TARGET = "'avaTOK Listing Details.dc.html'";

/**
 * The comp's profile links, written as a bare relative filename so the
 * standalone preview on avatok-design.pages.dev keeps working. On this site the
 * same rule applies as above: <base> would resolve it to the asset origin, so it
 * is rewritten to an absolute URL here.
 */
const COMP_PROFILE_TARGET = 'href="avaTOK Creator Profile.dc.html"';

export function renderMockupPage({
  html,
  title,
  maxAge = 60,
  listingHref,
  profileHref,
}: MockupPageOptions): Response {
  let withLinks = listingHref
    ? html.replaceAll(COMP_LISTING_TARGET, JSON.stringify(listingHref).replace(/"/g, "'"))
    : html;
  if (profileHref) {
    withLinks = withLinks.replaceAll(COMP_PROFILE_TARGET, `href="${escapeHtml(profileHref)}"`);
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
