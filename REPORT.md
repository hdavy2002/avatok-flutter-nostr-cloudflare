# 09-web-ui — REPORT

Lane: Astro site's visible surfaces (top nav, footer links, homepage shelves
down to two, marketplace filters). Branch `saathum/09-web-ui`, single commit
`f9a50653`.

## What changed

- **`web/src/lib/marketGroups.ts`** — added `PUBLIC_GROUP_ORDER`, `GROUP_ORDER`
  filtered to drop `find_your_people`. `GROUP_ORDER`/`GROUPS` themselves are
  untouched (nothing deleted, matches "features can come back"). This is the
  single allowlist every web chrome surface below reads from.
- **`web/src/components/MarketplaceBrowse.astro`** — marketplace category
  tiles now map over `PUBLIC_GROUP_ORDER`: 3 tiles → 2 (`india_goes_live`,
  `book_their_time`). The tile grid CSS (`md:grid-cols-2`) already matched 2
  columns, so this also fixed a pre-existing odd-tile-out layout wobble.
- **`web/src/islands/marketplace/FilterRail.tsx`** — the marketplace filter
  rail's group radios now render `PUBLIC_GROUP_ORDER` too: 3 radios → 2.
- **`web/src/pages/index.astro`, `india-next.astro`, `landing-steps-preview.astro`**
  — hero "Ways to earn" CTAs: dropped the separate "Private 1:1" link, kept
  one "1:1 consultations" link pointed at `?group=book_their_time`.
- **`web/src/components/india-preview/BookingExpress.astro` +
  `BookingExpressIllustrated.astro`** — the homepage's illustrated "Ek
  platform. Teen/Do tareeke." format shelf: dropped the "Group sessions" tile
  (Saathum has no group-booking category), renamed "1:1 sessions" →
  "1:1 consultations" / "Offer your undivided time." → "Book a private
  consultation.", 3-column grid → 2 in both the component and
  `railway-home.css`.
- **`web/src/components/SiteFooter.astro`** — removed the "Find your people"
  Bazaar-column link (`/#live-friends`), which pointed at the now-empty
  companionship shelf. The `#live-friends` id itself still exists in the DOM
  (kept on the surviving 1:1 link, harmless), so nothing else that might
  still hold a bookmark to it 404s.
- **`shared/i18n/source/web-landing.json`** — see "i18n correctness fix"
  below; this file lives outside `web/` but is the direct source of the
  copy I changed, so keeping it in sync was necessary to avoid shipping a
  silent regression.

## Top nav

`SiteHeader.astro`'s `DEFAULT_LINKS` (Marketplace / Wiki / Pricing / Ideas)
never named a removed category — nothing to change there. Confirmed the live
homepage renders `SiteHeader`/`SiteFooter` in the default `'india'` variant,
never `'global'`, so `GlobalHeader.astro`, `GlobalFooter.astro` and the
`/global-ideas` editorial catalog are not reachable from anything I touched.

## i18n correctness fix (not in the original brief, but load-bearing)

