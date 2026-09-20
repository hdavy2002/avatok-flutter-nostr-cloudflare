# Stream FIX1 report — coordinator review fixes [WEB-GATEWAY-FIX1]

Branch: `webgw/int`. Five commits, listed at the end. Nothing pushed, nothing deployed,
no `wrangler`/`cf.sh`/`gh workflow` run, no migration applied against any remote target.

## 1. i18n: live markup wins over stale source catalog

`web/src/lib/i18n/localeStore.ts` — `t()` changed from
`messages[key] ?? sources[key] ?? fallback` to
`messages[key] ?? (fallback || (sources[key] ?? ''))`, with a comment explaining why
(stale `shared/i18n/source/<ns>.json` vs. the live markup the caller passes as
`fallback`; a real non-`en` translation in `messages[key]` still wins first). Needed
parentheses around `fallback || (sources[key] ?? '')` — esbuild rejects a bare `??`/`||`
mix, caught by the build.

Verified server-side: `astro dev`, `curl /sign-in` — body contains "Ready for a break?"
and zero occurrences of "Chai ho jaye". (The brief notes the client-side re-hydration
check, which is what this fix actually targets, is done by the coordinator in a real
browser — `dom.ts`/`UiText` call the same `t()` after JS runs.)

Did not touch `shared/i18n/source/*.json`, did not remove any `data-i18n` attribute.

## 2. Banned words: homepage / about

- `web/src/components/home/PujaBand.astro` — "Book a private video consultation…" →
  "Book a 1:1 video consultation…".
