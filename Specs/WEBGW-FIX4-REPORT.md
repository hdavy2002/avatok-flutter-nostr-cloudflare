# Stream FIX4 report — [WEB-GATEWAY-FIX4]

Worktree `/Users/davy/.cache/deepastra/webgw-20260918/int`, branch `webgw/int`. No push, deploy,
or wrangler/cf.sh/gh workflow run performed.

## Problem

Prod web-deploy run 35403504877 failed at `node scripts/check-homepage.mjs` ("Approved homepage
section exists: featured"). `index.astro` is prerendered, so `FeaturedSessions.astro` calls
`getMarketplaceSeed()` at build time on the GitHub runner. That helper hard-coded
`timeoutMs: 1800`, tuned for the SSR marketplace page's live-visitor TTFB. From the US runner,
`/api/explore?examples=1` takes ~1–2 s, so the build-time fetch occasionally timed out, the rail
rendered nothing (correct behavior on a real failure), and the CI check tripped. The first deploy
of the day only passed by luck.

## Fix

1. **`web/src/lib/marketplaceSeed.ts`** — `getMarketplaceSeed(q?, opts?)` now takes an optional
   `{ timeoutMs?: number }` second argument, defaulting to the existing `1800` so the marketplace
   page (`MarketplaceBrowse.astro`, unchanged caller) keeps its live-visitor-tuned timeout.
2. **`web/src/components/home/FeaturedSessions.astro`** — passes `{ timeoutMs: 15000 }` (build
   time only; this page is prerendered so no visitor ever waits on it). If the fetch fails or
   returns 0 listings at build time, it now `console.warn`s a one-line message naming the API URL
   (`${API_BASE}/api/explore`) and the failure reason, so a future CI log explains why the rail is
   empty instead of failing silently. Still renders nothing in that case — no invented placeholder
   inventory, per the owner's existing rule.
3. **`web/scripts/check-data-performance.mjs`** — added an assertion that
   `getMarketplaceSeed(undefined, { timeoutMs: 15000 })` passes `timeoutMs: 15000` through to
   `request()`. The pre-existing assertions (`calls[0][1].timeoutMs > 0`, the exact
   `{ limit: 24, examples: 1 }` query shape for the default no-args call) are untouched and still
   pass.

## Files changed

- `web/src/lib/marketplaceSeed.ts`
- `web/src/components/home/FeaturedSessions.astro`
- `web/scripts/check-data-performance.mjs`

## Verify (from `web/`)

```
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build
node scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs && node scripts/check-image-urls.mjs
```

All passed. Build log shows `src/pages/index.astro` completing in `+1.75s` — well inside the new
15 s budget and previously right at the edge of the old 1.8 s one. `check-performance.mjs` output
includes "Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks,
private reads, mutation contracts" (this now covers the new `timeoutMs: 15000` assertion too).

`node scripts/check-data-performance.mjs` run standalone also passed.

### Featured-rail content check

The brief's literal `grep -c 'id="featured"' dist/index.html` → `1` and
`grep -c 'SEE EXAMPLE' dist/index.html` → `8` don't reproduce as written: Astro's build output is
minified to a handful of long lines, so `grep -c` (which counts *matching lines*, not matches)
returns `1` for both — all 8 "SEE EXAMPLE" badges land on the same line. Confirmed the real counts
with `grep -o … | wc -l` instead:

- `grep -c 'id="featured"' dist/index.html` → `1` (matches brief; single line, single occurrence)
- `grep -o 'SEE EXAMPLE' dist/index.html | wc -l` → `8` (matches the brief's intent; `grep -c`
  alone undercounts on minified output)

This is a pre-existing quirk of the minified build output, unrelated to this change. The
semantically meaningful check — `check-homepage.mjs` asserting "Approved homepage section exists:
featured" — is the actual CI gate that failed in prod run 35403504877, and it passed.

## Commit

`cb2178db` — `[WEB-GATEWAY-FIX4] Build-time timeout for the prerendered Featured rail`
(3 files changed, 12 insertions(+), 3 deletions(-)), via
`python3 scripts/git_safe_commit.py`. Not pushed.
