# Stream FIX5 report — hide legacy companionship categories; last marketplace Hinglish [WEB-GATEWAY-FIX5]

Branch: `webgw/int`. One commit (listed below). Nothing pushed, nothing deployed, no
`wrangler`/`cf.sh`/`gh workflow` run, no migration applied against any remote target.

## 1. Taxonomy: 12 categories marked `hidden: true`

`Specs/listing-taxonomy.json` — added `"hidden": true` plus a
`_note: "[WEB-GATEWAY-FIX5 2026-09-19] ..."` to the 12 `find_your_people` categories named
in the brief: `listener`, `home_friend`, `late_night_friend`, `quiet_company`, `chat_buddy`,
`walk_talk`, `language_buddy`, `college_friends`, `senior_company`, `queer_friendly`,
`live_friends`, `adda_rooms`. `adda_rooms` keeps its pre-existing `requires_flag:
"conferenceEnabled"` alongside the new `hidden: true` — both gates apply. Nothing else in
the JSON changed.

## 2. Generator: `hidden` field + filtering, both mirrors

`scripts/gen_listing_taxonomy.py`:
- TS `SubCategory` interface gained `hidden?: boolean` (same doc-comment style as
  `requiresFlag`).
- Dart `ListingSubCategory` gained `final bool hidden;` with constructor default
  `this.hidden = false` (mirrors how `requiresFlag` is nullable-optional, but per the
  brief this one defaults `false` instead of being nullable).
- Both category-list renderers emit `hidden: true,` on a category only when
  `c.get("hidden")` is truthy — same conditional-suffix pattern as `requires_flag` →
  `requiresFlag`.
- `subCategoriesFor` (TS) and `listingSubCategoriesForGroup` (Dart) both added
  `&& !c.hidden` / `&& !c.hidden` to their filter predicate, so a hidden category is
  excluded from the picker/chip list in both languages. The unfiltered lookups
  (`SUB_CATEGORIES.find`, `groupForCategory`, `listingSubCategoryById`,
  `listingCategoryLabel`) were **not** touched — they still resolve a hidden id, which is
  what keeps an existing listing's label printing on its card/detail page.

Ran `python3 scripts/gen_listing_taxonomy.py` then `--check` (exit 0, "up to date" for both
mirrors). Generated diffs reviewed by hand (no local Flutter toolchain, so this is the only
check before CI sees it):
- `app/lib/core/listing_groups.dart`: new field + doc comment on `ListingSubCategory`, new
  constructor param with `= false` default, `hidden: true,` appended to 12
  `ListingSubCategory(...)` literals (trailing comma before `)`, valid Dart), and the
  `!c.hidden` filter added to `listingSubCategoriesForGroup`. No other lines changed.
- `web/src/lib/listingTaxonomy.ts`: same shape — new optional interface field, `hidden:
  true,` on the same 12 object literals, `!c.hidden` added to `subCategoriesFor`.

A pre-existing `SyntaxWarning: "\s" is an invalid escape sequence` from the script's own
`.split(RegExp(r'[_\s]+'))` line (inside the Dart-source triple-quoted Python string, line
~324) prints on every run — not introduced by this stream, not touched by this stream's
edits, and does not affect the exit code or output.

## 3. Web: pickers/chips exclude hidden; display still resolves them

- `web/src/lib/marketGroups.ts` `blipsForGroup`: the STATIC-MIRROR FALLBACK path
  (`subCategoriesFor(group)`) now excludes hidden categories automatically, since
  `subCategoriesFor` itself filters them (item 2). That alone was not enough — see the
  "what the brief didn't anticipate" note below — so I also added a
  `HIDDEN_CATEGORY_IDS` set (computed from the full, unfiltered `SUB_CATEGORIES` mirror)
  and excluded it from the **server-returned** category list too
  (`categories.filter((c) => c.group_id === group && !gated.has(c.id) &&
  !HIDDEN_CATEGORY_IDS.has(c.id))`).
- `web/src/islands/dashboard/listing-form/steps.tsx` `categoryLabel` — confirmed
  unchanged and still correct: it calls `SUB_CATEGORIES.find(...)` directly (not
  `subCategoriesFor`), so a hidden category's label still resolves for an existing
  listing's summary row. No edit needed here.
- `web/src/lib/listingTaxonomy.ts` `groupForCategory` and the Dart
  `listingSubCategoryById`/`listingCategoryLabel`/`listingGroupForCategory` — same story,
  all iterate the unfiltered list. Verified by reading the generated output; not
  edited beyond the generator change in item 2.
