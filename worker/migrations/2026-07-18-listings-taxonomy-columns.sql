-- [AVA-MKT-TAXONOMY-1] listing_categories + listings — the vertical/intent/schema columns.
--
-- GENUINELY NEW SCHEMA. Unlike 2026-07-18-listings-drift-columns.sql (which
-- back-fills 8 columns that already existed in prod BY HAND), none of the 16
-- columns below exist on any database and no code has ever written them.
-- Phase 1 of Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md (§2.0, §2.2,
-- §2.3, §2.4). DB: avatok-meta (DB_META).
--
-- WHY — "there are not many categories with different requirements. There are
-- FIVE INTENTS, and every category is one intent plus a field schema" (plan §2).
-- This is what keeps the marketplace from becoming 60 bespoke screens, and it is
-- what makes "add Boats for sale" a D1 insert instead of a Play release.
--
--   A category row = { vertical, intent, field_schema, agent_playbook,
--                      detail_template, price_semantics } + its version triple.
--   A listing row  = the answers (attrs) + the versions it was BORN with.
--
-- ---------------------------------------------------------------------------
-- WHY `attrs` IS ONE JSON COLUMN AND NOT 40 REAL ONES (plan §2.2)
--
-- Because we need to add categories without a migration or a Play release —
-- which is the entire point of §2. The cost is stated and accepted: `attrs` is
-- NOT queryable by SQL filters. Any field a buyer FILTERS on gets promoted to a
-- real indexed column later, driven by search telemetry rather than guessed at
-- now. If v1 ever needs faceted filtering ("3BHK, under 50L, with parking"),
-- JSON alone will not do it and M-D4 lands `listing_attrs(listing_id, k, v)` as
-- an indexed EAV side table. That is a v2 decision; do not pre-build it.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- NO `contact_phone` COLUMN. NOT AN OVERSIGHT — M-D1, owner, 2026-07-17.
--
-- "Liveness only. No phone, anywhere." Not as a gate, and NOT as a contact field
-- either. The AvaTOK number IS the contact rail — that is the product being
-- promoted, and a phone field would compete with it while re-introducing exactly
-- the PII that `marketplacePrecheck` already strips out of descriptions
-- (marketplace.ts:737). Contact = AvaTOK number (it already hangs off
-- `creator_id`) + Message owner + Talk to my agent. If a future reader is about
-- to add this column: read plan §1.1 first — phone OTP was deleted app-wide on
-- 2026-07-10 because no private company can trace a number to a person in any
-- jurisdiction, so it bought compliance theatre at Twilio cost.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY — MANDATORY READING. SQLite/D1 has NO `ADD COLUMN IF NOT EXISTS`.
--
-- This is the 16-ALTER file, so it is the worst case for the failure mode that
-- created 2026-07-18-listings-drift-columns.sql in the first place:
--   * FRESH / STAGING / PROD (all absent) -> all 16 apply cleanly. Correct.
--   * RE-RUN (all present)                -> the FIRST ALTER fails with
--                                            "duplicate column name: vertical"
--                                            and the other 15 never run. SAFE
--                                            (nothing to change was left
--                                            unchanged) and EXPECTED.
--   * PARTIAL (some present)              -> DANGEROUS with a raw run. It aborts
--                                            at the first duplicate and SILENTLY
--                                            LEAVES THE REST MISSING, which reads
--                                            as "already applied" and turns into
--                                            mystery 500s later.
--
--   PREFERRED (safe on EVERY DB state — PRAGMA-guards each column, applies only
--   what is missing, no-op when complete, and RESUMES a partial application):
--     scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-taxonomy-columns.sql --dry-run
--     scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-taxonomy-columns.sql
--
--   RAW (only for a known-fresh DB; will abort on the first duplicate elsewhere):
--     scripts/cf.sh worker d1 execute DB_META --remote \
--       --file=migrations/2026-07-18-listings-taxonomy-columns.sql
--
-- This file contains ONLY ALTER TABLE ... ADD COLUMN — deliberately. The CREATE
-- TABLEs live in 2026-07-18-marketplace-verticals.sql and the seeds in
-- 2026-07-18-listings-taxonomy-seed.sql, because d1_apply_alters.py parses
-- ALTERs and ONLY ALTERs: mixing a CREATE or an INSERT in here would mean the
-- guarded runner silently skips it while the raw path runs it, i.e. two runners
-- producing two different databases from one file. Keep this file pure.
--
-- Every ALTER below is additive. Nothing DROPs, nothing rewrites data, and every
-- NOT NULL carries a DEFAULT (SQLite rejects NOT NULL ADD COLUMN without one),
-- so existing rows are back-filled by the engine and no row is orphaned.
--
-- Both paths go through scripts/cf.sh, so staging is the default and prod is
-- fail-closed behind ALLOW_PROD=1. Pass the BINDING (DB_META), not a database
-- name — prod is `avatok-meta`, staging is `avatok-meta-staging`.
--
-- Apply order: AFTER 2026-07-18-marketplace-verticals.sql (which creates the
-- vertical rows these columns reference) and AFTER
-- 2026-07-18-listings-content-version.sql (so a fresh DB's column order keeps
-- matching prod's). BEFORE 2026-07-18-listings-taxonomy-seed.sql, which writes
-- into the columns added here and will fail with "no such column" otherwise.
-- ---------------------------------------------------------------------------

-- === listing_categories ====================================================

-- Plan §2.0. DEFAULT 'commerce' is the load-bearing part: the 10 categories
-- already seeded at listings.sql:13-23 land in the commerce vertical with NO
-- update statement at all, which is precisely the "nothing existing changes
-- behaviour" property the two-vertical design is required to have.
ALTER TABLE listing_categories ADD COLUMN vertical TEXT NOT NULL DEFAULT 'commerce';

-- Plan §2. SELL | RENT | BOOK | LEAD | PROFILE. Five intents, and every category
-- is one intent plus a field schema.
--
-- DEFAULT 'SELL' is a MIGRATION ARTEFACT, NOT A STATEMENT ABOUT THE LEGACY ROWS.
-- SQLite requires a default on a NOT NULL ADD COLUMN, and SELL is the majority
-- intent across the new commerce taxonomy. But it is WRONG for all 10 existing
-- rows — nobody "buys" a teacher — and the seed migration corrects them to BOOK.
-- The seed's WHERE clause is what makes that correction safe and one-shot; read
-- its header before touching this default.
ALTER TABLE listing_categories ADD COLUMN intent TEXT NOT NULL DEFAULT 'SELL';

-- JSON, §2.2 shape:
--   { "fields": [ {k, label, type, required, ask, options?, unit?} ],
--     "min_required": [k, ...] }
-- NULL is meaningful and is NOT "unset-and-broken": it means "this category asks
-- no category-specific attrs", which is exactly the behaviour of the 10 legacy
-- consult/live_event rows today. A NULL schema must never start demanding fields
-- of a flow that already works — the mirror image of §2.4's "a schema bump must
-- not orphan data".
ALTER TABLE listing_categories ADD COLUMN field_schema TEXT;

-- JSON. The category-level half of "the listing IS the agent's brief" (plan §0.3).
-- NULL = no agent playbook = the category has no "talk to my agent" behaviour of
-- its own. Connect ships with NULL here permanently in v1 (plan §2.6.6): an AI
-- that chats up a stranger on your behalf, where the other party may not realise
-- they are talking to a bot, is a different product with different consent
-- problems. PROFILE intent, no playbook.
ALTER TABLE listing_categories ADD COLUMN agent_playbook TEXT;

-- 'sell' | 'rent' | 'book' | 'lead' | 'profile'. Which detail-page template
-- renders this category. NULL = the caller's default template.
ALTER TABLE listing_categories ADD COLUMN detail_template TEXT;

-- 'asking' | 'per_month' | 'from' | 'range' | 'none'. What the number in
-- `listings.price` MEANS. Without this the same integer is an asking price, a
-- monthly rent and a starting fee, and the card lies in two of the three cases.
--
-- ALSO THE IDEMPOTENCY LATCH for the seed migration: this column has no DEFAULT,
-- so it is NULL on every pre-existing row until the seed writes it exactly once.
-- That is deliberate — see 2026-07-18-listings-taxonomy-seed.sql.
ALTER TABLE listing_categories ADD COLUMN price_semantics TEXT;

-- Plan §2.4 — the version triple. Three separate clocks because the three things
-- change independently: a field can be added without touching the playbook, and
-- a template can be restyled without either.
ALTER TABLE listing_categories ADD COLUMN cat_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE listing_categories ADD COLUMN playbook_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE listing_categories ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1;

-- === listings ==============================================================

-- Plan §2.0. Same DEFAULT 'commerce' reasoning as listing_categories: every
-- existing listing back-fills into the commerce vertical, so `vertical` can be a
-- filter on every browse/search/favourites/My-Listings query from day one with
-- no data migration. The cross-vertical rule (§2.0) is absolute: a listing never
-- crosses. A Connect profile surfacing in a commerce search is not a preference
-- violation, it is a §2.6 safety violation.
ALTER TABLE listings ADD COLUMN vertical TEXT NOT NULL DEFAULT 'commerce';

-- JSON — the per-listing answers, validated against the category's field_schema
-- at its PINNED cat_version. One column, not 40. See the header block.
ALTER TABLE listings ADD COLUMN attrs TEXT;

-- YouTube only (plan §2.2). Deliberately NOT a second media pipeline: cover_media
-- already carries R2-hosted image/video, and a URL column costs nothing while an
-- upload path costs moderation, storage quota and a CSAM surface.
ALTER TABLE listings ADD COLUMN video_url TEXT;

-- Plan §2.3 — the missing-category problem. The brief said "if a cat is missing,
-- create a new cat on your own"; an LLM inventing categories at runtime creates
-- an unbounded, unmoderated taxonomy that fragments search within a week.
--
-- So: THE AI PROPOSES, AN ADMIN APPROVES, AND THE USER IS NEVER BLOCKED. If
-- nothing fits, the AI picks the closest intent, files the listing under
-- category='other' (seeded by the seed migration — §2.3's escape hatch must land
-- somewhere that exists) and writes its suggestion here as free text. The listing
-- PUBLISHES NORMALLY. A weekly admin view ranks proposals by volume; promoting
-- one to a real category is one INSERT, after which this column is the audit
-- trail of where the taxonomy was wrong.
--
-- Free text with no allowlist is correct HERE and nowhere else: this string is
-- never a query key and never renders as a category — it is a suggestion box.
-- Contrast olx.sql:13, where free-text `category` IS the live category (plan
-- §2.0b) and a seller invents any taxonomy they like.
ALTER TABLE listings ADD COLUMN proposed_category TEXT;

-- Plan §2.4 — PINNED AT BIRTH. This is the whole point of the versioning design:
-- a listing renders and negotiates at the version it was created under, ALWAYS.
-- buildAgentContext loads the playbook at listings.playbook_version, never
-- "latest", so an admin tightening the property playbook in September cannot
-- change how a July seller's agent negotiates on their behalf.
--
-- DEFAULT 1 matches listing_categories' DEFAULT 1, so every existing listing pins
-- to the as-seeded version of its category and no in-flight listing is orphaned.
--
-- MUST NOT BE CONFLATED WITH `content_version` (2026-07-18-listings-content-version.sql).
-- Different clocks, and the distinction is expensive to get wrong:
--   content_version  bumps when the SELLER EDITS the listing, and exists to
--                    reopen the talk-once negotiation gate.
--   cat/playbook/template_version  are pinned at birth and are NOT a seller edit.
-- A category bump must NEVER bump content_version — one admin playbook tweak
-- would otherwise silently reopen a PAID Sonnet negotiation for every buyer on
-- every listing in the category at once, and agentDailyCap caps the BUYER, not
-- the seller, so nothing bounds the spend.
ALTER TABLE listings ADD COLUMN cat_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE listings ADD COLUMN playbook_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE listings ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1;
