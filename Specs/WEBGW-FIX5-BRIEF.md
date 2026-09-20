# Stream FIX5: hide the legacy companionship categories; last marketplace Hinglish  (tag [WEB-GATEWAY-FIX5])

Worktree /Users/davy/.cache/deepastra/webgw-20260918/int, branch `webgw/int`. Read Specs/WEBGW-COMMON.md
and the "Taxonomy" section of Specs/WEBGW-INT-REPORT.md. You MAY edit Specs/listing-taxonomy.json,
scripts/gen_listing_taxonomy.py, web/, and ADD (not apply) a worker migration. Never hand-edit the
generated mirrors (web/src/lib/listingTaxonomy.ts, app/lib/core/listing_groups.dart) — regenerate them.
Never push, deploy, or run wrangler/cf.sh/gh workflow. Do not rename group slugs or category ids.

## Why

On the live marketplace (https://avatok.ai/marketplace) the "Group classes" chip row reads:
"Listener · Home friend · Late-night friend · Quiet company · Chat buddy · Walk & talk · Language buddy ·
College circle · Senior company · Queer-friendly space · Live friends · Language practice · Fitness & yoga
batch · Exam revision · Music class · Cooking class". The first eleven are the `find_your_people`
categories that predate Stream F (`listener`, `home_friend`, `late_night_friend`, `quiet_company`,
`chat_buddy`, `walk_talk`, `language_buddy`, `college_friends`, `senior_company`, `queer_friendly`,
plus the already-hidden-section `live_friends`/`adda_rooms`). They are the paid-companionship framing the
whole exercise exists to remove; the coordinator has decided to hide them from every public surface
(reversible: they stay in the JSON and D1, just flagged hidden / inactive; existing listings keep them).

Chips come from two places: SSR/first paint uses the static mirror `subCategoriesFor('find_your_people')`
(web/src/lib/listingTaxonomy.ts, used by web/src/lib/marketGroups.ts `blipsForGroup` fallback and by the
listing wizard's steps.tsx); after hydration `GET /api/explore/categories` (active=1 rows) replaces it.

## Do

1. `Specs/listing-taxonomy.json`: add `"hidden": true` and a `_note` ("[WEB-GATEWAY-FIX5 2026-09-19] …")
   to those 12 category objects (`listener`, `home_friend`, `late_night_friend`, `quiet_company`,
   `chat_buddy`, `walk_talk`, `language_buddy`, `college_friends`, `senior_company`, `queer_friendly`,
   `live_friends`, `adda_rooms`). Nothing else in the JSON changes.
2. `scripts/gen_listing_taxonomy.py`: emit `hidden: true` on those entries in BOTH mirrors (TS
   `SubCategory` gets an optional `hidden?: boolean`; Dart gets the equivalent field with a default of
   false — read the existing Dart template in the script for the exact style), and make BOTH
   `subCategoriesFor(...)` helpers exclude hidden entries. Follow the file's existing conventions
   exactly (the same way `requires_flag` → `requiresFlag` is done). Run
   `python3 scripts/gen_listing_taxonomy.py` then `--check`; commit the regenerated TS and Dart.
   Read the generated Dart diff carefully — there is no local Flutter toolchain; a Dart syntax slip is
   only caught by CI 40–80 minutes later. Keep the Dart change minimal and mirror an existing field.
3. Check the web: `web/src/lib/marketGroups.ts blipsForGroup` — when the server categories are present
   it uses them; when not, the fallback now excludes hidden. Also ensure `SUB_CATEGORIES.find(...)`
   label lookups elsewhere (grep `SUB_CATEGORIES`) still resolve hidden ids for DISPLAY of an existing
   listing's category (a hidden category must still print its label on a card/detail page — only the
   pickers/chips hide it).
4. Add `worker/migrations/2026-09-19-webgw-hide-companionship-categories.sql` (DB_META, NOT applied):
   `UPDATE listing_categories SET active = 0 WHERE id IN ('listener','home_friend','late_night_friend',
   'quiet_company','chat_buddy','walk_talk','language_buddy','college_friends','senior_company',
   'queer_friendly');` with a header comment in the style of 2026-09-18-webgw-taxonomy.sql (including
   the "do not use d1_apply_alters.py" warning and the exact apply command).
5. Marketplace Hinglish: `web/src/islands/marketplace/VerticalSection.tsx` `source="Sab"` → `"All"`,
   `source="· Sab haazir"` → `"· all shown"`; `web/src/islands/marketplace/FilterRail.tsx`
   `label: 'Sab'` → `'All'`. Grep both files plus ExploreGrid.tsx, SearchBox.tsx, BazaarSearchStrip.astro,
   MarketplaceBrowse.astro for any other Hinglish literal in rendered text and fix it.

## Verify

From web/: `PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build
&& node scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs && node scripts/check-image-urls.mjs`.
`npx astro dev --port 4327`, curl `/marketplace`: the Group classes row must list ONLY Language practice /
Fitness & yoga batch / Exam revision / Music class / Cooking class; zero matches for
`Listener|Home friend|Late-night|Quiet company|Chat buddy|Walk & talk|Language buddy|College circle|Senior company|Queer-friendly|Live friends|Sab\b|haazir`.
Repo root: `python3 scripts/gen_listing_taxonomy.py --check`. Worker: `cd worker && NODE_ENV=development npx tsc --noEmit`
(nothing in worker/src should change; the migration is SQL only).

## Commit and report

`python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX5] Hide legacy companionship categories from pickers and chips; marketplace Hinglish" <paths>`
(fallback: git add -- <paths> && git commit). Write Specs/WEBGW-FIX5-REPORT.md (files, generated diff summary, verify output).