`web-landing.*` ids are content-hash keys: `web-landing.<sha256(text).slice(0,16)>`
(verified by hashing the existing strings myself — e.g. `sha256("Group
sessions").slice(0,16) === "84d0be67f5ca32a2"`, the exact id in the markup).
`scripts/i18n/generate_catalogs.mjs` copies the `en` locale catalog straight
from `shared/i18n/source/*.json`, and the client hydration path
(`catalogClient.ts`) applies that catalog to `data-i18n` nodes for every
locale **including English** — this is the exact failure mode already in
project memory ("Web i18n catalog overrode markup … reverted after hydration
until t() was fixed"). If I'd changed the visible markup text under an
existing key without updating the source catalog, the hydrated page would
have silently reverted to the old copy ("Group sessions", "1:1 sessions",
"Ek platform. Teen tareeke.", "Offer your undivided time.") after paint —
correct in the static HTML, wrong for every real visitor a moment later.

Fixed it by minting new content-hash keys and adding them to
`shared/i18n/source/web-landing.json` instead of overwriting the old ones in
place: `fd0b1a468083deee` ("1:1 consultations", used in three places),
`6e0103589f0d1804` ("Ek platform. Do tareeke."), `7400a62e97524a0a` ("Book a
private consultation."). Old keys (`84d0be67f5ca32a2`, `f34fb6b7a6f51b9d`,
`e38ba82f0a13cc39`, `7480d0ba273e2df7`) are left in the source file, now
unreferenced by any markup — harmless (no orphan-key lint exists in
`scripts/i18n/`), left in place rather than risking a cross-locale cleanup I
couldn't fully verify. Non-English locales won't have translations for the
three new keys until `scripts/i18n/generate_catalogs.mjs --allow-paid` is
next run in CI (needs `GOOGLE_TRANSLATION_ACCESS_TOKEN`) — until then those
three strings fall back to English for hi/bn/ta/etc. visitors, same as any
newly-authored copy. I did not run that generation step; it calls a paid
external API and isn't something this lane should trigger unattended.

## Kept untouched (per brief + SPEC)

- "Message this creator" panel and the add-contact deep link:
  `web/src/islands/listing/MessageHost.tsx`, `web/src/pages/add.astro`,
  `web/src/lib/urls.ts` — confirmed not in the diff, not referenced by
  anything I changed.
- Number system / number picker — never touched.
- `web/src/lib/listingTaxonomy.ts` (generated mirror) and
  `Specs/listing-taxonomy.json` — lane 01's, not edited.
- `web/src/lib/org.ts` and any avaTOK→Saathum brand string — lane 10's, not
  edited (nav/footer/homepage still say "avaTOK" throughout; that's
  intentional, not a gap I introduced).
- Group heading copy (`GROUP_DISPLAY.india_goes_live` /
  `.book_their_time` label/eyebrow/title/zone/punch in `marketGroups.ts`) —
  SPEC has lane 01 *propose* new headings in its own REPORT.md and
  explicitly says "do not invent marketing copy elsewhere," so I left the
  existing "India goes live" / "Book their time" copy as-is rather than
  writing new headline voice myself. **This is a gap**: once lane 01's
  proposal lands, someone needs to apply it to `GROUP_DISPLAY` in
  `web/src/lib/marketGroups.ts` — that's the exact file and object.

## What I did not touch (judgment calls, flagged rather than silent)

- **`/ideas` and `/global-ideas`** (115-article creator-inspiration catalog,
  `OriginalIdeasSection.astro`, `GlobalIdeaCard.astro`) still show the old
  "Live events · Private 1:1 · Group sessions" three-format language,
  including baked into raster artwork (`ideas-tape.png`) that
  `check-homepage.mjs` pixel-verifies against a locked source crop. These are
  editorial/inspirational routes, not listing categories, not linked from the
  live homepage or footer, and not named in the brief ("homepage shelves,
  footer links, marketplace filters"). Rewriting them would mean redrawing
  owner-approved artwork and touching a page with heavy pixel-identity test
  coverage — out of scope for this lane on my read of the brief. Flagging in
  case the coordinator wants a follow-up lane for it.
- Did not touch `ListingWizard.tsx` (dashboard listing creation) even though
  it references `find_your_people` — lane 08's brief owns "create-listing
  wizard" for the Flutter app specifically; the web dashboard wizard isn't
  named in either brief. Left as a gap to flag rather than guess ownership.

## Verification

- `npx astro build` — clean build, no errors.
- `node web/scripts/check-homepage.mjs` — passes in full (homepage anchors,
  approved hero, 115 creator-idea articles, sitemap, share metadata).
- `node web/scripts/check-image-coverage.mjs` — passes.
- `node web/scripts/check-image-urls.mjs` — passes.
- `npx tsc --noEmit` in `web/` — pre-existing errors only (astro.config.mjs,
  UPI/QR checkout islands, Countdown.tsx aria-live typing, a browser test
  spec); none in any file this lane touched.
- Did not start a dev server or open a browser (no chrome-devtools/browser
  tool available in this session); verification is build + static-check
  based only, per HARD RULE 6 I curled nothing live since there's no running
  origin here — the `check-homepage.mjs` assertions are the closest
  equivalent available in this worktree and they pass against the built
  `dist/`.

## Honest gaps

1. Group heading marketing copy (`GROUP_DISPLAY` labels/eyebrows/titles) not
   updated — waiting on lane 01's proposed headings (see above).
2. Non-English translations for the 3 new i18n keys not generated (needs a
   paid CI step I can't run from here).
3. `/ideas` and `/global-ideas` catalogs still use pre-Saathum three-format
   language; left alone as out-of-brief (see above).
4. Did not verify in a live browser/dev server — build- and script-level
   checks only.
