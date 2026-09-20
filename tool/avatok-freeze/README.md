# avatok.ai freeze — lane 06-freeze-avatok

Builds a static, noindexed, sign-in/checkout-free snapshot of avatok.ai's
marketing pages as they stood on **main @ 76003bb2** (2026-09-20, before any
other Saathum-rename lane's changes landed). See `plan/SPEC.md` and
`plan/BRIEFS.md` (`saathum-brand` repo) for why: avatok.ai is being frozen as
a historical archive while saathum.com becomes the live, narrowed-scope
product.

Deploys to its **own** Cloudflare Pages project, `avatok-frozen` — never
`avatok-app` (the live SSR client) or `avatok-web`.

## Why this can't just be `web/` with a flag

The live `web/` build needs the Cloudflare adapter and Worker at request time
for auth (Clerk), checkout, the creator dashboard, marketplace search,
live/consult/talk/watch sessions, and per-creator profile pages — none of
which should exist in an archived snapshot with no backend behind it. Rather
than thread a "frozen mode" flag through every one of those routes, this
lane's two scripts mutate a **throwaway checkout** of `web/` before it builds:

1. **`prepare-source.mjs <path-to-web-dir>`** — run before `npm ci`/`astro
   build`. It:
   - Deletes every route that either has `export const prerender = false`
     (needs the Worker/D1 at request time) or is part of the auth/checkout
     funnel — see the `EXCLUDE` list in the script for the full 36 entries
     and why each one is there.
   - Forces `noindex` on every remaining page by patching
     `src/layouts/Base.astro`'s prop default, instead of editing every page
     that imports it.
   - Overwrites `public/robots.txt` to disallow all crawling.
   - Removes `public/llms.txt` (an AI-crawler discovery feed that points at
     `/marketplace` and `/sitemap.xml`, both gone in this build, and whose
     whole purpose contradicts a disallow-all archive).
   - Retargets any `public/_redirects` rule that pointed at `/marketplace`
     to `/` instead, so an old bookmark or backlink 301s home instead of
     into a 404.
   - Rewrites `astro.config.mjs` to `output: 'static'` with no Cloudflare
     adapter — valid only because every `prerender = false` route was just
     deleted; if that stops being true, `astro build` will fail loudly on a
     remaining SSR route rather than silently ship one.
   - **This script is destructive.** Run it only against a fresh CI
     checkout or a disposable `git worktree` — never against a working copy
     with uncommitted changes.

2. **`postprocess-dist.mjs <path-to-dist-dir>`** — run after `astro build`.
   `SiteHeader`/`SiteFooter`/`GlobalHeader`/`GlobalFooter`/
   `ListingDetailsComp` and several blog posts hardcode links into routes
   `prepare-source.mjs` just deleted (`/sign-in`, `/sign-up`, `/dashboard`,
   `/marketplace`, `/explore`, `/india`, …), and none of that is reachable
   through a per-page prop. This rewrites the **built HTML** directly: any
   `<a>` whose `href` starts with a dead route prefix becomes an inert
   `<span class="frozen-disabled-link">` with the same visible text, so
   nothing links to a page that no longer exists. It also double-checks
   every built page carries the noindex meta tag, independent of the
   source-level patch above.

3. **`check-frozen-build.mjs <path-to-dist-dir>`** — smoke check run after
   postprocessing, in place of `web/scripts/check-homepage.mjs`. That script
   is the live site's contract check and asserts things that are true
   *only* for the live homepage: it fails if the page contains the string
   `"noindex"` at all, and requires `href="/sign-up"` and
   `href="/marketplace"` to be live links. Both are the opposite of what
   this build must do, so running it unmodified against the frozen output
   would always fail. `check-frozen-build.mjs` instead asserts: every
   deleted route directory is absent from `dist/`, `robots.txt` disallows
   everything, no AI-crawler feed survives, the homepage is noindexed with
   its dead CTAs neutralized and no live Organization JSON-LD, and every
   HTML file in the build carries a noindex meta tag.

## Verifying without `npm install`

Per `plan/SPEC.md` HARD RULE 2, `npm install`/`npm ci` must never run inside
this sandbox (it strips macOS binaries from `web/node_modules` and breaks
`wrangler` on the host — this repo's `web/` and `worker/` node_modules are
shared with the main checkout and every other lane's worktree). Because of
that, this lane could not run `npm ci && npm run build` itself; that step
only happens inside `.github/workflows/avatok-freeze.yml`'s CI runner, which
has no shared state with the host.

What *was* verified locally, without any npm install:

- `node postprocess-dist.test.mjs` — zero-dependency unit tests for the pure
  helpers in `postprocess-dist.mjs` (dead-href matching, anchor stripping,
  noindex insertion), including the prefix-boundary cases that matter most
  (`/india-next`, `/payouts`, `/consultation-terms`, `/marketplace-terms`
  must all survive untouched).
- `node prepare-source.mjs` run against a **copy** of `web/` in a scratch
  temp directory (never the real checkout) — confirmed it removes all 36
  listed routes, patches `Base.astro` and `astro.config.mjs` as expected,
  removes `llms.txt`, and retargets the three `/marketplace` redirects in
  `_redirects`.
- `check-frozen-build.mjs` run against a synthetic fake `dist/` — confirmed
  it fails when a dead route directory is still present and passes once
  removed.

**Not verified locally, and must be confirmed the first time
`avatok-freeze.yml` actually runs in CI:** that `npm ci && npm run build`
succeeds against the mutated source (no remaining page imports something
only the Cloudflare adapter provides), and that the real `astro build`
output passes `check-frozen-build.mjs`. Re-verify the `EXCLUDE` list in
`prepare-source.mjs` against a fresh `grep -rl "prerender = false" src/pages`
before trusting a build far in the future from 76003bb2 — `src/pages` will
have drifted (that grep is also run automatically as an assertion inside
`prepare-source.mjs`, which warns instead of failing if an expected path is
already gone).

## Running the freeze

Never run this against the shared checkout or deploy it locally — see
`plan/SPEC.md` HARD RULE 8 and the note in `.github/workflows/avatok-freeze.yml`.
The workflow is `workflow_dispatch` only, defaults `publish: false`, and is
meant to be run **by the coordinator**, from `main`, once this lane's
changes have landed and before any other lane's marketplace/taxonomy work
does (an empty-shelves snapshot looks abandoned).

```
gh workflow run avatok-freeze.yml --ref main -f publish=true
```

Manual equivalent of what the workflow does, for reference only (do not run
this against the live checkout):

```
node tool/avatok-freeze/prepare-source.mjs web
cd web && npm ci && npm run build && cd ..
node tool/avatok-freeze/postprocess-dist.mjs web/dist
node tool/avatok-freeze/check-frozen-build.mjs web/dist
```

## `wrangler.toml`

`tool/avatok-freeze/wrangler.toml` names the Pages project `avatok-frozen`
and points `pages_build_output_dir` at `./dist` (relative to this
directory — the workflow downloads the built artifact to
`tool/avatok-freeze/dist` before deploying). Deliberately no
`[[kv_namespaces]]`, no `[vars]`, no adapter bindings: the frozen build has
no Cloudflare adapter at all, so nothing in this project can reach D1, KV,
R2 or Clerk.
