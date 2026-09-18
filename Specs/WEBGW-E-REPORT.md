# Stream E report — badged EXAMPLE listings [WEB-GATEWAY-E]

Branch: `webgw/e-examples`. Nothing pushed, nothing deployed, no migration applied, no
`wrangler`/`cf.sh` run against a remote target.

## Files changed

### Worker

- `worker/migrations/2026-09-18-listing-is-example.sql` (new) — `ALTER TABLE listings
  ADD COLUMN is_example INTEGER NOT NULL DEFAULT 0;`. Not applied.
- `worker/src/routes/config.ts` — new `exampleListingsEnabled` flag (interface +
  DEFAULTS, default `true`, boolean so it does not need a `numericKeys` entry).
- `worker/src/routes/listings.ts`
  - `CARD_SELECT` now selects `l.is_example`; `shapeCard()` emits `is_example` —
    this is what exposes the field on **both** explore/browse and listing detail,
    since `getListing` calls the same `shapeCard()`.
  - New exported `exampleFilter(req, config, where)` — the ONE place that decides
    whether badged rows are visible: hidden unless the request carries
    `?examples=1` **and** `exampleListingsEnabled` is true. Wired into
    `exploreBrowse`, `exploreSearch` and `sectionCountsFor` (the marketplace
    sidebar counts — added so a count chip never advertises examples the grid is
    hiding). **Not** wired into `exploreLiveNow`: examples are never `status='live'`
    so they can never reach it, and adding the check there would have been dead code.
  - `bookListing` — refuses `is_example=1` with `409 {error:"example_listing"}`
    immediately after the not-found check, before the AI-agent gate, the block-list
    check, the calendar claim or the wallet `hold()`.
  - `expireEndedEventListings` (the schedule-expiry cron) — added `l.is_example=0`
    to its WHERE so a badged `live_event` row can never be walked to `completed` by
    the clock, regardless of how stale its seeded `starts_at` gets.
- `worker/src/routes/commercial_checkout.ts`
  - `Listing` type gained `is_example`.
  - `commercialHold` (slot hold) — refuses before `claimCheckoutAvailability`
    touches the calendar.
  - `commercialCheckout` (ticket/consult purchase, the wallet-funded lane) —
    refuses before the free-lane gate, the `commercial_checkout_operations` row,
    or any charge.
- `worker/src/routes/pay.ts` — `payCreateOrder` (Razorpay/Paytm/generic-gateway
  `POST /api/pay/:gateway/order`) refuses before the `gateway_orders` row or
  `adapter.createOrder()`.
- `worker/src/routes/cashfree.ts` — `cashfreeCreateOrder` refuses before the
  `direct_purchases` row or the Cashfree API call.
- `worker/src/routes/commercial_lifecycle.ts` — `runCommercialOrphanNoShowSweep`
  gained `l.is_example=0` in its WHERE. Belt-and-suspenders: this sweep only ever
  looks at `orders` rows, and an example listing can never acquire one (every
  checkout/hold entry point above refuses first), so this can never fire in
  practice — added anyway because the brief asks for it explicitly and it costs
  one line.
- `worker/src/routes/sitemap.ts` — `sitemapListings` excludes `is_example=1`
  (`sitemapCreators` was left alone; see "Things I did not do" below).
- `worker/test/example_listings.test.ts` (new) — 16 tests, source-text "contract"
  style matching this file's own existing convention
  (`test/commercial_checkout_phase2c_contract.test.ts`): unit tests for the pure
  `exampleFilter()` function, plus assertions that every guard exists, returns the
  exact `409 {error:"example_listing"}` shape, and sits textually BEFORE the
  ledger/gateway call it guards (via `indexOf` ordering) — the same technique
  already used elsewhere in this suite.

### Web

- `web/src/lib/types.ts` — `Card.is_example` (wire field), `CardView.isExample`
  (derived field).
- `web/src/lib/card.ts` — `toCardView()` maps `is_example` → `isExample`.
- `web/src/components/ListingTile.tsx` — a small "EXAMPLE" badge, same CREAM/INK
  sticker shape as the existing "18+" chip, shown before it when `c.isExample`.
