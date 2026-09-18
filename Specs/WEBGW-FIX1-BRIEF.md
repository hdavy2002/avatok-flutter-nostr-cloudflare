# Stream FIX1: coordinator review fixes on the integrated branch  (commit tag [WEB-GATEWAY-FIX1])

You are working in the worktree /Users/davy/.cache/deepastra/webgw-20260918/int on branch `webgw/int`,
which now contains streams A, C, INT, F and E merged together. Read Specs/WEBGW-COMMON.md first, then
Specs/WEBGW-E-REPORT.md and Specs/WEBGW-INT-REPORT.md for context. Hard rules from COMMON still apply:
never push, never deploy, never run wrangler/cf.sh/gh workflow, never hand-edit generated files
(web/src/lib/listingTaxonomy.ts, app/lib/core/listing_groups.dart). You MAY edit web/, worker/, scripts/
and Specs/. Do exactly the items below; do not widen scope. Every item was found by the coordinator's
review and is a blocker for production.

## 1. i18n: the live markup must win over the stale source catalog (site-wide, HIGHEST PRIORITY)

`web/src/lib/i18n/localeStore.ts` line 24:
  `export function t(key,fallback,params){return (messages[key]??sources[key]??fallback)...}`
`sources` is loaded from `shared/i18n/source/<ns>.json` for EVERY locale including `en`. So after client
hydration, `dom.ts` / `UiText` replace each `data-i18n` element's text with the OLD catalog string.
Proof: `shared/i18n/source/web-auth.json` still has `web-auth.147f03f49b15afba: "Chai ho jaye?"` while
sign-in.astro now renders "Ready for a break?" under that same key — in a browser the Hinglish comes back
after JS runs. Streams C and INT changed dozens of strings under existing keys, so this affects many pages.
Fix in `t()` only: when the caller supplies a non-empty `fallback` (the live markup / `source` prop), it
must beat `sources[key]`; keep `messages[key]` (a real translation for a non-en locale) first. i.e.
  `messages[key] ?? (fallback || sources[key] ?? '')` with the same placeholder replacement.
Add a short comment explaining why (stale catalog vs. live markup; locale is forced to `en` by
[WEB-GATEWAY-A]). Do not regenerate or edit the shared/i18n catalogs. Do not remove data-i18n attributes.

## 2. Homepage / about banned words (found by scanning the BUILT dist HTML)

- `web/src/components/home/PujaBand.astro`: card "1:1 consultation with a pandit" body says "Book a
  private video consultation…" → "Book a 1:1 video consultation with a pandit…". No "private" anywhere on
  the homepage.
- `web/src/pages/about.astro`: "…a live event, a private session, a conversation or a skill…" → rewrite
  as "…a live event, a 1:1 consultation, a group class or a skill they can teach". Grep the whole file
  for the COMMON banned list afterwards.

## 3. HowMoneyMoves: no token wording on the homepage; receipts claim must match what the product does