- Grepped `ExploreGrid.tsx`, `SearchBox.tsx`, `BazaarSearchStrip.astro`,
  `MarketplaceBrowse.astro`, `VerticalSection.tsx`, `FilterRail.tsx` in full for any other
  Hinglish literal in rendered text (see item 4). `SearchBox.tsx`, `BazaarSearchStrip.astro`
  and `MarketplaceBrowse.astro` had none — all already English.

### What the brief didn't anticipate: production still serves these as active

The brief's "Do" item 3 only asked to fix the **fallback** path of `blipsForGroup`, on the
assumption the server's `GET /api/explore/categories` would already reflect the D1 change.
But the brief also forbids applying the migration, and I confirmed live prod still returns
these 12 ids as active (`curl https://api.avatok.ai/api/explore/categories` — `listener`,
`home_friend`, `chat_buddy` etc. all present with `group_id: "find_your_people"`, no
`active` field to check because the endpoint only ever returns active rows). Since the
brief's own verify step curls a local dev server that talks to the live prod API
(`PUBLIC_API_BASE=https://api.avatok.ai`) and requires **zero** matches for these labels,
the fallback-only fix would not have passed that verify — the picker would still show them
whenever the server categories fetch succeeds (which it does, since prod is reachable).
Fixed by also stripping `HIDDEN_CATEGORY_IDS` out of the server-sourced list in
`blipsForGroup` (see above). This is a superset of what the brief asked for, not a
narrower or different behaviour — once the migration in item 5 is applied, the server
will stop sending these ids at all and this extra filter becomes a no-op (harmless to
leave in place).

## 4. Marketplace Hinglish

Explicit literals from the brief:
- `web/src/islands/marketplace/VerticalSection.tsx`: `source="Sab"` → `source="All"`
  (the "all" chip in a group's blip row); `source="· Sab haazir"` → `source="· all shown"`
  (the "Showing N of M" line); also updated a stale doc-comment on line 31 that quoted the
  old `"Sab"` string.
- `web/src/islands/marketplace/FilterRail.tsx`: `PRICE_BANDS` entry `label: 'Sab'` →
  `label: 'All'`.

Additional Hinglish found by grepping the six named files' full rendered text (not just the
three literals called out):
- `FilterRail.tsx` line 173 and `ExploreGrid.tsx` line 348 both render the same i18n id
  (`web-marketplace.178eae80f69580f8`) with `source="Sab hatao"` (the "clear all filters"
  button, shown only while `narrowed`/`appliedCount > 0`) → `source="Clear all"` in both
  places. Also renamed the doc-comment "drives SAB HATAO" → "drives the CLEAR ALL button".
- `FilterRail.tsx` line 229: the "clear the date filter" button, `source="Koi bhi din"` →
  `source="Any day"`.
- `ExploreGrid.tsx` line 352: the count badge template
  `"{value0} {value1} · Pura bazaar"` → `"{value0} {value1} · full bazaar"` (kept "bazaar"
  — it's used as an accepted English loanword throughout this codebase's UI copy and
  comments, e.g. "Bazaar", "Loading the bazaar…", and is not on COMMON's banned-word list;
  only the Hindi word "Pura" needed translating).

