# Stream FIX2 report — residual Hinglish copy (commit tag [WEB-GATEWAY-FIX2])

## Files changed

- `web/src/islands/auth/LoginIsland.tsx`
  - `web-auth.147f03f49b15afba` "Chai ho jaye?" → "Ready for a break?" (matches `sign-in.astro`, already rewritten by Stream C).
  - `web-auth.eef3540404312d17` "Woh bhi ho jayega." → "We'll have you set up in a moment." (matches `sign-in.astro`).
  - `web-auth.4aec6108de24a9f0` "Ya phir" (divider label between the email form and the Google button) → "Or". Found during the grep sweep of the three auth files, not called out explicitly in the brief.
- `web/src/islands/auth/SignUpIsland.tsx`
  - `web-auth.4aec6108de24a9f0` "Ya phir" → "Or" (same key/divider, sign-up form). Rest of the file's `UiText`/`uiT` strings were already plain English — no other Hinglish found.
- `web/src/islands/marketplace/SearchBox.tsx` — placeholder "Dhoondo: tarot, adda, rizz, shayari, antakshari…" → "Search: yoga, guitar, exam revision, live puja…".
- `web/src/components/BazaarSearchStrip.astro` — same placeholder replacement, same new string.

`AuthKit.tsx` was grepped (Hinglish word list + Devanagari Unicode range) and had no matches — nothing to change there.

## Decisions taken

- Reused the exact English strings from `sign-in.astro` for the two login-aside keys so the id-keyed source string is now identical across the Astro static page and the React island — no stale-translation risk since the i18n catalog is keyed by a hash of the source string (`web/src/lib/i18n/catalogClient.ts`), and there is no static/checked-in translation file for these ids in the repo (grepped for all three ids across `web/src`, only the two island files and `sign-in.astro` reference them). Changing the source string alone is sufficient; nothing else to update or remove.
- "Ya phir" (literally "or else"/"or then") was translated to the plain English divider label "Or", consistent with how every other divider/section transition on the site reads.

## Nothing left undone

Everything in the brief was completed; no blockers.

## Verify — exact output

### Build

```
$ cd web && PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
...
[build] Server built in 8.16s
[build] Complete!
```

### check-homepage.mjs

First run failed with `AssertionError: Approved homepage section exists: featured` — this is `FeaturedSessions.astro`'s SSR fetch to `/api/explore` (1800ms timeout) missing the deadline against the live API, unrelated to anything in this stream's scope (auth islands / search placeholder only). A rebuild succeeded cleanly:

```
$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors, calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.
```

### check-help.mjs

```
$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB), 21 built pages + 4 policy pages
checked (20 articles), all /help, /help#, and /#anchor links resolved, no placeholder text, FAQPage present once,
BreadcrumbList present once per article, 36 /help/art image refs OK, 349 JS chunks checked for rem-based
rootMargin, 63 help-page CSS files checked for undefined custom properties.
```

### check-performance.mjs

```
$ node scripts/check-performance.mjs
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks, private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed
```

### SSR page checks (astro dev on :4325)

```
$ npx astro dev --port 4325
$ curl -s http://localhost:4325/sign-in   -o /tmp/sign-in.html
$ curl -s http://localhost:4325/marketplace -o /tmp/marketplace.html
$ grep -c "Chai ho" /tmp/sign-in.html /tmp/marketplace.html      # 0, 0
$ grep -c "Dhoondo" /tmp/sign-in.html /tmp/marketplace.html      # 0, 0
$ grep -c "antakshari" /tmp/sign-in.html /tmp/marketplace.html   # 0, 0
$ grep -o "Ready for a break" /tmp/sign-in.html                  # matched
$ grep -o "Search: yoga, guitar, exam revision, live puja" /tmp/marketplace.html   # matched
```

Zero occurrences of the three banned strings on both pages; the new English copy renders.

### Commit

```
$ python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX2] Residual Hinglish: login aside and search placeholder" \
    web/src/islands/auth/LoginIsland.tsx web/src/islands/auth/SignUpIsland.tsx \
    web/src/islands/marketplace/SearchBox.tsx web/src/components/BazaarSearchStrip.astro
[webgw/int f21fd5ad] [WEB-GATEWAY-FIX2] Residual Hinglish: login aside and search placeholder
 4 files changed, 5 insertions(+), 5 deletions(-)
```

No push, no deploy, no wrangler/cf.sh/gh workflow run.
