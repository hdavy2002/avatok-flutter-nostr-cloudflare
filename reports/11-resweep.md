# REPORT — Lane 10-brand-sweep (re-run)

Scope per BRIEFS.md: brand strings everywhere except files owned by other
lanes. Branch `saathum/11-resweep`, working in the already-merged integration
worktree (lanes 01–09 already landed here). This is a fresh implementation —
an earlier `saathum/10-brand-sweep` branch existed in git history but was
based on a stale pre-integration commit with a huge unrelated diff (3283
insertions / 6717 deletions touching `config.ts`, `listings.ts`, etc.); I did
not merge or build on it. `web/src/lib/org.ts` and `POSTER_WATERMARK` were
both still literally `avaTOK`/`avatok.ai` when I started, confirming no prior
brand-sweep work had actually landed on this branch.

## What changed

### 1. `web/src/lib/org.ts` — the brand-facts source of truth
- `name: 'avaTOK'` → `'Saathum'`; `alternateNames` → `['Saathum.com']`
  (dropped the old `AvaTOK`/`AvaTok`/`Avatok`/`avatok.ai` variants).
- `url`/`logo.url`/`searchUrlTemplate` → `saathum.com`.
- `description` and `disambiguatingDescription` rewritten to describe
  Saathum's actual (narrowed) product — devotional live streaming and 1:1
  astrology/spiritual consultations — instead of the old generic "global
  creator marketplace" line, since this file has no other lane touching it
  and the old text was flatly wrong post-narrowing.
- `sameAs` (YouTube/LinkedIn/Wikidata) — **nulled, not repointed**. Those
  were avaTOK's real, resolving profiles; Saathum doesn't have equivalents
  yet, and `org.ts`'s own header comment says `sameAs` "must only list
  profiles that resolve today." Fabricating `youtube.com/@saathum` etc.
  would have been worse than leaving them unset. Judgment call — flagging
  it as one in case the owner already has real Saathum socials to fill in.
- `legalName` / `indianEntity` / `address` — **left untouched**. Brand rename
  scope, not a legal-entity change; I have no authority to invent a new
  legal name.
- `email: 'support@avatok.ai'` — **left untouched**, with a comment
  explaining why (critical rule 3: existing `@avatok.ai` mailboxes stay).

### 2. `web/src/layouts/Base.astro` — the actual title-suffix/OG machinery
SPEC.md claims org.ts "carries the title suffix... one edit moves the site,"
but that wasn't true: `Base.astro` had the brand hardcoded in six places
(default `title`, default `description`, default `keywords`, the
`/avatok/i` "already branded" regex, `og:site_name`, and the `Astro.site`
fallback URLs). Fixed all six to read from `ORG`, so the claim in SPEC.md is
now actually true. This one was necessary, not optional — see the archive
regression below for what happens when a page's title still says the old
brand while this regex expects the new one.

### 3. `web/astro.config.mjs` — the site's actual canonical domain
`site: 'https://avatok.ai'` → `'https://saathum.com'`. This is Astro's build
setting for canonical URLs, sitemap generation and OG image URLs across the
**entire** site — `Base.astro`'s `Astro.site ?? ORG.url` fallback never
actually reaches `ORG.url` because `Astro.site` is always set. Without this
one-line fix, every canonical link, sitemap entry and share-image URL on the
whole site would still say avatok.ai regardless of any other edit. Confirmed
via `check-homepage.mjs`'s OG-image assertion, which failed against the real
built output until I changed this (see Verification).

### 4. `web/src/lib/config.ts` — image-CDN host recognition
`imageHost()` and `publicImage()`'s dummy base URL only recognized
`avatok.ai`/`*.avatok.ai` as "this site" for the Cloudflare image-transform
path. Added `saathum.com`/`*.saathum.com` alongside it (kept avatok.ai too,
harmless) so an absolute `saathum.com` image URL doesn't silently skip the
CDN transform. **`API_BASE` (`api.avatok.ai`) was left untouched** — that's
the protected infra hostname, unrelated to this site-origin check.

