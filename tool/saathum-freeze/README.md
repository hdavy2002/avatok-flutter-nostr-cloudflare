# saathum-freeze — static archive of the old site

Issue id: `[SAATHUM-FREEZE-1]`. Sister lane of `tool/avatok-freeze/` (which froze avatok.ai on
2026-09-20). Same idea, adapted to today's `web/` tree.

The live site (Astro, `web/`, Cloudflare Pages project `avatok-app`) is moving to a new domain.
The old domain moves to a NEW Pages project, **`saathum-frozen`**, holding a static, noindexed
archive of today's public information pages, still in the old brand. The archive holds NO trace
of the new site (owner requirement 2026-10-01: partners must not be able to link the two sites):
no banner, no canonical, no off-site link or redirect, and the check fails on any mention of it.
Functional links people still hold (emails, WhatsApp messages) are 302-redirected to the archive
home `/`.

Nothing here deploys by itself. `.github/workflows/saathum-freeze.yml` is `workflow_dispatch`
only (no push trigger), and its `publish` input defaults to false.

## Files

| File | Job |
|---|---|
| `freeze-config.mjs` | The one place for: kept pages, redirect prefixes. |
| `prepare-source.mjs` | Mutates a THROWAWAY checkout of `web/` before `astro build` (see below). |
| `postprocess-dist.mjs` | Rewrites the BUILT html: noindex, canonical removal, dead links made inert. |
| `check-frozen-build.mjs` | Fails the job if anything slipped through. |
| `*.test.mjs` | Zero-dependency tests: `node tool/saathum-freeze/postprocess-dist.test.mjs` and `node tool/saathum-freeze/prepare-source.test.mjs`. |
| `wrangler.toml` | Pages project `saathum-frozen`, no bindings. |

## Configuration (change it in one place)

* **No new origin.** There is no `NEW_ORIGIN` / `NEW_BRAND_NAME` / `new_origin` input any more. Do not
  add one: the archive must never name the new site.

## What is kept (17 source pages -> 78 built HTML files)

An ALLOW-list (`KEEP_PAGES`). Any page added to `web/src/pages` later is dropped by default.

| Route | Source |
|---|---|
| `/` | `index.astro` |
| `/about`, `/how-it-works`, `/temples` | `about.astro`, `how-it-works.astro`, `temples.astro` |
| `/rituals`, `/rituals/<slug>` (the Puja & Havan guide and its articles) | `rituals/index.astro`, `rituals/[slug].astro` |
| `/help`, `/help/<section>/<article>`, `/help/search.json` | `help/index.astro`, `help/[...slug].astro`, `help/search.json.ts` |
| `/contact` (form replaced by a "this is an archive, write to us / use the new site" notice) | `contact.astro` |
| `/terms`, `/privacy`, `/refunds`, `/cookies`, `/disclaimer`, `/grievance` | one `.astro` each |
| `404.html` | `404.astro` |
| plus static `public/` files: `offline.html`, images, fonts, `/og/*.png`, `manifest.webmanifest`, `_headers` | |

`prepare-source.mjs` refuses to run if a kept page has gone missing or gained `prerender = false`.

## What is removed (91 source files)

Everything else under `web/src/pages`:

* **Every `prerender = false` route** (SSR, needs Worker/D1/Clerk at request time): `[username]/[slug]`
  (listing pages `/saathum/<slug>`), `admin/**`, `api/*` (contact, careers-apply, waitlist),
  `blog/[...slug]` (the 410 handler), `book/[id]` + `book/[id]/checkout`, `careers`, `dashboard` +
  `dashboard/**` (incl. `dashboard/[...rest]`), `e/[event]`, `explore`, `forgot-password`,
  `free-videos`, `l/[id]`, `marketplace` + `marketplace/page/[page]`, `og/[kind]/[...key].png`,
  `shop/index|all|c/[slug]|p/[slug]|checkout`, `sign-in`, `sign-out`, `sign-up`, `sso-callback`,
  `test/upi`, `test/upi/admin`, `watch/[id]`.
* **Prerendered but pointless or contradicting the archive policy**: `llms.txt`, `llms-rituals.txt`,
  `sitemap.xml`, `sitemap-pages.xml`, `sitemap-directory.xml`, `sitemap-listings.xml`.
* **Also removed from `public/`**: `llms*.txt`, `sitemap*.xml`, the IndexNow key file
  (`<32 hex>.txt`). `robots.txt` becomes `Disallow: /`. `sw.js` becomes a kill-switch that clears
  caches and unregisters the old dashboard service worker. `_headers` gains `X-Robots-Tag: noindex`.
* **Not a route, but not in the archive**: `middleware.ts` (410 handling, edge cache) is not used by a
  static build. The old 410 paths (`/careers`, `/blog/*`, `/pricing`, ...) simply 404 here.

