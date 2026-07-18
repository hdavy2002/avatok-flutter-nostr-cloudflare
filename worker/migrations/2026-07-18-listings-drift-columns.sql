-- [AVA-SCHEMA-DRIFT-1] listings: 8 columns that existed in PROD but not in git.
--
-- WHY THIS FILE EXISTS — THIS IS NOT NEW SCHEMA.
-- Found 2026-07-18: worker/src/routes/listings.ts reads these 8 columns in
-- CARD_SELECT and writes them in the createListing INSERT, but NO migration file
-- in worker/migrations/ ever declared them. They were applied to production
-- `avatok-meta` (c4ec8c0e-e1ac-4a1d-8e41-636f4007871b) BY HAND, outside version
-- control. Verified read-only against prod on 2026-07-18: all 8 are already
-- present there. The code therefore works in prod and would fail on any FRESH or
-- STAGING database built from listings.sql alone ("no such column: market_type").
-- This file back-fills version control so the repo is the source of truth again.
--
-- Sibling columns `translation_enabled` / `spoken_lang` are NOT here — they are
-- already covered by migrations/translation.sql. Apply this file AFTER
-- translation.sql: prod's column order is
--   ... translation_enabled, spoken_lang, <the 8 below> ...
-- and following that order makes a fresh DB byte-for-byte match prod's schema.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY — READ BEFORE RUNNING (this is the whole problem with this file)
--
-- SQLite/D1 has NO `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. So:
--   * FRESH / STAGING DB (no columns)  -> all 8 ALTERs apply cleanly. Correct.
--   * PROD (all 8 already present)     -> the FIRST ALTER fails with
--                                         "duplicate column name: agent_instructions"
--                                         and the rest never run. SAFE — nothing to
--                                         change was left unchanged. That error is
--                                         EXPECTED on prod and can be ignored.
--   * PARTIALLY migrated DB (some present, some missing) -> DANGEROUS. A plain
--     run aborts at the first duplicate and SILENTLY LEAVES THE REST MISSING,
--     which looks like success-then-mystery-500s later.
--
-- Chosen approach = documented .sql (repo convention, see add_user_bio.sql which
-- handles the same problem the same way) PLUS a guarded runner for the partial
-- case, because option (b) alone cannot survive a half-migrated DB and option (a)
-- alone would put schema truth in a shell script instead of in migrations/:
--
--   PREFERRED (safe on every DB state — PRAGMA-guards each column, applies only
--   what is missing, and is a no-op on prod):
--     scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-drift-columns.sql --dry-run
--     scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-drift-columns.sql
--
--   RAW (only for a known-fresh DB; will abort on the first duplicate elsewhere):
--     scripts/cf.sh worker d1 execute DB_META --remote \
--       --file=migrations/2026-07-18-listings-drift-columns.sql
--
-- Both go through scripts/cf.sh, so staging is the default and prod is
-- fail-closed behind ALLOW_PROD=1. Pass the BINDING (DB_META), not a database
-- name — prod is `avatok-meta`, staging is `avatok-meta-staging`, and the
-- binding resolves to the right one per --env.
--
-- DO NOT run this against prod to "fix" anything. Prod is already correct.
-- ---------------------------------------------------------------------------

-- AvaExplore marketplace surface: which market a listing belongs to and, for
-- social listings, its sub-category. `location` is free-text (listings.ts treats
-- all three as opaque nullable strings; normFields passes them through).
-- Types below mirror the live prod DDL exactly — all nullable, no DEFAULT.
ALTER TABLE listings ADD COLUMN agent_instructions TEXT;
ALTER TABLE listings ADD COLUMN agent_lang TEXT;
ALTER TABLE listings ADD COLUMN agent_voice_persona TEXT;
ALTER TABLE listings ADD COLUMN market_type TEXT;
ALTER TABLE listings ADD COLUMN social_sub TEXT;
ALTER TABLE listings ADD COLUMN location TEXT;

-- Listing expiry: expiry_days is the creator's chosen TTL at create time;
-- expires_at is the resolved epoch-ms deadline used by CARD_SELECT. Note
-- createListing INSERTs expiry_days only — expires_at is set later (on publish),
-- which is why it appears in the SELECT but not the INSERT.
ALTER TABLE listings ADD COLUMN expiry_days INTEGER;
ALTER TABLE listings ADD COLUMN expires_at INTEGER;