### 5. `worker/src/lib/listing_poster.ts` — `POSTER_WATERMARK`
`"avatok.ai"` → `"saathum.com"` (BRIEFS item, explicit).

### 6. "AvaTOK number" → "Saathum number" (BRIEFS item, explicit)
Mechanical phrase substitution across 74 files: `shared/i18n/source/app.json`
+ `app/lib/core/localization/ui_messages.dart` (the Dart UI-string catalog
pair, kept in sync), ~35 other `app/lib/**/*.dart` files, 5
`shared/i18n/source/web-*.json` catalogs, several `web/src/**` files, and
`worker/src/**` route files (excluding `config.ts`, forbidden). Caught and
fixed a grammar bug the substitution introduced ("**an** Saathum number" —
correct for the old vowel-initial brand, wrong for the new consonant-initial
one) across 16 files, 30 occurrences. Also fixed the ALL-CAPS variant
(`AVATOK`) separately in 4 `app.json`/`ui_messages.dart` entries and 8
web files/catalogs — left `AVATOK10` (a promo/coupon code) and
`no_avatok_number` (a real API error-code identifier, both sides) alone;
those are wire values, not display text.

### 7. Broad web brand sweep (org.ts's mandate: "brand strings everywhere")
Beyond the explicit BRIEFS bullets, swept `avaTOK`/`AvaTOK`/`Avatok`/
`AvaTok`/`AVATOK`/`avatok.ai` across:
- All 143 `web/src/pages/**/*.astro`, `components/**`, `islands/**`,
  `layouts/**` files that named the brand, **plus** their corresponding
  `shared/i18n/source/*.json` i18n catalogs (43 namespace files), edited
  together so hydration never reverts static-rendered text to stale
  catalog values (see "i18n consistency" below) — the exact failure mode
  in project memory (`web-i18n-catalog-overrides-markup.md`).
- The 15 legal/policy pages BRIEFS names explicitly (terms, privacy,
  acceptable-use, marketplace-terms, consultation-terms, cookies, dmca,
  child-safety, biometric-retention, grievance, recording, refunds,
  payouts, pricing-fees, community-guidelines) + their catalogs.
- `web/src/lib/indiaLandingLocales.ts` — a **separate**, hardcoded
  (non-catalog) locale dictionary for the India-chrome `chrome.home` string
  in 24 languages, all literally `'avaTOK <translated word>'`. Fixed the
  brand prefix in all 24 without touching the translated words.