- `web/src/pages/l/[id].astro`
  - `noindex` on `<Base>` now also fires for `listing.is_example` (was
    `closedListing` only) — this is the literal `<meta name="robots"
    content="noindex">` the brief asks for; it reuses the mechanism the page
    already had for a closed show rather than hand-rolling a second one.
  - A new notice bar, styled like the existing "Beta demonstration" banner but
    with its own copy and colour: **"Example listing — This shows what creators
    will offer on avaTOK. Booking opens at launch."**
- `web/src/components/ListingDetailsComp.astro` — `isExampleListing` forces
  `bookingOpen = false` unconditionally (never trusts the server's own
  `booking_open`, which is `true` for these rows — see "Decisions" below), which:
  - hides the entire calendar/seat-picker/price-summary/book-button block
    (`.booking-controls`) — this is what satisfies "no price checkout link
    rendered";
  - renders the existing `.show-closed` panel, but with `isExampleListing` copy
    (`"Example listing"` / `"This shows what creators will offer on avaTOK.
    Booking opens at launch."`) and a genuinely **disabled `<button>`**
    (`disabled aria-disabled="true"`), never an `<a>`, labelled "Booking opens at
    launch" — instead of the normal "More from `<host>`" link (skipped for an
    example: the host is the official avaTOK account, not a creator to browse);
  - fixes the top ticker strip, which shares the same `!bookingOpen` condition, so
    it reads "EXAMPLE LISTING — BOOKING OPENS AT LAUNCH" instead of falling
    through to the wrong "STARTING NOW" text.
- `web/src/lib/marketplaceSeed.ts` — `getMarketplaceSeed()` now always sends
  `examples: 1`. This is the shared SSR seed for the web marketplace page
  (`marketplace.astro` → `MarketplaceBrowse.astro` → `getMarketplaceSeed`) and,
  per the brief, the place to add it so the homepage FeaturedSessions fetch (on
  another branch) picks it up after merge with no extra work.
- `web/public/seed/*.jpg` (new, 8 files) — placeholder cover images, see below.
- `web/src/lib/publicImageManifest.json` — regenerated by the build's own
  `prepare-public-images.mjs` prebuild step after adding the 8 files above (it
  was checked in as `{}`; the build now fills it for every file under
  `web/public/`, including but not limited to the 8 new ones). Committed because
  it is a tracked, build-required artifact, not because I hand-edited it.

### Scripts

- `scripts/seed_example_listings.sql` (new) — 8 `INSERT OR REPLACE INTO listings`
  statements, one per listing in the brief. See "SEED" below for the exact shape
  and the owner-uid placeholder.

## Decisions taken

1. **Category mapping.** Two of the eight briefed categories have no matching id
   in `Specs/listing-taxonomy.json`:
   - "exam and study help" (listing b) → mapped to **`teachers`** (Tutors &
     teachers — closest existing fit for a professor-led exam-revision session).
   - "games and quizzes" (listing d) → mapped to **`live_everyday`** (Everyday
     life — the closest `india_goes_live`/`live_event` category; nothing in the
     taxonomy names trivia/quiz content specifically).
   I did not invent new category ids, per the brief.

2. **"Group class" is not a first-class kind today.** The wizard
   (`web/src/islands/dashboard/listing-form/steps.tsx:119-120`) only offers
   `live_event` and `consult` ("1:1 consult"), and
   `worker/src/lib/listing_blockers.ts`'s publish gate requires
   `capacity===1` for any `kind='consult'` row — so a real creator cannot
   publish a capacity>1 consult through the app today. The three "group class"
   examples (b, e, g) are still written as `kind='consult'` with `capacity`
   8/20/30, because the seed inserts directly via SQL and bypasses that
   publish-time gate entirely (exactly what a seed script is for), and the brief
   explicitly asked for this format to exist. Flagging this as a real product gap
   for whoever eventually lets creators list actual group classes.