- The "…a live event, a private session, a conversation or a skill…" sentence named in
  the brief does not live in `web/src/pages/about.astro` itself — it's in
  `web/src/components/EntityFaq.astro`'s "What is avaTOK?" FAQ answer (both the visible
  `<dl>` and the FAQPage JSON-LD, since both render from the same `faqs` array), which
  `about.astro` mounts. Fixed there: "a live event, a private session, a conversation or
  a skill they can teach" → "a live event, a 1:1 consultation, a group class or a skill
  they can teach". Grepped `about.astro` and `EntityFaq.astro` afterwards for the full
  COMMON banned-word list — no other hits (the "Delaware corporation" / legal-entity line
  in `EntityFaq.astro` is Stream C's ENTITY CLEANUP territory, not touched).

## 3. HowMoneyMoves: no token wording, receipts claim matches the product

`web/src/components/home/HowMoneyMoves.astro`:
- Refunds block: "Tokens spent on a delivered session aren't refundable except where
  required by law. If a creator misses a booked session, we may return your tokens." →
  "Payment for a delivered session isn't refundable except where required by law. If a
  creator misses a booked session, raise it with us and we may return what you paid." —
  matches `/refunds` §7 ("Marketplace purchases and consultations" / "No-shows": *"If
  the provider does not attend a booked session, you may raise it with us and we may
  return the tokens to your balance."*), with no token/wallet word.
- Receipts block: "Every booking gets an emailed receipt with the exact amount charged."
  → "Every confirmed booking is emailed to you with the amount paid and the join link."

## 4. Worker: closed the remaining example-listing gaps

- **`worker/src/routes/live.ts`** — `loadListing`'s SELECT now includes `is_example`.
  `liveDonate` refuses `if (l.is_example) return json({ error: "example_listing" }, 409);`
  immediately after the not-found check and before `donation()`.
- **`worker/src/routes/listings.ts`**
  - New `hiddenListingFilter(where: string[])` next to `exampleFilter`, pushing
    `COALESCE(json_extract(l.attrs,'$.hide_from_marketplace'),0)=0` unconditionally (no
    opt-in param, unlike `exampleFilter` — a hidden listing stays hidden for everyone).
  - Wired into `exploreBrowse`, `exploreSearch`, `sectionCountsFor` (same `where`-array
    pattern each already uses for `exampleFilter`).
  - `GET /api/creators/:id` (`getCreator`) — the listings query was a fixed SQL string
    with positional binds (`?1`/`?2`/`?3`, no `where`-array). Rebuilt it as a
    `creatorWhere: string[]` array seeded with the four original predicates, then called
    `exampleFilter(req, await readConfig(env), creatorWhere)` and
    `hiddenListingFilter(creatorWhere)` before joining — same binds, same order, no bind
    parameters needed for the two new fragments.
  - Did **not** touch `getListing` (listing detail, `/api/listings/:id`) or the HDFC
    smoke routes (`routes/hdfc_sms_*.ts`), per the brief.
- **`worker/src/routes/sitemap.ts`** — `sitemapListings` rebuilt as a `where`-array
  (previously a literal SQL string with the `is_example=0` predicate inline) so
  `hiddenListingFilter(where)` (imported from `./listings`) could be appended the same
  way as everywhere else. `sitemapCreators` untouched (E's report already flagged this
  as a pre-existing minor gap, not part of this brief).
- **Tests** — extended `worker/test/example_listings.test.ts` with a new
  `describe("[WEB-GATEWAY-FIX1] ...")` block: `liveDonate` guard exists and sits before
  `await donation(`; `loadListing` selects `is_example`; `getCreator` calls both
  `exampleFilter` and `hiddenListingFilter`; `hiddenListingFilter` always pushes the
  `json_extract` fragment; it's wired into `exploreBrowse`, `exploreSearch`,
  `sectionCountsFor`, `sitemapListings`; and a guard test that `getListing`'s body never
  contains `hiddenListingFilter`. 12 new tests, all passing.
- **`worker/test/availability_commercial_hold_sqlite.test.ts`** — added
  `is_example INTEGER NOT NULL DEFAULT 0` to the in-memory `CREATE TABLE listings`
  fixture (was missing the column stream E's migration added). Both previously-failing
  tests in this file now pass.

## 5. Web: examples survive in-page interaction; CI check fixed

- **`web/scripts/check-data-performance.mjs`** — updated the two expected
  `getMarketplaceSeed` query objects to `{ limit: 24, examples: 1 }` and
  `{ limit: 24, examples: 1, q: 'singing lessons' }`, matching what
  `marketplaceSeed.ts` (stream E) actually sends. `node scripts/check-performance.mjs`
  passes end to end (it runs this script plus `check-render-performance.mjs` and
  `check-image-coverage.mjs`).
- **`web/src/lib/apiClient.ts`**
  - `ExploreParams` gained `examples?: boolean`; `getExplore()` converts it to the
    worker's `?examples=1` wire format (`{ examples: 1 }`) only when truthy, and never
    forwards the boolean itself (the worker checks `=== "1"` textually).
  - `getCreator()` now sends `query: { examples: 1 }` unconditionally on
    `GET /api/creators/:id`, so the web creator page (avaTOK Team profile) keeps
    listing its badged examples now that 4(b) gates that route.
- **`web/src/islands/marketplace/api.ts`** — `SearchParams` gained the same
  `examples?: boolean`; `searchListings()` (the `/api/explore/search` variant
  `ExploreGrid.tsx` uses for search) does the same boolean→`1` conversion.
- **`web/src/islands/marketplace/ExploreGrid.tsx`** — the shared `common` fetch object
  in `fetchPage` (used for both `getExplore` and `searchListings`) now sets
  `examples: true`, so badged examples survive pagination, group-chip switches and
  in-page search from the already-loaded marketplace page, not just the first SSR load.
  Did **not** touch `web/src/lib/listingCompanions.ts`, `ListingDetailView.astro`, or
  `BrowseMore.astro` — their `getExplore()` calls simply never pass `examples`, so the
  option stays `undefined` and no `examples=1` is appended, exactly as the brief
  requires (examples must not leak into "browse more" rails on real listings' pages).

## 6. Seed: owner account, group classes under the right group

`scripts/seed_example_listings.sql`:
- Replaced all 8 occurrences of `:OWNER_USER_ID` with the coordinator-verified official
  account uid `user_3GMM0uFG84V20RTmbY1MypELJhD` (`avatok_team` / "avaTOK Team").
  Rewrote the header's placeholder-instructions block into a short "OWNER" section
  naming the account and why.
- `ex-examrev-1`, `ex-spokenenglish-1`, `ex-yoga-1`: `section` changed `'consulting'` →
  `'group_classes'`, and `category` changed to the matching new taxonomy id
  (`teachers`→`group_exam_revision`, `language`→`group_language_practice`,
  `fitness`→`group_fitness_batch`). `ex-guitar-1` (music, capacity 1) and
  `ex-careermentor-1` (career_coach, capacity 1) are genuine 1:1s and were left
  `section='consulting'`. Updated the header's category-mapping notes to document this.

**In-memory SQLite validation** (same approach as stream E's own report): loaded
`worker/migrations/listings.sql`, then every `ALTER TABLE listings ADD COLUMN` /
`ALTER TABLE listing_categories ADD COLUMN` statement found across every
`worker/migrations/2026-*.sql` file (52 statements total, in filename order — a
quote-aware statement splitter was needed since several description/comment strings in
these files contain semicolons that a naive `.split(';')` mis-parses), then
`2026-09-18-webgw-taxonomy.sql`'s `INSERT OR IGNORE`/`UPDATE` statements, then the seed
itself. All 8 `INSERT OR REPLACE` statements applied cleanly. Resulting
`SELECT id, kind, category, section, capacity, price, is_example FROM listings WHERE id
LIKE 'ex-%' ORDER BY id`:

```
id                 | kind       | category                | section        | capacity | price | is_example
-------------------+------------+-------------------------+----------------+----------+-------+-----------
ex-biryani-1       | live_event | live_cooking            | live_streaming | None     | 199   | 1
ex-careermentor-1  | consult    | career_coach            | consulting     | 1        | 799   | 1
ex-examrev-1       | consult    | group_exam_revision     | group_classes  | 30       | 299   | 1
ex-guitar-1        | consult    | music                   | consulting     | 1        | 499   | 1
ex-havan-1         | live_event | live_puja               | live_streaming | None     | 501   | 1
ex-quiznight-1     | live_event | live_everyday           | live_streaming | None     | 99    | 1
ex-spokenenglish-1 | consult    | group_language_practice | group_classes  | 8        | 149   | 1
ex-yoga-1          | consult    | group_fitness_batch     | group_classes  | 20       | 99    | 1
```

## 7. Verify — exact output

### web/ (from a build after ALL web changes above)

```
$ PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
...
[build] Server built in 8.52s
[build] Complete!

$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors,
calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.

$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB),
21 built pages + 4 policy pages checked (20 articles), all /help, /help#, and /#anchor
links resolved, no placeholder text, FAQPage present once, BreadcrumbList present once
per article, 36 /help/art image refs OK, 349 JS chunks checked for rem-based rootMargin,
63 help-page CSS files checked for undefined custom properties.

$ node scripts/check-performance.mjs
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require
browser measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks,
private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed

$ node scripts/check-image-urls.mjs
Image URL origin, privacy, idempotence and bounded variant checks passed
```

**Built-dist banned-word / Devanagari scan** — every `dist/**/*.html` NOT under
`policy|help|blog|ideas|admin` reduces to exactly 5 files: `dist/index.html`,
`dist/about/index.html`, `dist/add/index.html`, `dist/careers/index.html`,
`dist/contact/index.html` (everything else lives under `help/`, `blog/`, `ideas/`,
`global-ideas/`, or one of the 16 dedicated policy pages —
`acceptable-use`/`biometric-retention`/`child-safety`/`community-guidelines`/
`consultation-terms`/`cookies`/`dmca`/`grievance`/`marketplace-terms`/`payouts`/
`pricing-fees`/`privacy`/`recording`/`refunds`/`terms`/`tokens`). Stripped
tags/scripts/styles and grepped (case-insensitive, whole word) the banned list plus
Devanagari codepoints (`ऀ`–`ॿ`) on those 5:

```
dist/index.html: "Private" ... AvaTOK UPI ₹1 Smoke Test . Private payment-pipeline test event. No real event is scheduled.
dist/index.html: "Private" ... AvaTOK UPI ₹1 Smoke Test · From ₹1 Private payment-pipeline test event. No real event is scheduled.
dist/index.html: "dating"  ... Adult, sexual or dating content is prohibited and removed.
```

Zero Devanagari hits. The two "Private" hits are the pre-existing `avatok-upi-smoke-2026`
production listing surfacing in the homepage's Featured rail via live-fetched prod data
at build time — exactly what the brief predicted ("report it, do not try to fix it in
web code"; it's fixed server-side by 4(c)/`hiddenListingFilter`, which only takes effect
once the worker is deployed). The one "dating" hit is the explicitly allowed Trust band
exception. No other hits.

**SSR check** (`astro dev`):
```
$ npx astro dev --port 4324 &
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4324/           -> 200
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4324/marketplace -> 200
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4324/about       -> 200
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4324/sign-in     -> 200
$ curl -s http://localhost:4324/sign-in | grep -o "Ready for a break?"     -> "Ready for a break?"
$ curl -s http://localhost:4324/sign-in | grep -c "Chai ho jaye"           -> 0
```

### worker/

```
$ NODE_ENV=development npx tsc --noEmit
(no output — clean)

$ NODE_ENV=development npx vitest run test/example_listings.test.ts test/availability_commercial_hold_sqlite.test.ts
 ✓ test/availability_commercial_hold_sqlite.test.ts (2 tests)
 ✓ test/example_listings.test.ts (25 tests)
 Test Files  2 passed (2)
      Tests  27 passed (27)

$ NODE_ENV=development npx vitest run
 Test Files  13 failed | 97 passed (110)
      Tests  53 failed | 1070 passed (1123)
```

The 13 failing files are exactly the pre-existing set from stream E's report (verified by
`grep FAIL` on the run output and diffing the file list against E's report):
`src/spam/scoring.test.ts`, `test/ai_billing_accrual.test.ts`,
`test/ava_job_presence_contract.test.ts`, `test/commercial_hardening_contract.test.ts`,
`test/commercial_lifecycle_contract.test.ts`, `test/commercial_pricing_authority.test.ts`,
`test/commercial_stream_phase2_contract.test.ts`, `test/human_call_usage_billing.test.ts`,
`test/messenger_call_stream_paid_audio_owner_rule.test.ts`,
`test/native_decline_contract.test.ts`, `test/paytm_checksum.test.mjs`,
`test/song_quick_mode.test.ts`, `test/wallet_reservation_policy.test.ts` — 53 failing
tests, matching the brief's stated baseline exactly (merged tree: 55 before this stream's
2 fixes → 53 after, same as origin/main). None of these files' failures reference
`is_example`, `example_listing`, or `hiddenListingFilter`; none were touched by this
stream except `availability_commercial_hold_sqlite.test.ts`, which now passes.

### Repo root

```
$ python3 scripts/gen_listing_taxonomy.py --check
up to date: web/src/lib/listingTaxonomy.ts
up to date: app/lib/core/listing_groups.dart
```
(No taxonomy source changes in this stream — `Specs/listing-taxonomy.json` untouched —
so this was expected to be a no-op confirmation, not a regeneration.)

Also re-ran (not required by item 7, informational): `python3
tool/check_design_guard.py --check all` — unaffected, same baseline-clean result as
before this stream (169/211 colours, 0/0 icons).

## Files changed

- `web/src/lib/i18n/localeStore.ts`
- `web/src/components/home/PujaBand.astro`
- `web/src/components/EntityFaq.astro`
- `web/src/components/home/HowMoneyMoves.astro`
- `worker/src/routes/live.ts`
- `worker/src/routes/listings.ts`
- `worker/src/routes/sitemap.ts`
- `worker/test/example_listings.test.ts`
- `worker/test/availability_commercial_hold_sqlite.test.ts`
- `web/src/lib/apiClient.ts`
- `web/src/islands/marketplace/api.ts`
- `web/src/islands/marketplace/ExploreGrid.tsx`
- `web/scripts/check-data-performance.mjs`
- `scripts/seed_example_listings.sql`

## Commits

```
ebc7e67d [WEB-GATEWAY-FIX1] i18n: live markup wins over stale source catalog
b327a990 [WEB-GATEWAY-FIX1] Homepage/about copy: drop banned words, fix receipts/refunds claims
02855494 [WEB-GATEWAY-FIX1] Worker: close remaining example-listing gaps (liveDonate, creators route, hide_from_marketplace)
2d51aff3 [WEB-GATEWAY-FIX1] Web: examples survive in-page interaction (grid pagination/search, creator page), fix perf CI check
76540975 [WEB-GATEWAY-FIX1] Seed: owner uid to avatok_team, group classes under group_classes section
```

## Things I could not do / left as-is

- **The homepage's "AvaTOK UPI ₹1 Smoke Test" card** — still visible in this
  worktree's local `dist/` because the homepage prerenders against the live prod API at
  build time and the worker-side `hiddenListingFilter` fix (item 4c) has not been
  deployed. This is the exact scenario the brief predicted; no web-side fix exists for
  it, and none was attempted.
- **Applying the migration, deploying the worker/web, or running the seed against any
  D1** — none of this was run, per the hard rule (never push/deploy/wrangler/cf.sh/gh
  workflow). The exact ordered rollout stream E documented in
  `Specs/WEBGW-E-REPORT.md` (apply `2026-09-18-listing-is-example.sql`, deploy worker,
  substitute-and-run the seed, deploy web, confirm via `/api/explore?examples=1`) still
  applies unchanged; `worker/migrations/2026-09-18-webgw-taxonomy.sql` from stream F
  must also be applied before the seed (its `group_classes` categories must exist first)
  — order: `2026-09-18-listing-is-example.sql`, then
  `2026-09-18-webgw-taxonomy.sql`, then deploy worker, then run the (now
  owner-substituted, no `sed` needed) seed.
- Everything else in the brief was completed as specified.