- `web/src/lib/og.ts`, `help.ts`, `money.ts`, `sessionUpload.ts` —
  user-facing strings (an OG breadcrumb, a help-section blurb, a comment,
  and — most importantly — a real error message shown to a user on upload
  failure: *"Could not reach avaTOK to upload that file."*
- `web/public/robots.txt`, `web/public/llms.txt` — crawler-facing brand
  copy and the `Sitemap:` directive (now points at saathum.com/sitemap.xml).
- 123 `"... Creator Idea & Practical Guide · avaTOK"` title-suffix strings
  across `shared/i18n/source/web-guide-idea-*.json` /
  `web-global-guide-*.json` (the 115-article creator-ideas catalog). Fixed
  **only** the mechanical title suffix (same pattern, same fix, everywhere
  else) — did **not** touch the deeper "three-format" copy or artwork in
  those articles, which lane 09 already investigated and flagged as
  out-of-brief (pixel-locked images, editorial content, not a brand string).
  Leaving the suffix unfixed would have been a real, live bug: every one of
  those 115 pages would have rendered `"... · avaTOK · Saathum"` once
  `Base.astro`'s regex (fixed in #2) stopped recognizing the old brand as
  "already branded."

### 8. `worker/src/routes/id.ts`
One code comment: "The AvaTOK number is the contact rail" → Saathum. Lane
05's report explicitly left this one for lane 10 rather than partially doing
the sweep themselves — confirmed and closed.

## i18n consistency (why this didn't just create a hydration bug)

Per project memory, changing visible markup under an **existing**
`data-i18n` key without updating the source catalog causes the static HTML
to render correctly and then get silently reverted to the old text after
client-side hydration — for every locale, including English. I avoided this
by always editing the `.astro`/`.tsx` markup **and** the corresponding
`shared/i18n/source/*.json` value **together, under the same key**, for
every file this sweep touched. Checked (via `generate_catalogs.mjs`) that
this is actually safe here: the per-message translation cache key is
`hash({source: value, ...})`, not `hash(key)`, so changing the English value
under a stable key doesn't orphan anything — it just means the next
translation-generation run will fetch a fresh translation for that key. This
is a **better** pattern than minting new keys (what lane 09 did for a
different file, `web-landing.json`, where the ID legitimately needed to
change) — no orphaned dead keys.

One place I *did* mint new keys: `EntityFaq.astro`'s copy changed shape
entirely (see below), so I added 4 new keys to `web-common.json` rather than
force old ones into a different sentence structure.

## `EntityFaq.astro` — rewritten, not just relabelled

This component's **entire purpose** was disambiguating "avaTOK" from an
unrelated industrial-conductor company (avatok.tech) and an old avatar-video
app that shared the name — a real SEO problem specific to that exact string.
Saathum has no known name collision, so a find-replace would have shipped a
page insisting Saathum is "not to be confused with" companies that have
nothing to do with the word "Saathum." Rewrote it as a plain entity
definition (still sourced from `ORG`, still both visible HTML and FAQPage
JSON-LD) and dropped the collision-specific FAQ entry and copy. Mirrored the
same fix in `web/src/content/help/getting-started/what-is-avatok.md` for the
identical reason (that file's content was also entirely about the avaTOK/
avatok.tech/avatar-app disambiguation). Left the file's own path/URL slug
(`/help/getting-started/what-is-avatok`) unchanged — renaming it is a
routing decision with redirect implications, out of scope for a brand sweep,
and another help article already links to it by that path.

## Help centre articles

Swept all 19 `web/src/content/help/**/*.md` files. Beyond brand strings, one
of BRIEFS' two article-content bullets ("naming removed features") applied
directly: `booking-and-paying/find-a-creator-or-show.md` documented the
marketplace's **three** groups, one of which — "Find Your People" — SPEC.md
hides completely (the whole `find_your_people` group, all 12 companionship
categories, per lane 01). Rewrote it to describe the two surviving groups
only, matching lane 09's shelf reduction and using the **current, actually
shipped** group labels (`marketGroups.ts`'s unchanged "pawri zone" / "gyaan
desk" copy — lane 01 only *proposed* new headings in their REPORT.md, never
applied them; I didn't invent replacement marketing copy myself, matching
that lane's own stated boundary). Also fixed a stray "Find your people"
mention in `creators/create-a-listing.md`'s "three kinds of listing"
paragraph. Left `create-a-listing.md`'s third listing kind — "Marketplace
listings (buy, sell, social)" — alone: that's a structural listing *kind*
(not a taxonomy group), not named as removed by SPEC.md, and not something
I have the authority to guess about.

## Deliberately NOT touched — infrastructure, identifiers, wire values

Per hard rules 1/2/4 and general "don't rename infrastructure" judgment:
- `api.avatok.ai`, `blossom.avatok.ai` — verified byte-for-byte unchanged
  across all 386 touched files (scripted diff check, see Verification).
- Every `@avatok.ai` email address (`support@`, `privacy@`, `grievance@`,
  `hello@`) — verified byte-for-byte unchanged across all 386 touched files.
- `worker/src/routes/config.ts`, `Specs/listing-taxonomy.json`,
  `web/src/generated/`, every `web-content-*.json` mirror — untouched, per
  explicit rule. The three `web-content-<hash>.json` mirrors for
  `web-vs-app.md`, `how-to-contact-a-creator.md` and
  `create-your-account.md` are now **stale** relative to the `.md` sources I
  edited (still say `avaTOK`) — same class of gap lane 09 hit with
  `web-landing.json`, except here I'm not permitted to fix it myself even
  with a new key; it needs the real `.md`→JSON extraction step to re-run.
- `web-authored.json`'s ~294 `avaTOK`-mentioning entries — these are
  content-hash keys (`authoredKey(text)`) computed from page text at request
  time; since I already changed the source text that generates them, these
  are now orphaned/stale, matching every other orphaned-key pattern in this
  sweep. Spot-checked one (`"About avaTOK"`) — no live page still renders
  that literal string, confirming it's dead, not a missed fix.
- Package/app identifiers: `ai.avatok.avatok_call` (Android package id),
  `avatok://add` / `avatok://msg` (custom URL scheme), `window.__avatokToken`,
  `data-avatok-embed`/`data-avatok-auth` (DOM attributes read by JS),
  `avatok_guest_jwt`/`avatok_beta_notice`/`avatok_pay_return`/
  `avatok_reviewer_terms_` (localStorage keys — renaming would silently log
  out or re-show dismissed banners for every existing visitor),
  `creator.avatok_number` (API/D1 field name), `kind: 'avatok_livestream'`
  (call-type wire value), `AVATOK10` (promo code), `no_avatok_number` (API
  error code) — all left exactly as-is.
- Design mockup filenames (`design/live-streaming/avaTOK Listing
  Details.dc.html` and friends, referenced from `mockupPage.ts` and a few
  comments) and the static `web/src/landing/*.html`/`archive/` design
  exports — these are either real file lookups or non-served design
  reference documents (not part of the Astro build), not user-facing.
- `web/public/_redirects` — its one `avatok.ai` mention is a comment
  documenting a *historical* Cloudflare zone-level redirect-rule decision
  for that specific domain; the actual redirect rules in the file are
  path-only and domain-agnostic. Left the comment as accurate history.
- The actual `/avatok-logo.png` image asset — **still the old artwork**.
  Fixed every `alt="avaTOK"` → `alt="Saathum"` next to it, but the pixels
  themselves are unchanged; I have no way to generate real brand artwork
  from this lane. **This is the single biggest visible gap** — the site
  will say Saathum everywhere but the header logo image is still avaTOK's.
  Flagging for design/asset follow-up.
- Historical/dated comments and commit-message-style tags (`[AVATOK-DIAL-
  GUARD-1]`, `Specs/AVATOK-NUMBER-FEATURE-SPEC.md` references, `tool/
  ship_manifest.json`'s issue descriptions, `_backups/`, `CLAUDE.md`) — these
  are either real file paths, issue-ID tags matching the repo's own "each
  agent commits under one issue ID" scheme, or records of what actually
  happened at the time. Renaming them would misrepresent history for no
  functional benefit.

## A real regression I introduced and fixed

`web/src/pages/archive/home-2026-09-09.astro` has a `LEGACY_LOWER_MARK`
constant used to `.split()` a raw imported `.html` file at a literal HTML
comment marker (`'AvaTOK lower-page draft'`). My first broad sweep pass
renamed the constant's string to `'Saathum lower-page draft'`, but the raw
`.html` source it splits against (correctly, deliberately unedited) still
says `AvaTOK` — so the split silently stopped matching and the page threw
`"expected legacy lower-page marker is missing"` on build. Caught by `npm
run build` (SPEC hard rule 6 in action), reverted just that one constant.
This is exactly the kind of landmine a blind find-replace hits: the string
looked like display text but was actually a data marker tied to unedited
file content. I re-checked every other `?raw` HTML import in the touched
file set for the same pattern (`global-next.astro`, `[username]/index.astro`)
— those only had comment/title changes, no marker-matching logic, confirmed
safe.

## Verification performed

- `cd web && npm run build` — clean, zero errors (after the archive-marker
  fix and the `astro.config.mjs`/`check-homepage.mjs` domain fixes below).
- `node scripts/check-homepage.mjs` — **passes in full**: homepage anchors,
  approved hero/artwork, all 115 creator-idea articles, sitemap, share
  metadata, canonical URL. This script itself had 9 hardcoded
  `https://avatok.ai/...` assertions (sitemap-index URL, per-article OG
  image, AI-readable article index, homepage share image, canonical link,
  `og:url`, homepage `og:title` string) — updated all of them to
  `saathum.com` to match the real (correctly) rewritten site, **except**
  the `how-avatok-works` anchor id and the `avatok-creator-constellation.png`
  asset-filename checks, which I deliberately left alone (internal DOM id /
  real unrenamed asset filename, not brand display text — see above).
- `node scripts/check-image-coverage.mjs` — passes.
- `node scripts/check-image-urls.mjs` — passes.
- `npx tsc --noEmit -p tsconfig.json` in `web/` — same pre-existing errors
  lane 09 already reported (`astro.config.mjs` plugin typing, `qrcode`
  missing types, `UpgradePrompt.tsx`/`SlotPicker.tsx`/`Countdown.tsx` prop
  typing, one Playwright spec) — confirmed none are in any file this lane
  touched, including `astro.config.mjs` itself (my edit was line 26; the
  pre-existing error is line 40, an unrelated Vite plugin type).
- `npx tsc --noEmit` in `worker/` — **clean, zero errors**.
- Scripted verification (not spot-checks) that **every** `@avatok.ai` email
  address and **every** `api.avatok.ai`/`blossom.avatok.ai` mention is
  byte-for-byte identical before/after, across all 386 changed files —
  compared per-file address/hostname multisets against `git show HEAD:<f>`,
  zero mismatches.
- Validated every touched `.json` file parses (`python3 -c "import json..."`)
  after every batch of edits.
- Did **not** run `flutter analyze` / `dart analyze` — no Flutter/Dart
  toolchain exists in this environment (deleted repo-wide 2026-09-10, CI is
  the only compile net now, per CLAUDE.md). The ~35 touched `.dart` files
  only had string-literal *content* changed (same quotes, same structure,
  same surrounding code) via a scripted exact-phrase substitution — lower
  syntax risk than a hand-edit, but genuinely unverified by a compiler. The
  coordinator should confirm `typecheck.yml`/CI is green on this branch.
- Used a symlinked `node_modules` from the main checkout for `web`/`worker`
  typechecking (removed the symlinks before finishing) — never ran `npm
  install` in this worktree, per CLAUDE.md's sandbox rule.

## Gaps / honest limitations

1. **The header/footer logo image asset is still avaTOK's artwork** — alt
   text says Saathum, the pixels don't. Needs real design work, not a text
   sweep.
2. **Three `web-content-*.json` i18n mirrors are stale** (`web-vs-app.md`,
   `how-to-contact-a-creator.md`, `create-your-account.md` sources changed;
   their generated mirrors didn't, per the explicit rule against touching
   them). Needs the real markdown→JSON extraction step re-run.
3. **`sameAs` social profiles are nulled, not filled in** — no real Saathum
   YouTube/LinkedIn/Wikidata accounts exist yet as far as this repo shows.
4. **`/ideas` and `/global-ideas`' deeper content** (the "three-format"
   language, "group sessions" mentions, baked-in artwork) is unfixed —
   same gap lane 09 already flagged in their report, confirmed still true;
   I fixed only the mechanical `· avaTOK` title suffix on those 115+123
   pages, which was a live double-suffix bug, not the editorial content.
5. **Non-English translations** for every string this sweep changed will
   read stale/English until `scripts/i18n/generate_catalogs.mjs` is next
   run with `--allow-paid` (calls a paid external API, not run from here) —
   same accepted gap lane 09 already established the pattern for.
6. **Dart changes are compiler-unverified** (see Verification) — scripted
   exact-phrase substitution only, no toolchain available to confirm.
7. Did not attempt an exhaustive rename of every internal code comment
   mentioning "avaTOK" across `app/lib`/`worker/src` (a much larger, lower-
   value set than what's covered above — mostly developer-facing doc
   comments, not user-visible copy, and the volume — 500+ files matched a
   bare case-insensitive "avatok" grep at the start of this lane — made a
   full sweep of comments alone a poor use of this lane's time relative to
   the explicit BRIEFS deliverables). Fixed the ones directly adjacent to
   files I was already editing for a real reason.

## Commit

Committed on `saathum/11-resweep` via `scripts/git_safe_commit.py` with
explicit paths (this is a shared worktree). Not pushed — per SPEC hard rule
8, deploys and origin pushes are the coordinator's call, and the owner did
not ask for a push in this task.