## What is stripped from what stays

* **API**: `lib/env.ts` `API_BASE` becomes `''`; the API and auth host fields in the `lib/brand.ts`
  mirror are blanked; the run-time price refresher (`lib/pricingClient.ts`) is emptied. Build-time "starting
  from" prices (`lib/pricing.ts`) are fetched once during the build only if `FREEZE_PRICING_API` is set
  (workflow input `pricing_api`); otherwise the built-in fallback price is baked in. Neither value reaches
  the output.
* **Islands that fetched from the API / used Clerk**: `CartButton`, `CartDrawer` (header cart),
  `BookNowShelf`, `FreeVideosRow` (home page rows; both already render nothing when there is no data) and
  the Preeti chat widget (`PreetiChat` + `PreetiMount`) are replaced by empty components.
* **Clerk**: no Clerk code is reachable once the islands above are empty. The check fails if "clerk" appears
  in any built text file.
* **Turnstile**: the contact form, its script tag and its CSS rule are removed.
* **PostHog is kept.** It posts straight to its own host from the browser, with no backend of ours, so it
  keeps working and gives visit counts on the old domain.
* **Build-time checks of the live site** (`check-image-urls.mjs`, `dedupe-routes-json.mjs`) are dropped from the
  npm scripts: they assert the live API origin and a Worker `_routes.json`.

## Every page gets (postprocess, no page source redesigned)

* `<meta name="robots" content="noindex">` (only one robots tag; whatever the page asked for is replaced).
* No canonical link (removed), no banner, no JSON-LD, no `rel=sitemap` link.
* Links in the built html: a link to a path that is not in the archive becomes an inert
  `<span class="frozen-disabled-link">` with the same text. Never a link to another site.
* Contact page: "The contact form is switched off at the moment. You can email us at support (@) <domain>.
  For anything about your data, see our Privacy Policy." (`<domain>` comes from the archived `brand.ts`.)

## `_redirects` (written by prepare-source, verified by the check)

For each prefix `P` below: `/P` and `/P/` (static) plus `/P/*` (dynamic), all `302 -> /` (the archive home).

`j`, `l`, `e`, `book` (incl. `/book/<id>/checkout`), `checkout`, `dashboard`, `sign-in`, `sign-up`, `sign-out`,
`sso-callback`, `forgot-password`, `watch`, `free-videos`, `shop`, `explore`, `marketplace`, `admin`, `live`,
`session`, `talk`, `consult`, `c`, `saathum` (listing URLs `/saathum/<slug>`).

Not redirected on purpose: `/og/*` (static images that stay here), `/api/*` (webhooks and POST endpoints; a
redirect would be wrong), `/blog/*` and the other pages that already answered 410.

The existing `web/public/_redirects` rules are carried over (retired URLs such as `/creator-resources`,
`/rituals/<removed havan>`, `/tokens`); any whose target is a route that is gone from the archive now lands
on `/`, and any with an off-site target is dropped. Nothing may point off-site.

Pages limits are 2,000 static + 100 dynamic rules; today's file has 73 static + 31 dynamic. Static rules are
written first (Cloudflare requires it). The check enforces both limits.

## Running it

CI does the real build:

```
Actions -> "Freeze saathum.com (Cloudflare Pages)" -> Run workflow
  ref         = the commit that is live today (required)
  pricing_api = optional, see above
  publish     = false to only build + verify; true to deploy to saathum-frozen
```

The `saathum-frozen` Pages project must exist and the old domain must be attached to it by the owner.
The workflow overlays `web/`, `shared/` and `Specs/` from `ref` onto the dispatching checkout, so the freeze
scripts used are always the ones on the dispatching ref.

Local dry run (never against the real `web/`; never `npm install` on the Mac — link the shared `node_modules`):

```
S=/tmp/freeze-scratch; mkdir -p $S && rsync -a --exclude node_modules --exclude dist web $S/ && cp -R shared Specs $S/
ln -s <main-checkout>/web/node_modules $S/web/node_modules
node tool/saathum-freeze/prepare-source.mjs $S/web
(cd $S/web && npm run build)
BRAND_JSON=$S/Specs/brand.json node tool/saathum-freeze/postprocess-dist.mjs $S/web/dist
BRAND_JSON=$S/Specs/brand.json node tool/saathum-freeze/check-frozen-build.mjs $S/web/dist
```

## When the freeze script breaks

It fails loudly instead of building something wrong: `prepare-source.mjs` stops if a patched file no longer
matches (the message names the file), and the check fails on any API host, Clerk, Turnstile, Preeti, any canonical or banner, any mention of the new site, missing
noindex, deleted route or dangling internal link. Fix the pattern or the list in this folder;
never loosen the check.
