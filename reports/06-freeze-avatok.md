# REPORT — lane 06-freeze-avatok

## What this lane owns

A static snapshot of avatok.ai as it stood on `main @ 76003bb2` (2026-09-20),
built and verified **before** any other Saathum-rename lane's changes land,
per `plan/SPEC.md`'s instruction that a late build "ships with empty
shelves and looks abandoned." It deploys to its own Cloudflare Pages
project, `avatok-frozen` — never `avatok-app` or `avatok-web`.

## What changed

Three new files, all under this lane's own namespace, nothing shared with
another lane:

- `tool/avatok-freeze/prepare-source.mjs` — mutates a **throwaway** checkout
  of `web/` before `npm ci`/`astro build`: deletes the 36 SSR/auth/checkout
  routes (`export const prerender = false` pages plus the sign-in/up/out,
  sso-callback, forgot-password, dashboard, marketplace, and
  live/consult/talk/watch/session/book/agent/embed/vision/test/admin trees),
  force-patches `Base.astro` so every remaining page is `noindex`, overwrites
  `robots.txt` to disallow all crawling, removes `public/llms.txt`,
  retargets the three `/marketplace` rules in `public/_redirects` to `/`,
  and rewrites `astro.config.mjs` to `output: 'static'` with no Cloudflare
  adapter.
