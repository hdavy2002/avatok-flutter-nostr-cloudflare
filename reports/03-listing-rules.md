# Lane 03-listing-rules — REPORT

Scope (BRIEFS.md, lane `03-listing-rules`): own `worker/src/lib/listing_blockers.ts`
and the new listing fields. Block predatory/unsafe content on publish, add
`performed_by`/`at_temple`/`facilitated_by`, enforce server-side on submit AND
publish (never only in the wizard).

## What changed

### 1. Content-policy blockers (`worker/src/lib/listing_blockers.ts`)

Added a new deterministic keyword/phrase scan, `contentPolicyBlockers()`, covering
the five required categories:

- `guaranteed_outcome` — "guaranteed marriage", "100% success", "sure-shot", etc.
- `medical_claim` — "cures cancer", "treats disease", etc.
- `fear_selling` — black magic / curse removal / vashikaran / "danger in your
  chart" / 24-hour remedies, etc.
- `harm_risk` — animal sacrifice, dangerous fire/chemical rituals, a minor
  participating.
- `pressure_tactics` — "act now or", "book now or suffer", etc.

It scans `title`, `blurb`, `description`, and the `attrs` JSON blob (stringified,
so it also catches text inside how-it-works/house-rules/FAQ/sample-Q&A without
needing to enumerate every attrs key). Each match becomes a `ListingBlocker`
pointing at the field it was found in.

**This is a keyword/phrase scan, not an AI classifier — deliberately.**
`listingBlockers()` is documented (and consumed by `listing_review.ts`) as the
layer that "cannot be wrong and cannot be unavailable" because it never makes a
network call; a model call here would make hard-blocking occasionally
unavailable, which is worse than a keyword scan that sometimes misses a clever
phrasing or flags an innocent sentence. This is wired to run for **every**
listing kind (including marketplace `sell`/`buy`/`social`), inserted before the
early-return for marketplace listings — a predatory claim is exactly as much of
a problem there as in a `live_event`.

**Known limitation, stated plainly:** this WILL miss cleverly worded claims and
WILL occasionally false-positive on an innocent sentence containing a listed
phrase (e.g. a Kundli-matching listing that legitimately discusses "matching
charts" is fine, but a listing that says "I guarantee your marriage" is blocked
either way it's worded around "marry/marriage/married/wedding"). Tune the phrase
lists in `CONTENT_POLICY_RULES` as real listings surface gaps — this needs
iteration against real creator copy, which I could not test against (no way to
create/publish real listings from this environment; see Verification below). A
second, AI-based "warn" pass belongs in `routes/listing_review.ts`'s existing
model layer, not here.

### 2. Three new listing fields — `performed_by`, `facilitated_by`, `at_temple`

Migration: `worker/migrations/2026-09-20-listings-performer-fields.sql` (ALTER-only,
idempotent via `scripts/d1_apply_alters.py`, **not executed** — per SPEC.md hard
rule 8 this lane does not run migrations; the coordinator applies it).

- `performed_by TEXT` — free text naming who actually performs the ritual/service
  (e.g. "Pandit Ramesh Sharma", "in-house priest team").
- `facilitated_by TEXT` — free text naming a third party who arranges it, if the
  creator isn't the performer (a partner org, a temple committee).
- `at_temple INTEGER NOT NULL DEFAULT 0` — a plain 0/1 disclosure flag for whether
  this happens at a temple. **Design decision:** I did not duplicate the venue
  name/address — the existing `listings.location` column already carries that;
  `at_temple` only tags what kind of place `location` names. If the coordinator
  wants a temple *name* field instead of/in addition to a boolean, that's a
  one-column follow-up, not a redesign (see "Interpretation calls" below).

Wired end-to-end through the same pattern the existing `blurb`/`credential`
columns use, all in `worker/src/routes/listings.ts` (the only other file this
required touching, since it owns the create/update/read pipeline for every
listing field):
- `listingContentFieldsError()` — length caps (80 chars) on the two free-text
  fields.
- `normFields()` — normalizes/truncates on write.
- `EDITABLE` — creators can PUT these on their own listing.
- `REVIEW_MATERIAL_FIELDS` — changing who performs/facilitates a listing
  post-approval reopens admin review, same as title/price/category do.
- `CARD_SELECT` + `shapeCard()` — the three fields are additive on every card/
  detail read (default `null`/`null`/`false`, so a pre-migration row and a
  legacy client both read exactly as before).
- `createListing`'s INSERT — new row starts with all three unset/false.
- `worker/src/routes/admin_listings.ts`'s `ADMIN_EDITABLE` — a reviewer can also
  fill in/correct these, which is exactly this route's stated use case (fixing
  a listing before/without re-opening review from scratch).

### 3. Publish/submit enforcement

- **Content policy**: `contentPolicyBlockers()` output is folded into
  `listingBlockers()`'s return for every kind (see §1).
- **Performer disclosure**: added a new blocker, `performer_disclosure_required`
  — for `live_event`/`consult` listings, at least one of `performed_by` /
  `facilitated_by` must be non-empty before publish. This is my interpretation
  of the brief's "the listing must say who does what" as a requirement, not
  merely a description of the fields' purpose — see "Interpretation calls"
  below if the coordinator disagrees.