3. **Schedule / never-lapsing.** The three `live_event` examples (havan,
   biryani, quiz night) get a real `starts_at` 200/210/220 days in the future
   (computed at seed-apply time via SQLite `strftime`, not hardcoded), so they
   render like a normal upcoming show instead of a blank date. The five
   `consult` examples (group classes + 1:1s) use `schedule_mode='always_on'`
   with no `starts_at` at all. Either way, this is belt-and-suspenders on top of
   the real safety net: `expireEndedEventListings` and
   `runCommercialOrphanNoShowSweep` both skip `is_example=1` unconditionally, so
   no seeded date can ever cause one of these rows to be completed, cancelled or
   swept, no matter how stale the seed becomes.

4. **`exampleListingsEnabled` default `true`.** Per the brief ("default true in
   code is fine"). This flag gates *visibility only* — every money/booking guard
   refuses `is_example` rows unconditionally, with no flag check, so flipping
   this flag can never make an example bookable, only hide/show it in
   explore/browse/search.

5. **Cover images.** No real photos exist yet ("supplied later by the
   coordinator" per the brief). I copied the existing
   `web/public/genz-friends.jpg` stock photo to 8 new paths under
   `web/public/seed/<slug>.jpg` so nothing 404s. **Swap these 8 files for real
   photos before launch** — right now every example card shows the same generic
   photo.

6. **Extended the visibility gate slightly beyond the literal brief text.** The
   brief says "Explore/browse returns example listings ONLY when the request has
   `?examples=1`" (naming one endpoint). I applied the identical gate to
   `exploreSearch` too (and to `sectionCountsFor`'s sidebar counts), because the
   stated goal one line up — "so the Flutter app never sees them" — would
   otherwise be defeated the moment someone searches instead of browsing; the
   app calls both endpoints. I did **not** touch `getExplore()` in
   `web/src/lib/apiClient.ts` (the client-side fetch used by the marketplace
   page's own pagination/filter island, `ExploreGrid.tsx`, and by the
   "browse more" rails on `listingCompanions.ts` / `ListingDetailView.astro`) —
   see the next section.

## Things I did not do / follow-ups

- **`ExploreGrid.tsx` client-side pagination and group/section switching on the
  marketplace page do not carry `examples=1`.** The brief named only
  `getMarketplaceSeed()` (the SSR seed) as the place to wire the param, and I
  followed that literally rather than also touching `apiClient.ts`'s
  `getExplore()` — that function is shared with the listing-detail "browse
  more" rail (`listingCompanions.ts`, `ListingDetailView.astro`), and adding the
  param there would have mixed examples into "more like this" rails on **every**
  real listing's page, which is out of scope and not what the brief asked for.
  Net effect: examples show on the **first** load of `/marketplace` (and will
  show on the homepage FeaturedSessions rail once that branch merges and reuses
  `getMarketplaceSeed`), but paginating, changing the group tab, or searching
  from inside the already-loaded marketplace page will drop them from view
  until the next full page load. If the owner wants examples to survive
  in-page interaction too, `ExploreGrid.tsx`'s own fetch call needs the same
  `examples: 1` param — a small, contained follow-up.
- **`sitemapCreators` was left unguarded.** Only `sitemapListings` excludes
  `is_example` (as the brief specifically names). Today the official account has
  *only* example listings, so it will still appear in the creators sitemap with
  no matching entries in the listings sitemap — a minor inconsistency, not a
  money or privacy issue. Add `l.is_example=0` there too if that bothers anyone
  before launch.
- **Agent (`kind='agent'`) listings are not covered by the CTA-disable UI.** None
  of the 8 seeded examples are agent listings, so this was out of scope, but if
  someone later seeds an `is_example` agent listing, its detail page renders a
  completely different island (`AgentBookingBoxIsland`) that does not read
  `booking_open`/`is_example` at all — it would need its own guard. The
  server-side money guards (bookListing rejects `kind==='agent'` before the
  is_example check even runs; commercial checkout kinds are `live_event`/
  `consult_1to1` only) do not currently cover an agent purchase route at all
  (that lane is `agent_live_decisions`, per CLAUDE.md, and out of this brief's
  named entry-point list), so this is a pre-existing gap, not one I introduced.
- **`attrs` (the rich content JSON — how-it-works, house rules, FAQ, etc.) is
  NULL on all 8 seeded rows.** The detail page renders fine without it (every
  reader in `getListing`/`ListingDetailsComp` treats a missing/empty `attrs` as
  "nothing to show" rather than an error), but the pages will look sparser than
  a fully dressed real listing. Left out deliberately to keep the seed's own
  copy — the two-paragraph descriptions — as the single source of truth per
  listing, rather than duplicating the same facts into a second JSON blob;
  enrich later if the coordinator wants the fuller card sections filled in.

## SEED — owner placeholder

This repo has **no existing "official/admin/system" account convention** — I
grepped `worker/src`, `worker/migrations` and `Specs/` for
`official/admin/system account`, `OWNER_USER_ID`, `platform account` and found
nothing. Per the brief, `scripts/seed_example_listings.sql` therefore uses the
literal placeholder token `:OWNER_USER_ID` as `creator_id` on all 8 rows — **a
textual find/replace is required before applying it**, since D1's
`wrangler d1 execute --file=` does not do bind-parameter substitution against a
plain SQL file:

```bash
sed -i '' 's/:OWNER_USER_ID/user_xxxxxxxxxxxxxxxxxxxx/g' scripts/seed_example_listings.sql
```

How to find (or create) that uid: the owner should decide whether the examples
should be attributed to their own personal account or — probably better for a
reviewer's first impression — a dedicated "avaTOK" creator profile. Either way,
the uid is a `users.uid` (Clerk uid). Once an account exists, look it up with:

```sql
SELECT uid, handle, display_name FROM users WHERE handle = '<its handle>';
```

I did not create such an account or pick a uid myself — that is an ownership
decision, not an engineering one, and the brief asks the script to carry a
"clearly marked placeholder" rather than guess.

## Exact ordered production rollout (none of this was run)

1. **Apply the migration** (staging first):
   ```bash
   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-18-listing-is-example.sql --binding DB_META --dry-run
   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-18-listing-is-example.sql --binding DB_META
   ALLOW_PROD=1 python3 scripts/d1_apply_alters.py worker/migrations/2026-09-18-listing-is-example.sql --binding DB_META
   ```
2. **Deploy the worker** (normal `cf.sh` flow, not run here):
   ```bash
   scripts/cf.sh worker deploy          # staging (.avatok-target=staging)
   ALLOW_PROD=1 scripts/cf.sh worker deploy   # prod, deliberate
   ```
3. **Substitute the owner uid and run the seed** (after step 2 — the `is_example`
   column and the guard code must exist first):
   ```bash
   sed -i '' 's/:OWNER_USER_ID/<real uid>/g' scripts/seed_example_listings.sql
   scripts/cf.sh worker d1 execute DB_META --remote --file=scripts/seed_example_listings.sql
   ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=scripts/seed_example_listings.sql
   ```
4. **Deploy the web app** (normal flow, not run here) — needed so the
   `?examples=1` marketplace seed, the EXAMPLE badge and the disabled-CTA detail
   page all ship together with the worker change; the web and worker halves of
   this feature are meaningless without each other.
5. Confirm: `curl -s -H 'Cache-Control: no-cache'
   "https://api.avatok.ai/api/explore?examples=1&cb=$RANDOM"` returns the 8
   `ex-*` ids with `"is_example":true`; a plain `.../api/explore?cb=$RANDOM`
   (no `examples=1`) returns none of them.

**Switch all examples off in one place** at any point (does not need a
redeploy):
```bash
ALLOW_PROD=1 scripts/flags.sh set exampleListingsEnabled=false
```
This hides them from every explore/browse/search response immediately (KV
propagates in the usual ~30-60s); it does not touch the rows or the money
guards, which refuse `is_example` purchases regardless of this flag.

## Verify — exact output

All from a clean `npm ci` in each of `worker/` and `web/` (devDependencies were
not installed by default in this worktree — `npm ci` alone skips them here; used
`npm ci --include=dev` in `worker/` to get `typescript`/`vitest`).

### Worker

```
$ cd worker && npx tsc --noEmit
(no output — clean)

$ npx vitest run test/example_listings.test.ts
 ✓ test/example_listings.test.ts (16 tests) 5ms
 Test Files  1 passed (1)
      Tests  16 passed (16)

$ npx vitest run test/commercial_checkout_phase2c_contract.test.ts
 ✓ test/commercial_checkout_phase2c_contract.test.ts (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ npx vitest run   # full suite
 Test Files  14 failed | 96 passed (110)
      Tests  55 failed | 1059 passed (1114)
```

The 14 failing files (`src/spam/scoring.test.ts`, `test/ai_billing_accrual.test.ts`,
`test/ava_job_presence_contract.test.ts`, `test/availability_commercial_hold_sqlite.test.ts`,
`test/commercial_hardening_contract.test.ts`, `test/commercial_lifecycle_contract.test.ts`,
`test/commercial_pricing_authority.test.ts`, `test/commercial_stream_phase2_contract.test.ts`,
`test/human_call_usage_billing.test.ts`,
`test/messenger_call_stream_paid_audio_owner_rule.test.ts`,
`test/native_decline_contract.test.ts`, `test/paytm_checksum.test.mjs`,
`test/song_quick_mode.test.ts`, `test/wallet_reservation_policy.test.ts`) are
**pre-existing and unrelated** — verified by inspecting each root cause: e.g.
`commercial_pricing_authority.test.ts` fails inside `policyFor()`/
`refundPercents()` because its own test fixture config object is missing three
unrelated refund-pct fields (nothing I touched); `commercial_lifecycle_contract.test.ts`
asserts a literal import string (`'import { claimBlock, releaseBlocks } from
"../cal/engine"'`) that does not exist anywhere in `commercial_lifecycle.ts` even
on a clean checkout of `HEAD` — confirmed with `git show HEAD:... | grep`. None
of the 14 files' failures reference `is_example`, `example_listing`, or any line
I changed. My diff to `commercial_lifecycle.ts` and `commercial_checkout.ts`
(both touched by some of these failing files) is 3 lines and 14 lines
respectively, neither anywhere near the failing assertions.

### Web

```
$ cd web && PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
... ✓ Completed. [build] Server built in 7.39s. [build] Complete!

$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors,
calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 115 cards, three formats, shared chrome, artwork and hero link.
115 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 115 articles.
Homepage title, description, canonical and selected creator image passed.

$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB),
21 built pages + 4 policy pages checked (20 articles), all /help, /help#, and
/#anchor links resolved, no placeholder text, FAQPage present once, BreadcrumbList
present once per article, 36 /help/art image refs OK, 353 JS chunks checked for
rem-based rootMargin, 84 help-page CSS files checked for undefined custom properties.
```

**SSR smoke test** (the `@astrojs/cloudflare` adapter does not support `astro
preview`, so used `astro dev`, which still runs the real Astro SSR route code):

```
$ npx astro dev --port 4322 &
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4322/marketplace
200
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4322/l/fake-id-does-not-exist
404   (body: "Listing not found" — the existing not-found path, unaffected)
```
Also confirmed the new markers made it into the compiled server bundle:
```
$ grep -rl "Booking opens at launch" dist/
dist/_worker.js/chunks/ListingDetailsComp_BQvH4s3Z.mjs
dist/_worker.js/pages/l/_id_.astro.mjs
```
Could not render a real example listing end-to-end — that needs the migration
applied, the worker deployed and the seed run, none of which this task is
allowed to do. Verified the SQL itself instead: loaded `worker/migrations/listings.sql`
plus every dated `ALTER TABLE listings` migration (44 statements, includes the
new `is_example` one) into an in-memory SQLite db via `python3`, then ran
`scripts/seed_example_listings.sql` (placeholder substituted) against it — all
8 `INSERT OR REPLACE` statements succeeded, and a `SELECT` back confirmed the
correct `kind`/`category`/`price`/`capacity`/`duration_min`/`section`/
`schedule_mode`/`is_example`/`slug` on every row. Also confirmed the
`exampleFilter` WHERE fragment against the same seeded data: 0 rows visible
without `examples=1`, 8 visible with it.

Design guard (repo-wide, not web-specific, but touches nothing new):
```
$ python3 tool/check_design_guard.py --check all
design-guard[colours]: OK — 169 occurrence(s), all within the baseline of 211.
design-guard[icons]: OK — 0 occurrence(s), all within the baseline of 0.
```
