# Stream FIX4: prerendered homepage Featured rail must not depend on a 1.8 s API timeout  (tag [WEB-GATEWAY-FIX4])

Worktree /Users/davy/.cache/deepastra/webgw-20260918/int, branch `webgw/int`. web/ only. Never push,
deploy, or run wrangler/cf.sh/gh workflow.

Problem: production web-deploy run 35403504877 failed at `node scripts/check-homepage.mjs` with
"Approved homepage section exists: featured". `web/src/pages/index.astro` is `prerender = true`, so
`components/home/FeaturedSessions.astro` calls `getMarketplaceSeed()` (`web/src/lib/marketplaceSeed.ts`)
at BUILD time on the GitHub runner; that helper hard-codes `timeoutMs: 1800`, tuned for the SSR
marketplace page's TTFB. From the US runner `/api/explore?examples=1` takes ~1–2 s, so the fetch
timed out, the rail (correctly) rendered nothing, and the check tripped. The first deploy of the day
passed only by luck.

Fix (smallest change):
1. `web/src/lib/marketplaceSeed.ts`: give `getMarketplaceSeed(q?, opts?)` an optional
   `{ timeoutMs?: number }` second argument, defaulting to the existing 1800 so the marketplace page
   is unchanged.
2. `web/src/components/home/FeaturedSessions.astro`: pass `{ timeoutMs: 15000 }` (build time only —
   this page is prerendered, no visitor waits on it). Also: if the fetch fails or returns 0 listings at
   build time, `console.warn` a clear one-line message naming the API URL so the CI log says why the
   rail is empty (keep rendering nothing in that case — that is the owner's rule).
3. `web/scripts/check-data-performance.mjs`: keep its assertions passing (it asserts
   `calls[0][1].timeoutMs > 0` and the exact query objects; the default path must still send exactly
   `{ limit: 24, examples: 1 }`). Add one assertion that `getMarketplaceSeed(undefined, { timeoutMs: 15000 })`
   passes `timeoutMs: 15000` through.

Verify from web/: `PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build
&& node scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs && node scripts/check-image-urls.mjs`;
confirm `grep -c 'id="featured"' dist/index.html` → 1 and `grep -c 'SEE EXAMPLE' dist/index.html` → 8.

Commit: `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX4] Build-time timeout for the prerendered Featured rail" <paths>`
(fallback: git add -- <paths> && git commit). Write Specs/WEBGW-FIX4-REPORT.md (files, verify output).
