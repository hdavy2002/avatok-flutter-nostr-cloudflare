-- [LIST-CONTENT-2] Reviews trust columns + helpful-vote table.
-- DB: avatok-meta (DB_META). Source: Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md
-- §4.1. Companion issue [LIST-REVIEW-2] (§6, "new 5b") wires the gating/UI this
-- data enables — this file only lands the columns, dark.
--
-- WHY — a review's whole value to a buyer is knowing the reviewer actually held
-- an entitlement (row 5 of the trust ladder, §1). `verified_attendee` is set
-- SERVER-SIDE from the entitlement at write time; it is never a client-posted
-- flag. `creator_reply`/`creator_reply_at`, `helpful_count` and `photo_keys`
-- (JSON, <=3 R2 keys) are the rest of the "Instagram comments vs real reviews"
-- gap called out in the spec.
--
-- Base table: worker/migrations/listings.sql:53-64 (`reviews`, PK id, existing
-- UNIQUE(listing_id, author_id)). This file only ALTERs it and adds one new
-- side table for helpful-vote de-dup (one vote per user per review).
--
-- IDEMPOTENCY — same SQLite/D1 caveat as every ALTER file here: no
-- `ADD COLUMN IF NOT EXISTS`. Every NOT NULL below carries a DEFAULT so no
-- existing review row is orphaned; nullable columns (`creator_reply`,
-- `creator_reply_at`, `photo_keys`) backfill NULL, which correctly means
-- "no reply yet" / "no photos attached" for every review written before this
-- migration.
--
-- This file mixes an ALTER-only section (reviews) with one CREATE TABLE
-- (review_helpful), deliberately kept separate below so the guarded runner's
-- ALTER-only parser (d1_apply_alters.py) only ever touches the ALTERs and the
-- CREATE is applied via the raw path — same split rationale as
-- 2026-07-18-listings-taxonomy-columns.sql:70-75.
--
-- APPLY — ALTERs (idempotent, resumable, staging by default, prod fail-closed):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-reviews-trust.sql --binding DB_META --dry-run
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-reviews-trust.sql --binding DB_META
--   ALLOW_PROD=1 python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-reviews-trust.sql --binding DB_META
--
-- APPLY — the CREATE TABLE (idempotent via IF NOT EXISTS; not picked up by the
-- ALTER-only runner above, so apply it once via the raw path, same file is
-- safe to re-run):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-reviews-trust.sql
--   ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-reviews-trust.sql
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.

ALTER TABLE reviews ADD COLUMN verified_attendee INTEGER NOT NULL DEFAULT 0; -- set from entitlement at write time, server-side only
ALTER TABLE reviews ADD COLUMN creator_reply TEXT;
ALTER TABLE reviews ADD COLUMN creator_reply_at INTEGER;
ALTER TABLE reviews ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN photo_keys TEXT;                             -- JSON, <=3 R2 keys

-- One vote per user per review; re-voting is a no-op (INSERT OR IGNORE at the
-- call site), un-voting is a DELETE — not modelled here.
CREATE TABLE IF NOT EXISTS review_helpful (
  review_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (review_id, user_id)
);
