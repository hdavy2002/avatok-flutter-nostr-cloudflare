# saathum-freeze — static archive of the old site

Issue id: `[SAATHUM-FREEZE-1]`. Sister lane of `tool/avatok-freeze/` (which froze avatok.ai on
2026-09-20). Same idea, adapted to today's `web/` tree.

The live site (Astro, `web/`, Cloudflare Pages project `avatok-app`) is moving to a new domain.
The old domain moves to a NEW Pages project, **`saathum-frozen`**, holding a static, noindexed
archive of today's public information pages, still in the old brand, with a banner and
canonical links pointing at the new origin. Functional links people still hold (emails,
WhatsApp messages) are 301-redirected to the same path on the new origin.

Nothing here deploys by itself. `.github/workflows/saathum-freeze.yml` is `workflow_dispatch`
only (no push trigger), and its `publish` input defaults to false.

## Files

| File | Job |
|---|---|
| `freeze-config.mjs` | The one place for: default target origin, banner wording/size, kept pages, redirect prefixes. |
| `prepare-source.mjs` | Mutates a THROWAWAY checkout of `web/` before `astro build` (see below). |
| `postprocess-dist.mjs` | Rewrites the BUILT html: noindex, canonical, banner, link repointing. |
| `check-frozen-build.mjs` | Fails the job if anything slipped through. |
| `*.test.mjs` | Zero-dependency tests: `node tool/saathum-freeze/postprocess-dist.test.mjs` and `node tool/saathum-freeze/prepare-source.test.mjs`. |
| `wrangler.toml` | Pages project `saathum-frozen`, no bindings. |

## Configuration (change it in one place)

* **Target origin** — `DEFAULT_NEW_ORIGIN` in `freeze-config.mjs`. Override per run with
  `--new-origin=https://...` or env `NEW_ORIGIN` (the workflow's `new_origin` input; blank = default).
  Nothing else hardcodes it.
* **New brand name** — `DEFAULT_NEW_BRAND_NAME` in `freeze-config.mjs` (placeholder, the name is not
  final). It is only the visible link text in the banner. Override with env `NEW_BRAND_NAME`.
* **Banner sentence** — `BANNER_TEMPLATE` (`{old} is now at {link}`) and `BANNER_FONT_SIZE_PX` (16;
  the check fails below 14). `{old}` is the OLD brand name, read from `Specs/brand.json` at build time —
  it is never typed in this folder.

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
* `<link rel="canonical" href="NEW_ORIGIN<same path>">`; `og:url` follows; the `rel=sitemap` link and all
  JSON-LD are removed.
* A thin banner as the first element of `<body>`: "<old brand> is now at <a href=NEW_ORIGIN+same path>NEW_BRAND_NAME</a>",
  16px system font, inline-styled, so no stylesheet is touched.
* Links in the built html: a link to a path that is not in the archive is rewritten to `NEW_ORIGIN + path` when the
  new site serves that path (the redirect list below), else made an inert `<span>`. A run on today's tree repointed
  about 1,150 links (header Log in / Sign up / Dashboard, Marketplace, Shop, ...) and needed no inert spans.

## `_redirects` (written by prepare-source, verified by the check)

For each prefix `P` below: `/P` and `/P/` (static) plus `/P/*` -> `NEW_ORIGIN/P/:splat` (dynamic), all 301.
Cloudflare Pages keeps the incoming query string on a redirect whose destination has none.

`j`, `l`, `e`, `book` (incl. `/book/<id>/checkout`), `checkout`, `dashboard`, `sign-in`, `sign-up`, `sign-out`,
`sso-callback`, `forgot-password`, `watch`, `free-videos`, `shop`, `explore`, `marketplace`, `admin`, `live`,
`session`, `talk`, `consult`, `c`, `saathum` (listing URLs `/saathum/<slug>`).

Not redirected on purpose: `/og/*` (static images that stay here), `/api/*` (webhooks and POST endpoints; a
redirect would be wrong), `/blog/*` and the other pages that already answered 410.

The existing `web/public/_redirects` rules are carried over (retired URLs such as `/creator-resources`,
`/rituals/<removed havan>`, `/tokens`); any whose target is a route now served only by the new site are
retargeted to the new origin (`/videos` -> `NEW_ORIGIN/marketplace`, `/humphrey/*` -> `NEW_ORIGIN/saathum/:splat`).

Pages limits are 2,000 static + 100 dynamic rules; today's file has 73 static + 31 dynamic. Static rules are
written first (Cloudflare requires it). The check enforces both limits.

## Running it

CI does the real build:

```
Actions -> "Freeze saathum.com (Cloudflare Pages)" -> Run workflow
  ref         = the commit that is live today (required)
  new_origin  = blank for the default
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
matches (the message names the file), and the check fails on any API host, Clerk, Turnstile, Preeti, missing
banner/noindex/canonical, deleted route or dangling internal link. Fix the pattern or the list in this folder;
never loosen the check.
