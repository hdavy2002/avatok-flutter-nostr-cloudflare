# Lane 01-taxonomy — REPORT

Scope: `Specs/listing-taxonomy.json`, the taxonomy generator, the generated
mirrors (via regeneration only), the D1 taxonomy row migration. Branch
`saathum/01-taxonomy`, worktree
`/Users/davy/.cache/deepastra/saathum-20260920/01-taxonomy`.

## What changed

### 1. Per-category hide mechanism (new)

Added a `hidden` field to categories, mirroring the existing `_hidden_sections`
pattern for shelves:

- `Specs/listing-taxonomy.json` — categories being hidden now carry
  `"hidden": true` plus a `_note` explaining why (tag `[SAATHUM-TAXONOMY-1
  2026-09-20]`).
- `scripts/gen_listing_taxonomy.py` — emits `hidden?: boolean` on the TS
  `SubCategory` interface and `final bool hidden` (default `false`) on the
  Dart `ListingSubCategory` class, and filters it out of `subCategoriesFor` /
  `listingSubCategoriesForGroup` (the picker/blip lists). The id still
  resolves through the unfiltered `SUB_CATEGORIES` / `kListingSubCategories`
  arrays (via `groupForCategory` / `listingSubCategoryById` /
  `listingCategoryLabel`), so an existing listing filed under a hidden
  category still renders its label and group correctly — exactly the
  `HIDDEN_SECTIONS` precedent ("stays alive because published rows carry it").

**Note on prior art**: while implementing this I found an *unrelated,
unmerged* branch (`webgw/int`, commit `a42f2a41`, dated 2026-09-19 — one day
before this task, not on `main`, not part of this batch) that had already
built the identical mechanism for a different reason (a payment-gateway
review pass, "WEB-GATEWAY-FIX5"). I did not merge or depend on that branch —
it's a separate initiative with different category choices (it also renamed
the group headings and repurposed `find_your_people` into a "Group classes"
section, which Saathum's spec does not want) — but I used it to confirm the
generator patch shape and the D1 migration idiom (`active = 0`, UPDATE-by-id,
`d1_apply_alters.py`-unsafe). Flagging it since a coordinator merging
multiple branches later may hit it.

### 2. Seven new 1:1 categories added to `book_their_time`

`palmistry`, `tarot_reading`, `numerology`, `kundli_matching`, `vastu`,
`pandit_consultation`, `meditation` — sort `411`–`417`, directly after
`astrologers` (`410`).

**Cross-file fix required for these to actually work**: `sectionFor()` in
`worker/src/lib/listing_section.ts` resolves a listing's section from
`(kind, category)`. Any `consult`-kind category not explicitly named falls
through to the generic `"consulting"` section — which Saathum hides (see
below). Without a change, these seven new categories would publish
successfully but be structurally unreachable in the marketplace despite not
being marked `hidden` in the taxonomy. I extended the private
`ASTRO_CATEGORIES` set in that file to include all seven, routing them to the
`astro_tarot` section instead, which Saathum keeps visible. This is the one
file I touched outside my lane's literal file list
(`Specs/listing-taxonomy.json` / generator / generated mirrors / D1
migration); I judged it in-scope because it's a direct, mechanical
consequence of the category list I own, not a UI or flag decision. Flagged
here for visibility — if another lane already claimed this file, please
reconcile.

`SECTION_CATEGORIES` (the map for `live_friends`/`adda_rooms`/`glow_up`) was
left untouched — none of the seven new categories need it.

### 3. Hid every category not in the SPEC.md keep-list

13 categories stay visible, 36 are now `hidden: true`:

- **`india_goes_live`** (5 kept / 10 hidden): kept `live_puja`,
  `live_puja_ritual`, `live_temple`, `live_festival`, `live_satsang`; hid
  `live_cooking`, `live_trek`, `live_music`, `live_dance`, `live_travel`,
  `live_food_walk`, `live_fitness`, `live_sports`, `live_art`,
  `live_everyday`.
- **`find_your_people`** (0 kept / 12 hidden): the whole group, all 12
  companionship categories, per SPEC.md's explicit instruction.