`web/src/components/home/HowMoneyMoves.astro`:
- Refunds block currently reads "Tokens spent on a delivered session aren't refundable except where
  required by law. If a creator misses a booked session, we may return your tokens." COMMON forbids
  token/wallet wording on the homepage. Rewrite without the word token/tokens/wallet while staying inside
  what /refunds actually says (section "Marketplace purchases and consultations": no-show → "you may
  raise it with us and we may return…"; consumed → not refundable except where required by law). E.g.
  "Payment for a delivered session isn't refundable except where required by law. If a creator misses a
  booked session, raise it with us and we may return what you paid."
- Receipts block: "Every booking gets an emailed receipt with the exact amount charged." Soften to what
  the code does (booking confirmation email carries the price; a receipt follows settlement):
  "Every confirmed booking is emailed to you with the amount paid and the join link."

## 4. Worker: close the remaining example-listing gaps

a. `worker/src/routes/live.ts` `liveDonate` (POST /api/live/:listingId/donate) is a wallet spend against a
   listing with NO status or is_example check. Add `is_example` to `loadListing`'s SELECT and, in
   liveDonate, right after the not-found check and BEFORE `donation()`:
   `if (l.is_example) return json({ error: "example_listing" }, 409);`
b. `GET /api/creators/:id` (routes/listings.ts ~line 4098, `${CARD_SELECT} WHERE l.creator_id=?1 AND
   l.vertical=?2 AND l.status IN ('published','live')`) returns example rows to the Flutter app via the
   creator profile. Apply the same rule as explore: hidden unless `?examples=1` AND
   `exampleListingsEnabled`. Reuse `exampleFilter` (it takes a `where` array; adapt the query so the
   fragment can be appended — do not duplicate the logic).
c. Honour the pre-existing `attrs.hide_from_marketplace` flag. `worker/migrations/2026-09-17-upi-smoke-
   event.sql` inserted the production listing `avatok-upi-smoke-2026` ("AvaTOK UPI ₹1 Smoke Test /
   Private payment-pipeline test event") with `attrs='{"upi_smoke_test":true,"hide_from_marketplace":true}'`
   and the comment "not included in normal marketplace discovery by the attrs flag" — but nothing reads
   that flag, and today it is the ONLY row /api/explore returns, so it is baked into the new homepage
   Featured rail and the marketplace. Add a WHERE fragment
   `COALESCE(json_extract(l.attrs,'$.hide_from_marketplace'),0)=0` (json_extract is already used in
   listings.ts ~line 3282) to exploreBrowse, exploreSearch, sectionCountsFor, sitemapListings and the
   creators route from (b). Put it in one helper next to `exampleFilter` (e.g. `hiddenListingFilter`)
   and call it wherever exampleFilter is called. The listing detail page (/api/listings/:id) and the
   HDFC smoke routes must keep working unchanged — do not touch them.
d. Tests: extend `worker/test/example_listings.test.ts` (same source-contract style) to assert the
   liveDonate guard sits before `donation(`, the creators route applies the filter, and the
   hide_from_marketplace fragment is present in each of the five call sites.
e. `worker/test/availability_commercial_hold_sqlite.test.ts` fails on the merged tree with
   "no such column: is_example" (2 tests) — its in-memory `CREATE TABLE listings` fixture (line ~62)
   predates E's column. Add `is_example INTEGER NOT NULL DEFAULT 0` to that fixture. These two are NEW
   failures (baseline origin/main: 53 failing tests; merged: 55); the other 53 are pre-existing and are
   NOT yours to fix.

## 5. Web: examples must survive in-page interaction; CI check must pass

a. `web/scripts/check-data-performance.mjs` (run by web-deploy.yml through check-performance.mjs)
   asserts `getMarketplaceSeed` sends `{ limit: 24 }` / `{ limit: 24, q }`; E changed the query to add
   `examples: 1`, so the production deploy would fail. Update the two expected objects to include
   `examples: 1`, and run `node scripts/check-performance.mjs` to prove the whole CI chain passes.
b. `web/src/islands/marketplace/ExploreGrid.tsx` fetches pages / group changes / searches through
   `getExplore()` in `web/src/lib/apiClient.ts` WITHOUT `examples=1`, so the moment a reviewer clicks a
   group chip ("Group classes", "1:1 consultations") or paginates, every example disappears. Add an
   optional `examples?: boolean` (or similar) option to `getExplore()` (and the search variant it uses)
   that appends `examples: 1`, and pass it ONLY from ExploreGrid's marketplace fetches — not from the
   listing-page "browse more" rails (`listingCompanions.ts`, `ListingDetailView.astro`,
   `BrowseMore.astro`).
c. Web creator page (`getCreator` in apiClient.ts → /api/creators/:id): pass `examples: 1` so the
   avaTOK Team profile on the web still lists the badged examples after 4(b).

## 6. Seed: owner account, group classes under the right group

`scripts/seed_example_listings.sql`:
- Owner is the existing official account `avatok_team` / "avaTOK Team":
  uid `user_3GMM0uFG84V20RTmbY1MypELJhD` (verified in production D1 by the coordinator). Replace every
  `:OWNER_USER_ID` with it and delete the placeholder instructions from the header comment (say who the
  owner is and why instead).
- The three group-class rows (`ex-examrev-1`, `ex-spokenenglish-1`, `ex-yoga-1`) currently carry
  `section='consulting'` and 1:1 categories, so the server's `group_id` (derived from `listings.section`
  via listing_section.ts `groupFor`) puts them under the "1:1 consultations" chip. Stream F added a
  `group_classes` section with categories `group_exam_revision`, `group_language_practice`,
  `group_fitness_batch` (Specs/listing-taxonomy.json, worker/src/lib/listing_section.ts,
  worker/migrations/2026-09-18-webgw-taxonomy.sql). Change those three rows to
  `section='group_classes'` and the matching `group_*` category. Leave guitar (`music`) and career
  (`career_coach`) as `consulting`. Update the header comment's category-mapping notes.
- Re-run the same in-memory SQLite validation E did (load worker/migrations/listings.sql + every dated
  ALTER on listings + 2026-09-18-listing-is-example.sql + 2026-09-18-webgw-taxonomy.sql's INSERT, then the
  seed) and paste the SELECT of id, kind, category, section, capacity, price, is_example in the report.

## 7. Verify (all must pass; paste exact output in the report)

From web/:
  PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
  node scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs && node scripts/check-image-urls.mjs
  Then scan the built dist: for every dist/**/*.html that is NOT a policy/help/blog/ideas/admin page, strip
  tags/scripts/styles and grep (case-insensitive, whole words) for
  private|meetup|fanbase|fans|find your people|friends|companionship|lonely|chat with|dating|Pvt Ltd|Ave Maria|apna|kamaai|kamao|khojo|dikhao|pawri|adda
  and for any Devanagari codepoint. The ONLY acceptable hit is the Trust band sentence "Adult, sexual or
  dating content is prohibited and removed." Note: the homepage is prerendered against the live prod API
  at build time, so the "UPI ₹1 Smoke Test" card will still be in YOUR local dist until the worker fix in
  4(c) is deployed — report it, do not try to fix it in web code.
  Run `npx astro dev` and curl /, /marketplace, /about, /sign-in; grep the sign-in body for
  "Ready for a break?" (server) — the client-side check is done by the coordinator in a real browser.
From worker/:
  NODE_ENV=development npx tsc --noEmit
  NODE_ENV=development npx vitest run   → expect exactly the 53 pre-existing failures (list the files) and
  0 failures in test/example_listings.test.ts and test/availability_commercial_hold_sqlite.test.ts.
Repo root:
  python3 scripts/gen_listing_taxonomy.py --check

## 8. Commit and report

Commit with `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX1] <short description>" <explicit paths>`
(one or more commits, each listing only the files you changed). If the wrapper cannot run in this
worktree, fall back to `git add -- <paths> && git commit -m "[WEB-GATEWAY-FIX1] ..."`. Do not push.
Write Specs/WEBGW-FIX1-REPORT.md: every file changed, per item what you did, the verify output, and
anything you could not do.
