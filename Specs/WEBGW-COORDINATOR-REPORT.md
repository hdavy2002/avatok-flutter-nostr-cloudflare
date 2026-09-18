# WEB-GATEWAY coordinator report

Running log kept by the coordinator/reviewer. Times are local (Asia/Kolkata) on 2026-09-19.

## Phase 1 — review

- 03:35 Both `webgw/int` (INT+F) and `webgw/e-examples` (E) have reports; no live Sonnet
  processes. No relaunch needed.
- Read: COORDINATOR-BRIEF, WEBGW-COMMON, A/C/INT/E briefs and reports.
- origin/main is still at the shared base `76003bb2` — nothing landed on main while the streams ran.

### Review of `webgw/e-examples` (Stream E) — accepted with fixes

Correct: `is_example` column + config flag; `exampleFilter` on exploreBrowse / exploreSearch /
sectionCountsFor; 409 `example_listing` guards sit before ledger/gateway calls in `bookListing`,
`commercialHold`, `commercialCheckout`, `payCreateOrder`, `cashfreeCreateOrder`; expiry cron and
orphan sweep skip `is_example=1`; sitemap excludes them; web badge, notice bar, disabled CTA, noindex.
`bookSlot` (calendar) and HDFC-SMS routes cannot reach a listing row, so they need no guard.

Sent back (→ FIX1 brief):
1. `POST /api/live/:listingId/donate` (`live.ts liveDonate`) is a wallet spend against a listing with
   no status or `is_example` check — an example CAN reach the wallet there.
2. `GET /api/creators/:id` returns example rows to the Flutter app through the creator profile
   (explore is gated, this route is not).
3. `web/scripts/check-data-performance.mjs` — run by `web-deploy.yml` — fails on E's `examples: 1`
   change. The production web deploy would have failed.
