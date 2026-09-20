# REPORT — Merge origin/main into saathum/int

Merged `origin/main` (29 commits ahead at merge-base `76003bb2`, the WEB-GATEWAY
text-only/anti-companionship copy pass + the creator-pivot homepage rewrite)
into `saathum/int`. Followed the owner's resolution policy: main's newer,
approved COPY wins on pure content files; taxonomy is a superset merge;
`listings.ts` is a real three-way merge; generated mirrors were regenerated,
never hand-edited.

## Conflicted files (24) — resolution and why

### Taxonomy / generated mirrors
- **`Specs/listing-taxonomy.json`** — took OURS (Saathum's 49-category
  superset) as base, then added main's 5 new `group_classes` categories
  (`group_language_practice`, `group_fitness_batch`, `group_exam_revision`,
  `group_music_class`, `group_cooking_class`) that ours lacked — main's
  `worker/src/lib/listing_section.ts` already routes these to a `group_classes`
  section and auto-merged cleanly, so the taxonomy needed the matching entries
  or the worker would reference categories the JSON doesn't declare. Marked
  all 5 `hidden: true` (group classes aren't in Saathum's keep-list) and added
  `group_classes` to `find_your_people`'s `sections` array. **Deliberately did
  NOT carry over** main's `_hidden_sections.astro_tarot` entry (main hid
  astrology from public marketing pre-Saathum; SPEC.md explicitly keeps
  Astrologers for Saathum, so resurrecting that hide would be wrong).
- **`app/lib/core/listing_groups.dart`**, **`web/src/lib/listingTaxonomy.ts`**
  — regenerated via `python3 scripts/gen_listing_taxonomy.py` from the
  resolved JSON, never hand-edited. `--check` confirms both are up to date.

### `worker/src/routes/listings.ts` — real three-way merge
One conflict hunk in `CARD_SELECT`: HEAD added `l.performed_by,
l.facilitated_by, l.at_temple`, main added `l.is_example`. Kept both column
lists. Verified every other touch point for each feature
(`shapeCard`'s JSON output, insert/update paths, `is_example` guards in the
booking/expiry code, `listing_blockers` integration) had already auto-merged
cleanly outside this one hunk — confirmed by grepping the whole file for both
field sets post-merge. `npx tsc --noEmit` in `worker/` is clean.

### `web/src/lib/org.ts`
Main made no factual change to `description`/`slogan`/`foundersDescription`
(byte-identical to the merge-base) — took OURS wholesale, including the
Saathum devotional-services description and "Apna hunar. Apni kamaai." slogan.

### `web/scripts/check-homepage.mjs`
Kept the domain assertions on `saathum.com` (ours) but updated the og:title/
og:description literal-string assertions to match main's new homepage copy,
brand-renamed (`Saathum: paid live streams and 1:1 video calls...`). Passes.

### Pure copy/content files — took MAIN wholesale, reapplied ONLY the brand rename
`shared/i18n/source/{web-about,web-auth,web-common,web-landing}.json`,
`web/src/components/{LegalStatus,SiteFooter,india-preview/BookingExpressIllustrated}.astro`,
`web/src/content/help/{booking-and-paying/find-a-creator-or-show,creators/create-a-listing,getting-started/create-your-account,getting-started/web-vs-app}.md`,
`web/src/layouts/Base.astro` *(see exception below)*,
`web/src/pages/{about,careers,index,india-next,landing-steps-preview,sign-in,sign-up}.astro`.

Rename rules replicated from the `[SAATHUM-BRAND-1]` commit: `avaTOK`/
`AvaTOK`/`Avatok`/`AvaTok` → `Saathum`, `AVATOK` → `SAATHUM`, bare
`avatok.ai` → `saathum.com`, "an Saathum" → "a Saathum" (article fix).
Protected verbatim and left unrenamed: `@avatok.ai` emails (`support@`,
`hello@`, `privacy@`), `api.avatok.ai`/`blossom.avatok.ai`, the
`avatok-creator-constellation.png` asset filename, the `how-avatok-works` DOM
anchor id (also asserted literally by `check-homepage.mjs`), and the
two-span `<span>ava</span><span>TOK</span>` logo treatment (matches the
`[SAATHUM-BRAND-1]` report's own documented gap — the logo artwork itself is
still avaTOK's, unrenamed on purpose). All verified byte-for-byte preserved
after the rename script ran.

One real bug caught by `check-help.mjs` and fixed: the rename script
mechanically turned the *route slug* `/help/getting-started/what-is-avatok`
into `/help/getting-started/what-is-Saathum` inside `web-vs-app.md`'s link —
the file's own path was never renamed (routing/redirect decision, out of
scope, matches `[SAATHUM-BRAND-1]`'s own precedent), so the link broke.
Fixed the one occurrence; re-ran `check-help.mjs` clean.

**`Base.astro`** doesn't match the copy-file globs (it's a layout, not a
page/component), but the conflict there was HEAD's dynamic
`` `${ORG.name}, ...` `` keywords template vs. main's hardcoded literal
`'avaTOK, ...'` string. Kept HEAD — it's strictly better (auto-correct on any
future rename) and main added nothing else in that hunk.

### Judgment-call exceptions — kept OURS instead of main, with reasoning
- **`web/src/components/EntityFaq.astro`** — main's version is still the
  original `[WEB-SEO-6]` "not to be confused with avatok.tech / an avatar app"
  disambiguation block. That premise doesn't transfer to Saathum (no known
  name collision), which is exactly why `[SAATHUM-BRAND-1]` already rewrote
  this file as a plain entity definition sourced from `ORG`. Mechanically
  renaming main's version would have shipped an FAQ asking "Is Saathum the
  same as Avatok industrial conductors?" — nonsensical. Kept HEAD's rewrite.