Both are enforced purely by extending `listingBlockers()`, which is already the
**single** function every surface calls — `submitListingForApproval` (submit),
`publishListingAuthoritative` (publish), `listing_review.ts` (wizard's honest
review endpoint, "rules" layer), and both admin-queue reads in
`admin_listings.ts`. I did not touch any of those call sites; adding to the
shared function was sufficient and is the whole point of that file's design
(see its own header comment on why it exists). Confirmed no other route
computes its own ad hoc publish checklist that would bypass this.

## Interpretation calls (flagging for the coordinator)

1. **`at_temple` as boolean, not a temple-name field.** The brief names three
   fields without specifying shape. I judged boolean + reuse of the existing
   `location` column for the actual place name as the minimal, non-duplicative
   design. Easy to revisit.
2. **Performer-disclosure as a hard blocker**, not just descriptive fields. The
   brief's bullet list separates "block on publish: [5 content categories]" from
   "add three listing fields: ... the listing must say who does what" as two
   different bullets. I read the second sentence as normative (a requirement),
   consistent with "the listing must say" rather than "the listing may say", and
   implemented it as a blocker. If this over-reaches lane scope, it is isolated
   to 5 lines in `listing_blockers.ts` (the `performer_disclosure_required`
   block) and easy to remove without touching anything else.
3. **Content-policy scan applies to ALL kinds**, not just live_event/consult.
   The brief's "block on publish" bullet doesn't scope itself to a kind. I
   applied it universally since predatory claims aren't specific to devotional
   listings. If marketplace (`sell`/`buy`/`social`) listings are out of scope
   for Saathum entirely (SPEC.md doesn't explicitly say), this is harmless
   dead code on that path rather than a gap.

## Verification

- **Static review**: read every call site of `listingBlockers`/`blockerResponse`
  (`listings.ts`, `admin_listings.ts`, `listing_review.ts`) to confirm all funnel
  through the one function I edited, and that all use `SELECT *`/`SELECT l.*` so
  the new columns and blockers are visible everywhere without further changes.
- **Typecheck**: no local Flutter/Node toolchain exists in this environment
  (CLAUDE.md — deleted 2026-09-10) and this git worktree has no `node_modules`
  of its own; per SPEC.md hard rule 2 I never ran `npm install`. Instead I
  temporarily symlinked this worktree's `worker/node_modules` to the main
  checkout's existing (already-installed, untouched) `worker/node_modules`,
  read-only, ran `npx tsc --noEmit` (clean, zero errors), then removed the
  symlink immediately after — no shared install state was written or modified.
- **Bind-parameter count**: manually recounted the `createListing` INSERT's
  column list against its `?N` placeholders and `.bind()` argument list after
  adding 3 columns (51 columns total, `status` literal + `created_at`/
  `updated_at` sharing one placeholder `?16` = 49 unique bound placeholders,
  49 bind args) — matches.
- **What I could NOT verify**: I did not run the app or hit a live/staging
  Worker (no deploy, per hard rule 8, and this lane doesn't own `cf.sh`
  deploys). I did not test the regex rules against real creator-written
  listing copy — there is no existing Saathum/devotional listing corpus in
  this repo to test against. The migration was written but **not applied** to
  any database, per SPEC.md hard rule 8 ("do not deploy / leave deploys to the
  coordinator") — the coordinator needs to run
  `python3 scripts/d1_apply_alters.py worker/migrations/2026-09-20-listings-performer-fields.sql --binding DB_META`
  (staging first, then `ALLOW_PROD=1` for prod) before these columns exist on
  any real database; until then, every read of `performed_by`/`facilitated_by`/
  `at_temple` returns `undefined` from D1 (falls back to the `null`/`false`
  defaults in `shapeCard`/`normFields`, so nothing crashes) and the new
  `performer_disclosure_required` blocker will fire on **every** live_event/
  consult publish attempt until the migration lands — this is a hard dependency
  the coordinator must sequence correctly (migration before this code reaches
  production, not after).

## Files touched

- `worker/src/lib/listing_blockers.ts` — content-policy scan + performer
  disclosure blocker.
- `worker/src/routes/listings.ts` — new field validation, normalization,
  EDITABLE/REVIEW_MATERIAL_FIELDS, CARD_SELECT/shapeCard, createListing INSERT.
- `worker/src/routes/admin_listings.ts` — ADMIN_EDITABLE addition only.
- `worker/migrations/2026-09-20-listings-performer-fields.sql` — new, not run.

## Gaps / follow-ups for the coordinator

- Apply the migration (staging, then prod) before this code path is live.
- The keyword lists in `listing_blockers.ts` need iteration against real
  listing copy once creators start writing devotional listings — I could not
  produce or test against that corpus here.
- Lane 04 (policy page) should mirror these same five categories in neutral
  language per its own brief — I did not touch lane 04's files, but the
  category names/wording here (`guaranteed_outcome`, `medical_claim`,
  `fear_selling`, `harm_risk`, `pressure_tactics`) are a reasonable anchor for
  that page to stay in sync with what the server actually enforces.