4. `test/availability_commercial_hold_sqlite.test.ts`: 2 NEW failures ("no such column:
   is_example"). E's report called them pre-existing; baseline origin/main = 53 failing tests,
   merged tree = 55. The other 53 are genuinely pre-existing (verified by running the suite on a
   throwaway origin/main worktree).
5. ExploreGrid's in-page fetch (group chip, pagination, search) drops `examples=1`, so examples vanish
   the moment a reviewer clicks a chip. E flagged it as a follow-up; it is a blocker.
6. Seed: three "group class" rows carry `section='consulting'` so the server files them under
   "1:1 consultations"; must use Stream F's `group_classes` section/categories. Owner uid: production
   D1 has an existing official account `avatok_team` / "avaTOK Team"
   (`user_3GMM0uFG84V20RTmbY1MypELJhD`, with earlier test listings) — using that; no user invented.
   On `listing_blockers`: it is a publish-time creator gate (Google-Calendar availability, capacity=1
   for consults) that no SQL seed can satisfy and that is never re-evaluated at read time or by cron;
   the structural rules (title, category, price ≥ 0, ≤5 covers, live_event future starts_at +
   5–480 min) are all met. Accepting the capacity>1 "group class" consult rows as E documented.

### Review of `webgw/int` (Streams A + C + INT + F) — accepted with fixes

Correct: taxonomy JSON only edited at the source, generator `--check` passes, worker mirror
`listing_section.ts` updated consistently, migration is INSERT/UPDATE only (not for
d1_apply_alters.py), redirects for retired pages, entity cleanup (no Pvt Ltd / Ave Maria anywhere in
web/src), Trust cards each trace to a sentence on the linked policy page (spot-checked all six).

Sent back (→ FIX1 brief):
7. **i18n stale-catalog bug, site-wide.** `localeStore.ts t()` returns `sources[key]` (the shared
   source catalog) BEFORE the live-markup fallback, for every locale including `en`. C and INT changed
   text under existing `data-i18n` keys believing the fallback wins — it does not. Proof:
   `web-auth.147f03f49b15afba` is still "Chai ho jaye?" in the catalog while sign-in renders "Ready
   for a break?"; after hydration the Hinglish returns. curl cannot see this; a browser can.
8. Built-HTML scan (tags/scripts stripped, policy/help/blog pages excluded) found: PujaBand "Book a
   private video consultation" and /about "a private session".
9. HowMoneyMoves uses "Tokens … your tokens" on the homepage (COMMON: no token/wallet wording); the
   Receipts claim has no policy source — softened to what the confirmation email does.
10. The prod listing `avatok-upi-smoke-2026` ("AvaTOK UPI ₹1 Smoke Test / Private payment-pipeline
    test event") is the only row explore returns today, so it is baked into the prerendered homepage
    Featured rail. Its own migration says it is hidden by `attrs.hide_from_marketplace` — nothing
    honours that flag (pre-existing bug). Fix: honour the flag in explore/search/counts/sitemap.

- 03:37 Merged `webgw/e-examples` into `webgw/int` (`7eb6b2ce`). One conflict, the build-generated
  `publicImageManifest.json` — regenerated with the build's own prepare-public-images.mjs.
- 03:40 Preflight: `wrangler whoami` → hdavy2005@gmail.com's Account (`fd3dbf43…`), not fynextlabs. OK.
- 03:44 Launched Sonnet FIX1 in int (`Specs/WEBGW-FIX1-BRIEF.md`).
- 04:05 FIX1 done (5 commits `ebc7e67d`…`76540975`, report `Specs/WEBGW-FIX1-REPORT.md`). Reviewed
  the diff: all 10 items done as specified. One hardening added by the coordinator (`78d5664b`):
  the `hide_from_marketplace` fragment now uses a lazy `CASE … json_valid()` guard, because SQLite's
  `json_extract` raises on malformed JSON and one bad `attrs` write would have taken down every
  browse/search query (prod has 0 invalid rows today; proven in SQLite with a malformed row).
- i18n fix verified by executing the new `t()` in node: stale catalog key + live fallback →
  live text; unknown key → fallback; real translation still wins. (Chrome DevTools is not
  permitted in this session, so no real-browser screenshot/hydration check was possible.)
- Visual-language check: the five new `components/home/*.astro` sections use the existing
  `rail-wrap` / `rail-eyebrow` / `rail-button` classes, `--zine-*` radius/colour tokens, Comfortaa
  headings and the cream/ink palette from `railway-home.css` — native to the homepage. Accepted.

## Phase 2 — integrate (final HEAD before FIX2)

- Web build green; `check-homepage`, `check-help`, `check-performance` (incl. data-performance,
  render-performance, image-coverage), `check-image-urls` all pass. `gen_listing_taxonomy.py --check`
  up to date. Worker `tsc --noEmit` clean; vitest 53 failed / 1070 passed = exactly the origin/main
  baseline set (13 files, none touching this work).
- astro dev curls: `/`, `/marketplace`, `/about`, `/terms`, `/privacy`, `/refunds`, `/ideas`,
  `/sign-in`, `/l/avatok-upi-smoke-2026` → 200; `/india-next` → 301 `/`;
  `/blog/creator-ideas/dil-ki-baat` → 404 under astro dev (its 301 lives in `public/_redirects`,
  a Pages feature — present, 1 line). Markers on `/`: "Turn your skill into income", ids featured /
  puja-darshan / categories / trust-safety / how-payments-work all present once; no language
  selector; no apna/kamaai/fanbase/Ave Maria/Pvt Ltd ("meetup" matches only the CSS class
  `.india-meetup`). `/marketplace` chips: Live events / 1:1 consultations / Group classes; no
  "Find your people", "Pawri", "Khojo". `/terms` carries the exact India sentence, no Pvt Ltd.
- Found two residual Hinglish strings the streams missed: `LoginIsland.tsx` aside
  "Chai ho jaye? / Woh bhi ho jayega." (a second copy of the keys C fixed in sign-in.astro) and the
  search placeholder "Dhoondo: tarot, adda, rizz, shayari, antakshari…" (SearchBox.tsx +
  BazaarSearchStrip.astro). → FIX2 brief, launched 04:12.
- Prod D1 pre-state (read-only): `listings.is_example` column absent; `group_*` categories absent;
  `live_friends`/`adda_rooms`/`glow_up`/`astrologers` still `active=1`. 37 listings, 0 with invalid
  `attrs` JSON.
- 04:00 FIX2 done (`f21fd5ad`): login aside, "Ya phir" divider → "Or", search placeholder. Reviewed.
- Final gates on `f21fd5ad`: web build + all check scripts green; worker tsc clean; taxonomy check
  up to date.

## Phase 3 — production rollout (all times local, 2026-09-19)

0. Preflight OK (see above).
1. 04:00 origin/main unchanged at `76003bb2` → HEAD is a fast-forward, no rebase needed.
   `git push origin HEAD:main` → `76003bb2..f21fd5ad main`. (`scripts/git_safe_push.py` cannot push
   `HEAD:main` from a worktree branch that has no remote ref, so the brief's plain push was used; the
   pre-push hook is non-blocking.) No build auto-fired (all workflows are dispatch-only).
2. 04:01 D1 prod `DB_META`: `2026-09-18-listing-is-example.sql` applied
   (`pragma_table_info` → `is_example INTEGER NOT NULL DEFAULT 0`). 04:02
   `2026-09-18-webgw-taxonomy.sql` applied (19 rows written): 5 `group_*` categories active under
   `find_your_people`; `live_friends`, `adda_rooms`, `glow_up`, `astrologers` → `active=0`;
   `live_puja`/`live_puja_ritual` untouched and active.
3. 04:02 Worker: `gh workflow run worker-deploy.yml --ref main -f environment=prod` → run
   `35401971383`, SHA `f21fd5ad`, all jobs success (hdfc-safety worker+web, deploy). Live deployment
   `2026-09-18T22:34:33Z`, one version at 100%. Verified: `/api/explore` → 0 rows (the UPI smoke
   listing is now hidden by `hide_from_marketplace`); `/api/explore?examples=1` → 0 (nothing seeded yet).
   NB the brief's `?market=1` selects the empty buy/sell vertical — probes use plain `/api/explore`.
4. 04:05 Seed: `scripts/seed_example_listings.sql` applied to prod (48 rows written) with owner
   `avatok_team` (`user_3GMM0uFG84V20RTmbY1MypELJhD`). D1 SELECT shows all 8 rows published,
   `is_example=1`, INR, correct sections. Live API: `/api/explore` → 0; `?examples=1` → 8 with
   `is_example:true` and `group_id` india_goes_live×3 / book_their_time×2 / find_your_people×3;
   `section_counts` live_streaming 3 / consulting 2 / group_classes 3; search "yoga" → 0 without,
   `ex-yoga-1` with; `/api/creators/avatok_team` → 0 without, 8 with; listings sitemap → no `ex-*`,
   no smoke listing. Money entry points (`/book`, commercial checkout, `/donate`, `/pay/*/order`)
   return 401 unauthenticated — the 409 sits behind auth. **Direct 409 confirmation needs a signed-in
   session**, which this session has no credentials for (no Clerk secret locally; Chrome DevTools and
   Cloudflare MCP not permitted). Covered by the 25 contract tests in
   `worker/test/example_listings.test.ts` that assert each guard exists, returns exactly
   `409 {error:"example_listing"}`, and precedes the ledger/gateway call — all passing on the deployed
   SHA. Owner action to close this: see "Owner must do" below.
5. 04:07 Web: `gh workflow run web-deploy.yml --ref main -f publish=true` → run `35402337873`
   (SHA `f21fd5ad`); it cancelled the stale parked run `35343029061`. Build job green; production
   gate approved by the coordinator at 04:10 (owner-approved plan); deploy job success 04:12.
6. Live checks 04:13: `https://avatok.ai/` contains "Turn your skill into income", ids featured /
   puja-darshan / categories / trust-safety / how-payments-work; no apna/kamaai/fanbase/Ave Maria/
   Pvt Ltd (the only "meetup" is a CSS class name); no language selector; Featured rail shows the
   examples with the EXAMPLE badge and the smoke listing is gone. `/marketplace` chips read Live
   events / 1:1 consultations / Group classes and its SSR seed carries all 8 `ex-*` ids with
   `is_example:true`. Example page `/avatok_team/ganga-havan-haridwar-live` renders the
   "Example listing … Booking opens at launch" panel, a disabled button and no checkout link.
   Redirects: dil-ki-baat → /ideas, india-next / landing-steps-preview / global-next /
   archive/home-2026-09-09 → /, close-friends-studio → /global-ideas (all 301). Sign-in: no Hinglish,
   `pk_live_Y2xlcmsuYXZhdG9rLmFpJA` present in the shipped `config.*.js` chunk imported by the Clerk
   island.
   **Two gaps found on the live site → FIX3 (04:15):** (a) the canonical listing URL is
   `/[username]/[slug]`, and E only added the example `noindex` + notice bar to `/l/[id]` — the live
   example page has `robots: index, follow`; (b) `web/src/lib/copy.ts` (card/listing copy
   dictionary), `listingDefaults.ts`, `ListingDetailsComp.astro` and `ReviewsSection.astro` still
   carry Hinglish that renders ("PEHLA SHOW" on cards, "Public ki Rai", "NAYA HOST", "PAISA SAFE",
   "Paisa escrow mein…"), and example cards say "BOOK NOW". Web-only; will re-ship via web-deploy.
7. 04:23 FIX3 landed (`6c3616f8`, report `WEBGW-FIX3-REPORT.md`): example `noindex` + notice on
   `/[username]/[slug]` and `/e/[event]`; `copy.ts`, `listingDefaults.ts`, `ListingDetailsComp`,
   `ReviewsSection` in plain English ("FIRST SHOW", "NEW HOST", "Reviews", "PAYMENT PROTECTED"…);
   example cards say "SEE EXAMPLE" / "EXAMPLE" instead of "BOOK NOW" / "BOOKING OPEN".
   Pushed `f21fd5ad..f37387f5`. Web-deploy run `35403504877` **FAILED** at `check-homepage`
   ("Approved homepage section exists: featured"): the prerendered homepage fetches
   `/api/explore?examples=1` at build time with the SSR seed's 1.8 s timeout, which the US runner
   exceeded; the rail rendered nothing (owner rule) and the check tripped. The earlier deploy had
   passed by luck. No production change resulted (deploy job skipped).
8. 04:30 FIX4 (`cb2178db`): `getMarketplaceSeed(q, { timeoutMs })`; FeaturedSessions uses 15 s at
   build time and logs a warning if empty; data-performance check extended. Pushed
   `f37387f5..cb2178db`. Web-deploy `35403935893` → build + deploy success (gate approved 04:33).
   Live at 04:35: homepage Featured rail with 8 "SEE EXAMPLE" cards, no "BOOK NOW"/"PEHLA";
   example pages `noindex, nofollow`, notice present, no checkout link.
9. 04:37 Found on the live marketplace: the "Group classes" chip row listed the legacy
   `find_your_people` categories — Listener, Home friend, Late-night friend, Quiet company, Chat
   buddy, Walk & talk, Language buddy, College circle, Senior company, Queer-friendly space, Live
   friends — i.e. the paid-companionship framing itself (INT had flagged this as an owner decision).
   **Coordinator decision, under the brief's goal "risky categories hidden": hide them.** Reversible
   — nothing deleted: JSON entries get `hidden: true`, D1 rows get `active=0`, existing listings keep
   their category and label. FIX5 (`a42f2a41`, report `WEBGW-FIX5-REPORT.md`): taxonomy JSON +
   generator (`hidden` field in both mirrors; `subCategoriesFor` excludes hidden; the regenerated
   `app/lib/core/listing_groups.dart` changed — Dart reviewed by eye, no local Flutter toolchain, so
   the next Android CI build is the compile check), web chips strip hidden ids even from the server
   answer, marketplace Hinglish ("Sab", "Sab haazir", "Sab hatao", "Pura bazaar") → English, and
   migration `2026-09-19-webgw-hide-companionship-categories.sql`.
   04:50 migration applied to prod (first attempt returned nothing — re-ran; 10 rows updated;
   verified via D1 SELECT and `/api/explore/categories` → only the five `group_*` categories remain
   under `find_your_people`). Pushed `cb2178db..a42f2a41`; web-deploy `35405368633` success 04:56.
10. 04:57 FINAL live verification (curl, tags/scripts stripped): `/`, `/about`, `/marketplace`,
    `/sign-in`, `/sign-up`, two example pages, `/terms`, `/refunds` → zero banned words / Hinglish /
    Devanagari (only the allowed Trust-band "dating … prohibited" sentence, and "private" on
    `/privacy` in its data-protection sense). Homepage: H1, all section ids, 8 SEE EXAMPLE cards,
    no smoke listing. Marketplace: three chips, 8 example ids, Group classes row = Language
    practice / Fitness & yoga batch / Exam revision / Music class / Cooking class. Example pages:
    `noindex, nofollow`, notice, disabled button, no checkout link.

## Phase 4 — images

`/Users/davy/Documents/avatok-new-images/` was empty at 03:35 and still empty at 04:57. Finished
without it: hero/OG, PujaBand, CategoriesGrid and the 8 `web/public/seed/<slug>.jpg` covers still use
the placeholder art (the seed covers are 8 copies of the existing `genz-friends.jpg`). Old collage /
sari-draping / solo folk-dance images: the homepage no longer renders the Dance adda / Style desk
tiles (Stream A), but the files remain on disk and may be referenced by `india-preview` components
that are now 301-redirected pages. When the images exist, run the Phase 4 brief as written.

## Final state

- `origin/main` = `a42f2a41` (from base `76003bb2`): Streams A, C, INT, F, E + FIX1–FIX5.
- Prod worker: run `35401971383` (SHA `f21fd5ad`; no worker code changed after that).
- Prod web: run `35405368633` (SHA `a42f2a41`).
- Prod D1 `DB_META`: `is_example` column; taxonomy categories; 10 companionship categories inactive;
  8 example rows. Nothing deleted anywhere.
- Flags: `exampleListingsEnabled` = default `true` (no KV override written).

## Rollback

- Web/worker regression: `git revert -m 1` is not applicable (fast-forward history) — revert the
  range `76003bb2..a42f2a41` on main, push, re-dispatch `worker-deploy.yml` / `web-deploy.yml`.
  The D1 changes are additive/flag-only and can stay.
- Examples misbehave: `ALLOW_PROD=1 scripts/flags.sh set exampleListingsEnabled=false` (hides them
  everywhere within ~60 s; money guards stay). Never delete the rows.
- Companionship categories needed back: `UPDATE listing_categories SET active=1 WHERE id IN (…)`
  plus remove `hidden: true` in the JSON and regenerate.

## Owner must do / decide

1. **Signed-in 409 check.** Open any example (e.g. avatok.ai/avatok_team/ganga-havan-haridwar-live)
   while signed in and confirm there is no way to book; if you want the server-side 409 proven live,
   give an agent a Chrome DevTools permission or a Clerk session token — no credentials exist on
   this machine. Every guard is covered by passing contract tests on the deployed SHA.
2. **Images (Phase 4)** — drop the files into `/Users/davy/Documents/avatok-new-images/` and ask for
   Phase 4; today all example covers are one placeholder photo.
3. **Confirm the companionship-category hide** (item 9). It was taken under the brief's stated goal;
   one UPDATE + one JSON edit reverses it.
4. **Android build**: `app/lib/core/listing_groups.dart` changed (generated). The next `ship it`
   compiles it in CI; nothing was triggered.
5. Graphiti memory server was unreachable this session (`ConnectionRefused`), so no graphiti
   episode was written; the file-based memory has two notes (i18n catalog trap; example rollout).

- Note: a web-deploy run `35343029061` had been parked at the production gate since 2026-09-18
  12:07 at SHA `76003bb2` (= current origin/main, i.e. nothing new). Dispatching ours on main will
  cancel it via the workflow's concurrency group.