- `tool/avatok-freeze/postprocess-dist.mjs` — runs after `astro build`:
  converts any `<a href="/dead-route">` left in the built HTML (from
  `SiteHeader`/`SiteFooter`/blog posts that hardcode links the source patch
  can't reach) into an inert `<span class="frozen-disabled-link">`, and
  double-checks noindex on every built page.
- `tool/avatok-freeze/postprocess-dist.test.mjs` — zero-dependency unit
  tests for the two pure helpers above (`isDeadHref` prefix-boundary
  matching, `stripDeadAnchors`, `ensureNoindex`).
- `tool/avatok-freeze/check-frozen-build.mjs` **(new this session)** — a
  frozen-build-specific smoke check that runs in place of
  `web/scripts/check-homepage.mjs`. That script is the *live* site's
  contract check and cannot run against this build: it asserts the homepage
  contains no `"noindex"` string at all and requires `href="/sign-up"` /
  `href="/marketplace"` to be live links — both are the opposite of what
  the frozen build must do. `check-frozen-build.mjs` instead asserts every
  deleted route directory is absent from `dist/`, `robots.txt` disallows
  everything, no AI-crawler feed (`llms.txt`, `llms-creator-ideas.txt`,
  `sitemap.xml`) survives, the homepage is noindexed with dead CTAs
  neutralized and no live Organization JSON-LD, and every HTML file in the
  build carries a noindex meta tag.
- `tool/avatok-freeze/wrangler.toml` — Pages project config: `name =
  "avatok-frozen"`, `pages_build_output_dir = "./dist"`, deliberately no
  bindings (no adapter in this build, so nothing to bind).
- `tool/avatok-freeze/README.md` **(new this session)** — full design
  writeup: why a throwaway-checkout mutation instead of a runtime flag, what
  each script does, why `check-homepage.mjs` can't be reused, and exactly
  what was and wasn't verified without `npm install`.
- `.github/workflows/avatok-freeze.yml` **(new this session)** —
  `workflow_dispatch`-only CI workflow, `publish` input defaulting to
  `false`. Build job: checkout → `prepare-source.mjs` → `npm ci` → `npm run
  build` → `postprocess-dist.mjs` → `check-frozen-build.mjs` → upload
  artifact. Deploy job (gated on `publish: true`): downloads the artifact
  into `tool/avatok-freeze/dist` and runs `wrangler pages deploy` from that
  directory (project name comes from its `wrangler.toml`). **Not run.**

Note: `tool/avatok-freeze/prepare-source.mjs`, `postprocess-dist.mjs`,
`postprocess-dist.test.mjs` and `wrangler.toml` already existed, untracked,
in this worktree when this session started (evidently from an earlier,
uncommitted pass at this same lane). I read and verified all four before
building on top of them; the `EXCLUDE` list and Base.astro/astro.config.mjs
patch logic were correct and complete against the current `src/pages` tree
(verified below), so I kept them as-is except for two additions to
`prepare-source.mjs`: removing `public/llms.txt` and retargeting the three
`/marketplace` redirects in `public/_redirects`, both described above. I
added `check-frozen-build.mjs`, `README.md`, and the workflow file, none of
which existed before.

## How I verified it

**`npm install`/`npm ci` never ran** — SPEC.md HARD RULE 2 forbids it in
this sandbox (shared `node_modules` with the main checkout and every other
lane's worktree; installing here would strip macOS binaries and break
`wrangler` on the host). Everything below was verified without it:

1. `node tool/avatok-freeze/postprocess-dist.test.mjs` — all three helper
   test groups pass (`isDeadHref`, `stripDeadAnchors`, `ensureNoindex`),
   including the prefix-boundary cases (`/india-next`, `/payouts`,
   `/consultation-terms`, `/marketplace-terms` all correctly survive).
2. Cross-checked `prepare-source.mjs`'s `EXCLUDE` list against a fresh
   `grep -rl "prerender = false" src/pages` on the current tree (76003bb2):
   every one of the ~30 matched files falls under an `EXCLUDE` entry: no SSR
   route was missed.
3. Ran `prepare-source.mjs` against a **scratch copy** of `web/` in
   `mktemp -d` (never the real checkout): confirmed it removes all 36
   listed paths (`36/36 removed`, no warnings), correctly patches
   `Base.astro` (noindex forced true, Organization JSON-LD gated off it) and
   `astro.config.mjs` (static output, no adapter, no leftover
   `@astrojs/cloudflare` import), writes the disallow-all `robots.txt`,
   deletes `public/llms.txt`, and retargets the `/marketplace` redirects in
   `public/_redirects` to `/`.
4. Grepped the remaining source tree (after the dry-run deletion) for
   `Astro.locals` / `locals.runtime` / `astro:middleware` usage — the only
   two hits (`api/contact.ts`, `api/waitlist.ts`) are both already deleted
   by `EXCLUDE`, so dropping the Cloudflare adapter doesn't strand any
   remaining page that depends on it. No `middleware.ts` exists.
5. Confirmed the three remaining dynamic (`[slug]`/`[...slug]`) routes —
   `blog/creator-ideas/[slug].astro`, `blog/global-creator-ideas/[slug].astro`,
   `help/[...slug].astro` — are all `prerender = true` with their own
   `getStaticPaths`, so `output: 'static'` can build them with no adapter.
6. Wrote and smoke-tested `check-frozen-build.mjs` against a synthetic fake
   `dist/` directory: confirmed it fails when a dead route directory (e.g.
   `dashboard/`) is still present, and passes once removed.

## What I could not do, and why

- **Could not run `npm ci && npm run build`**, so the real `astro build`
  output was never produced or checked against `check-frozen-build.mjs` in
  this session — only a synthetic fake `dist/` was checked. This is
  precisely why the workflow exists: `.github/workflows/avatok-freeze.yml`'s
  CI runner has no shared `node_modules` with the host and is the first
  place this actually gets built end-to-end. **The first real run of this
  workflow is the load-bearing verification step**, not this session's
  local checks — someone should watch its `build` job output (route count
  removed, `npm run build` success, `check-frozen-build.mjs` pass/fail)
  before trusting the artifact.
- **Did not run the workflow and did not deploy anything** — SPEC.md HARD
  RULE 8 and this lane's own brief ("Prepare the workflow; do not deploy")
  both forbid it. No `gh workflow run` was issued.
- **HARD RULE 6** ("a green `astro build` does not prove a page renders —
  curl the actual page") doesn't have a live URL to curl for a build that
  hasn't been deployed. The analogous check for this lane —
  `check-frozen-build.mjs` on the built `dist/` — is written and
  smoke-tested but, per the point above, has not yet run against a real
  build.
- Did not touch `web/scripts/check-homepage.mjs`, `check-help.mjs`,
  `check-image-urls.mjs`, or `check-performance.mjs` — they're owned by the
  live site's build (`web-deploy.yml`) and, per the README, at least
  `check-homepage.mjs` is actively incompatible with a noindexed archive.
  The freeze workflow does not call any of them.
- Left `tool/avatok-freeze/wrangler.toml` exactly as found (already
  correct: `name = "avatok-frozen"`, no bindings) except for wiring it into
  the new deploy job's `workingDirectory`.
- No D1/KV/worker changes, no taxonomy edits, no brand-string edits — all
  out of this lane's scope per `plan/BRIEFS.md`.

## Timing note for the coordinator

Per SPEC.md: this must build from current `main` **before** other lanes'
marketplace/taxonomy changes land, or the frozen snapshot will show an
already-narrowed, half-migrated marketplace instead of avatok.ai as it
actually looked. The commit this was verified against is `76003bb2` — if
`main` moves before `avatok-freeze.yml` is actually dispatched, re-run the
`grep -rl "prerender = false" src/pages` cross-check in step 2 above before
trusting the `EXCLUDE` list (the script itself warns, but does not fail, if
an expected path is already gone by the time it runs).