- **`book_their_time`** (1 existing + 7 new kept / 14 hidden): kept
  `astrologers` and added the seven new categories above; hid `teachers`,
  `professors`, `business`, `money_finance`, `career_coach`, `fitness`,
  `wellness`, `music`, `language`, `art`, `glow_up`, `legal_tax`, `tech_help`,
  `services`.

**Count discrepancy vs BRIEFS.md**: BRIEFS.md says "Hide every category not
in the SPEC keep-list (30 of the existing 42)." Counting SPEC.md's explicit
keep-list gives 6 kept existing categories (5 live + 1 astrologers) out of 42,
i.e. **36 hidden**, not 30. I implemented against SPEC.md's explicit named
list (the more authoritative, unambiguous source) rather than BRIEFS.md's
summary count. Verified programmatically — see the checks below. Worth a
second look by the coordinator in case BRIEFS.md's "30" reflects an intent I
mis-read.

### 4. Hid five shelves, kept two

`_hidden_sections` in the JSON now has entries for `live_friends`,
`adda_rooms`, `consulting`, `glow_up`, `ai_voice_agents`, each with a `_note`.
`astro_tarot` and `live_streaming` are untouched (visible). Generated
`HIDDEN_SECTIONS` / `kHiddenListingSections` confirmed to contain exactly
those five.

### 5. Group headings — NOT renamed; proposal only

I did **not** change `heading` / `emphasis` / `blurb` for `india_goes_live` or
`book_their_time` in the JSON. BRIEFS.md's instruction reads "Propose new
headings in REPORT.md; do not invent marketing copy elsewhere" — I read that
as: this lane's deliverable on headings is the proposal below, not a direct
edit, since brand/marketing copy is explicitly lane 10's territory
(`web/src/lib/org.ts` "carries the title suffix... one edit moves the site")
and SPEC.md's brand-rename section is emphatic that brand facts live in one
place. The Dart app (`marketplace_browse.dart`) does render `group.heading`
directly from this JSON with no separate copy layer, so if the coordinator
wants the literal JSON field changed instead of just proposed, that's a
one-line edit to `Specs/listing-taxonomy.json` groups[0] and groups[2].

**Proposal**:

- `india_goes_live` — heading **"India prays live"**, emphasis **"live."**,
  blurb **"Puja, darshan, temple tours and satsang — happening right now,
  streamed to you."**
- `book_their_time` — heading **"Book their time"** (unchanged — it already
  reads correctly for astrology/spiritual-guidance bookings without
  alteration), blurb **"Choose an astrologer or spiritual guide, check their
  calendar and book a private session."**