- **`web/src/content/help/getting-started/what-is-avatok.md`** — same
  reasoning; this file mirrors EntityFaq's disambiguation content and had
  already been rewritten for Saathum. Kept HEAD.

## Auto-merged files that still needed the brand rename reapplied

Three files matched the "pure copy" spirit of the policy but auto-merged
without a conflict marker (only one side had touched them since merge-base),
so they silently carried main's unrenamed text into the working tree:
- `shared/i18n/source/landing.json` (auto-took main's creator-pivot ideas
  copy — ours never touched this file)
- `web/src/lib/indiaLandingSource.ts` (the hardcoded India-landing fallback
  dictionary — same content family as `landing.json`; left unrenamed it would
  have reproduced the exact hydration-mismatch failure mode in project memory
  `web-i18n-catalog-overrides-markup.md`)
- `web/scripts/check-render-performance.mjs` — not a copy file, but its
  literal-string assertion (`assert.match(html, /Turn your skill/)`) was
  stale against an intermediate main state; updated to match the actual
  shipped homepage h1 (`/Your audience is ready/`).

Ran the rename script over all three; `check-render-performance.mjs` now
passes.

## Not touched — flagged, not fixed (out of scope for this merge)

1. **Founder-composition claims are now inconsistent across the site.**
   Main's WEB-GATEWAY-RESTORE-TEXT pass deliberately scrubbed "founded by
   American and Indian founders" / "three friends in India" from
   `LegalStatus.astro`, `EntityFaq.astro` (main's side), `careers.astro`, and
   `what-is-avatok.md` (main's side) — and fixed a real error along the way
   (`about.astro` on main dropped the fictitious "Ave Maria International Pvt
   Ltd" Indian-entity name that OUR `about.astro` still had pre-merge; now
   fixed by taking main's `about.astro`). But `web/src/lib/org.ts`'s
   `description` (kept OURS, no factual change from main to carry per the
   merge policy) and `EntityFaq.astro`/`what-is-avatok.md` (kept OURS, for
   the disambiguation reasons above) still say "built by American and Indian
   founders" / "founded by three friends in India". Owner should decide
   whether to scrub that framing from the remaining Saathum-authored files too.
2. **Two homepage/help surfaces link to a group that's now entirely hidden.**
   `web/src/components/india-preview/BookingExpressIllustrated.astro`'s third
   format tile ("Group live sessions") and
   `help/booking-and-paying/find-a-creator-or-show.md`'s "Group Classes"
   group description both point at `?group=find_your_people` — which, after
   the taxonomy merge above, has zero visible categories under Saathum (all
   12 companionship categories + the 5 new group-class categories are
   hidden). Left as-is since fixing it means writing new copy, outside a
   brand-rename/merge task — flagging so the owner can decide whether to
   repoint or remove that tile.
3. **Pre-existing, out-of-scope `avaTOK` residue**, confirmed unchanged by
   this merge (present on `saathum/int` before I started, and not touched by
   any `origin/main` commit): `worker/src/routes/commercial_lifecycle.ts`
   ("is back in your avaTOK wallet.", "Open AvaTOK to see the new time."),
   `worker/src/routes/pay.ts`'s `WEB_BASE_URL` fallback
   (`https://avatok.ai`), `worker/src/routes/listings.ts:199`'s
   `"an AvaTOK creator"` fallback, `web/src/lib/copy.ts`,
   `web/src/lib/i18n/localeStore.ts`'s `avatok.ui.locale.*` storage-key
   prefix. `worker/src/routes/config.ts`'s many `AvaTOK`/`avatok` comments and
   identifiers were also left alone — `[SAATHUM-BRAND-1]`'s own report
   explicitly excluded `config.ts` from the brand sweep. None of these are
   merge regressions; `[SAATHUM-BRAND-1]`'s report already flagged its sweep
   as non-exhaustive for exactly this class of file.

## Verification performed

- `python3 scripts/gen_listing_taxonomy.py --check` — both mirrors up to date.
- `cd web && npm install --include=dev && npm run build` — clean, zero errors.
- `node scripts/check-homepage.mjs` — passes (homepage anchors, artwork,
  109 creator-idea articles, sharing metadata, canonical/og on saathum.com).
- `node scripts/check-help.mjs` — passes (21 pages, 20 articles, all
  `/help`/`/help#`/`/#anchor` links resolve, FAQPage/BreadcrumbList checks).
- `node scripts/check-render-performance.mjs` — passes (after the h1 literal
  fix above).
- `node scripts/check-image-coverage.mjs`, `node scripts/check-image-urls.mjs`
  — both pass.
- `cd worker && npm install --include=dev && npm run typecheck` — clean,
  zero errors.
- `python3 tool/check_ship_readiness.py --check flags` — OK, 0 gaps.
- `python3 tool/check_design_guard.py --check all` — OK, within baseline.
- Scripted grep sweep of every file in the merge diff for residual `avatok`
  mentions, cross-checked each hit against the exception categories above
  (infra hostnames, emails, wire identifiers, asset filenames, DOM ids,
  pre-existing out-of-scope content) — no unexplained hit remains.
- Confirmed zero `<<<<<<<`/`=======`/`>>>>>>>` conflict markers remain
  anywhere in the tree.

## Not done

- Did not touch `web/src/generated/` (per hard rule).
- Did not rename `api.avatok.ai`, `blossom.avatok.ai`, or any `@avatok.ai`
  mailbox (per hard rule) — spot-checked every occurrence above.
- Did not push. This is a local merge commit on `saathum/int` in this
  worktree only.