Per the FIX1 precedent (`Specs/WEBGW-FIX1-REPORT.md` item 1, and its brief's explicit "Do
not regenerate or edit the shared/i18n catalogs"), `shared/i18n/source/web-marketplace.json`
was **not** touched. I confirmed why that's safe by reading `localeStore.ts`'s `t()`:
`messages[key] ?? (fallback || (sources[key] ?? ''))` — with locale forced to `en`
site-wide ([WEB-GATEWAY-A]), `messages` is always empty, so the live inline `source=` prop
always wins over the (now further-stale) catalog file. The catalog still has old Hindi text
under these same keys (`"Sab hatao"`, `"Sab"`, `"Koi bhi din"`, `"· Sab haazir"`), but it is
provably dead data — never served.

Files NOT touched, and why:
- `web/src/islands/live-gs/LiveGsViewer.tsx` (has its own Hinglish, "Sab spots bhar gaye —
  koi buy zaroori nahi tha.") — out of the brief's explicit file list (live-streaming
  surface, not marketplace/taxonomy); left for whichever stream owns that surface.
- `web/src/landing/avatok-listings-catalogue.html` and its
  `archive/2026-09-09-before-railway/` copy — a static landing snapshot outside the
  brief's file list; the archive copy in particular is explicitly historical.

## 5. Worker migration (added, NOT applied)

`worker/migrations/2026-09-19-webgw-hide-companionship-categories.sql`: `UPDATE
listing_categories SET active = 0 WHERE id IN (...)` for the 10 ids the brief listed
(`live_friends`/`adda_rooms` excluded — already set `active = 0` by the pre-existing,
also-unapplied `2026-09-18-webgw-taxonomy.sql`). Header comment follows that file's style:
DB target, apply-after ordering, the `d1_apply_alters.py` warning (it only scans
`ALTER TABLE ... ADD COLUMN`, would silently skip this UPDATE), the exact
`wrangler d1 execute` / `cf.sh` apply commands, and an explicit "NOT applied by this
change" note. Idempotent (UPDATE-by-id).

## 6. Verify — exact output

### web/ (from a build after all web changes)

```
$ PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build
...
[build] Server built in 8.42s
[build] Complete!

$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors, calculator,
anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.

$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB), 21 built
pages + 4 policy pages checked (20 articles), all /help, /help#, and /#anchor links resolved,
no placeholder text, FAQPage present once, BreadcrumbList present once per article, 36
/help/art image refs OK, 349 JS chunks checked for rem-based rootMargin, 63 help-page CSS
files checked for undefined custom properties.

$ node scripts/check-performance.mjs
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser
measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks,
private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed

$ node scripts/check-image-urls.mjs
Image URL origin, privacy, idempotence and bounded variant checks passed
```

### SSR check (`astro dev --port 4327`, against the live prod API)

```
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:4327/marketplace   -> 200
```

Fetched `/marketplace`, HTML-entity-decoded, and grepped case-insensitively with word
boundaries for the brief's exact list:

```
$ python3 -c "... re.findall(r'\b(Listener|Home friend|Late-night|Quiet company|Chat buddy|
  Walk & talk|Language buddy|College circle|Senior company|Queer-friendly|Live friends|Sab)
  \b|haazir', decoded, re.I)"
[]
```

(A naive non-word-boundary grep for `Sab\b|haazir` etc. on the raw, non-decoded HTML
initially showed 6 hits of the substring "Listener" — these were false positives from the
Astro hydration runtime's own minified JS, which contains `addEventListener` /
`removeEventListener` /`childrenConnectedCallback`-style identifiers containing "Listener"
as a substring. Re-checked with `\bListener\b` word-boundary matching: 0 hits.)

Confirmed the Group classes chip row is exactly the 5 expected labels, in order, decoding
`&amp;` first (a plain literal-`&` grep undercounts because the SSR output HTML-escapes
the ampersand in "Fitness & yoga batch"):

```
All · 🗣️ Language practice · 🧘 Fitness & yoga batch · 📖 Exam revision · 🎵 Music class · 🍳 Cooking class
```

Cross-checked against live prod (`curl https://api.avatok.ai/api/explore/categories`) that
`listener`/`home_friend`/`chat_buddy` etc. are still returned as active today (migration
correctly not applied) — this is exactly why the `HIDDEN_CATEGORY_IDS` addition in item 3
was necessary for the chip row to actually come out clean against a real backend, not just
against the offline mirror.

### Repo root

```
$ python3 scripts/gen_listing_taxonomy.py --check
up to date: web/src/lib/listingTaxonomy.ts
up to date: app/lib/core/listing_groups.dart
```

### worker/

```
$ NODE_ENV=development npx tsc --noEmit
(no output — clean; worker/src is untouched, the migration is SQL only)
```

## Files changed

- `Specs/listing-taxonomy.json`
- `scripts/gen_listing_taxonomy.py`
- `web/src/lib/listingTaxonomy.ts` (generated)
- `app/lib/core/listing_groups.dart` (generated)
- `web/src/lib/marketGroups.ts`
- `web/src/islands/marketplace/VerticalSection.tsx`
- `web/src/islands/marketplace/FilterRail.tsx`
- `web/src/islands/marketplace/ExploreGrid.tsx`
- `worker/migrations/2026-09-19-webgw-hide-companionship-categories.sql` (new, not applied)

## Commit

```
a42f2a41 [WEB-GATEWAY-FIX5] Hide legacy companionship categories from pickers and chips; marketplace Hinglish
```

## Things I could not do / left as-is

- **Applying the migration** — not run, per the hard rule. Until it's applied (after
  `2026-09-18-webgw-taxonomy.sql`, same DB_META), production's
  `GET /api/explore/categories` keeps returning these 10 ids as active; the client-side
  `HIDDEN_CATEGORY_IDS` filter in item 3 covers the picker/chip UI in the meantime, but
  any other consumer of that endpoint (the Flutter app's own picker, a third-party
  integration) is not covered by a web-only fix.
- **`LiveGsViewer.tsx` and the landing-page HTML's Hinglish** — left untouched, out of this
  brief's explicit file scope (see item 4).
- Everything else in the brief was completed as specified.