Note `web/src/lib/marketGroups.ts` (web-only presentation copy: `title`,
`title2`, `eyebrow`, `zone`, `punch`) is a **separate, hand-maintained** file
that only pulls `blurb` from the taxonomy — it is not generated and not owned
by this lane (it reads like lane 09-web-ui's territory). It currently still
says "Find your people" / "Dil ka scene" for the now-fully-hidden group and
"Pawri zone" for the devotional-live group; that copy will need updating by
whichever lane owns it, using this proposal or its own.

### 6. Mirrors regenerated

`python3 scripts/gen_listing_taxonomy.py` — wrote `web/src/lib/listingTaxonomy.ts`
and `app/lib/core/listing_groups.dart`. `--check` confirms both are up to
date (no drift). Neither was hand-edited.

### 7. D1 migration written, NOT run

`worker/migrations/2026-09-20-saathum-taxonomy.sql`:

1. `INSERT OR IGNORE` for the 7 new `book_their_time` rows.
2. Three `UPDATE listing_categories SET active = 0 WHERE id IN (...)`
   statements (grouped by group, 10 + 12 + 14 = 36 ids) — the D1-side
   equivalent of the JSON's `hidden: true`, using the table's existing
   `active` column (already the column `GET /api/explore/categories` and
   `GET /api/marketplace/categories` filter on — no new column needed).

Verified by script that the migration's 36 `active = 0` ids are byte-for-byte
the same set as the JSON's 36 `hidden: true` ids (see Verification below).
File is idempotent (`INSERT OR IGNORE` / `UPDATE`-by-id) and explicitly *not*
compatible with `scripts/d1_apply_alters.py` (documented in the file's
header, matching the precedent in `2026-09-13-cat-puja.sql` and
`2026-09-05-mkt-3group-data.sql`). **Not applied to staging or prod** — per
SPEC.md hard rule 8, deploys/migrations are left to the coordinator.

## Files touched

- `Specs/listing-taxonomy.json`
- `scripts/gen_listing_taxonomy.py`
- `web/src/lib/listingTaxonomy.ts` (generated)
- `app/lib/core/listing_groups.dart` (generated)
- `worker/src/lib/listing_section.ts` (small, necessary addition — see §2)
- `worker/migrations/2026-09-20-saathum-taxonomy.sql` (new, not applied)
- `REPORT.md` (this file)

## Verification

- `python3 scripts/gen_listing_taxonomy.py --check` → both mirrors up to
  date after generation (no stale output).
- Programmatic check: JSON has 49 categories total (42 existing + 7 new), 13
  visible, 36 hidden; `_hidden_sections` has exactly `live_friends`,
  `adda_rooms`, `consulting`, `glow_up`, `ai_voice_agents`.
- Programmatic check: the D1 migration's three `active = 0 WHERE id IN (...)`
  blocks contain exactly the same 36 ids as the JSON's `hidden: true` set —
  no set difference either direction.
- Spot-checked generated TS and Dart output (`grep`) for the `hidden: true`
  field on hidden rows, the 7 new category rows, and the `HIDDEN_SECTIONS`
  / `kHiddenListingSections` set contents. All correct.
- Could **not** run `npx tsc --noEmit` or `dart analyze` — this worktree has
  no `node_modules` (not installed, and `npm install` inside a sandbox is
  forbidden per CLAUDE.md — it strips macOS binaries from the shared
  `node_modules`) and no Flutter/Dart toolchain (deleted repo-wide,
  2026-09-10, per CLAUDE.md — CI is the only compile net now). Reviewed both
  generated files by hand instead; they follow the exact same shape as the
  pre-existing generated output, just with `hidden: true,` appended to
  specific rows and 7 new rows appended to `book_their_time` — low risk of a
  syntax error, but genuinely unverified by a compiler. The coordinator
  should confirm `typecheck.yml` is green on this branch before merging.
- Did not (and could not, per SPEC.md hard rule 8) run the D1 migration or
  query prod/staging state.

## Gaps / things the coordinator should know

1. **Group-heading rename** — proposal only, not applied (see §5). If the
   coordinator wants it applied to the JSON directly, it's a two-field edit
   plus a re-run of the generator.
2. **`web/src/lib/marketGroups.ts`** — separate hand-maintained web copy file,
   not touched (not in this lane's file list), but it still shows
   "Find your people" / "Dil ka scene" copy for the now-empty group and needs
   updating by whichever lane owns web marketplace presentation.
3. **HARD RULE 5 ("hidden in the UI and dark on the server") is only fully
   satisfied once the D1 migration is actually applied.** Until then,
   `GET /api/explore/categories` still returns the 36 categories as
   `active=1` from the live database, so the *server* half of "dark" is
   pending on the coordinator running the migration (deliberately not done by
   this lane). The offline/fallback mirrors (`subCategoriesFor` /
   `listingSubCategoriesForGroup`) are dark now, as is anything that reads
   `hidden` directly off the fetched category list — but I did not find any
   such consumer on `main` today (the one place that does this,
   `web/src/lib/marketGroups.ts`'s `HIDDEN_CATEGORY_IDS` pattern, exists only
   on the unrelated `webgw/int` branch mentioned in §1, not on `main`). Until
   the migration runs AND the consuming UI defends against the "server still
   says active" window, a picker driven purely by the server's live answer
   could still show a hidden category. Worth lane 08/09 checking their
   `blipsForGroup`-equivalent logic against this.
4. **Existing published listings** under now-hidden categories (e.g. any test
   listing filed under `teachers` or `music`) are unaffected in the database —
   `hidden`/`active=0` only stops *new* listings from being filed there and
   removes them from pickers. If any such listings exist and their section
   (`consulting`, in most of these cases) is now hidden, they will also stop
   appearing in marketplace group browsing once the D1 migration runs and the
   relevant caches expire — this is the intended behavior per SPEC.md's
   narrowing, not a bug, but flagging so nobody is surprised.
5. **Count discrepancy** — BRIEFS.md says 30 of 42 hidden; this
   implementation hides 36 of 42, following SPEC.md's explicit keep-list. See
   §3.
