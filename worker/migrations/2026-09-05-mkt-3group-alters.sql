-- [MKT-3GROUP-1 / PRICE-HOURLY-1 2026-09-05] Three marketplace groups,
-- sub-category blips and hourly pricing — the two new COLUMNS.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-08-31-listings-section.sql and
-- 2026-08-31-bazaar-session-categories.sql.
--
-- ⚠️ ALTER-ONLY FILE. `scripts/d1_apply_alters.py` applies ONLY
-- `ALTER TABLE ... ADD COLUMN` lines and SILENTLY SKIPS everything else in a
-- file — a CREATE TABLE or INSERT sitting alongside these two ALTERs would
-- not run and nobody would be told. The category seed/backfill INSERTs and
-- UPDATEs for this same change are in the SEPARATE file
-- 2026-09-05-mkt-3group-data.sql, which must be applied with
-- `wrangler d1 execute` (via scripts/cf.sh worker d1 execute), never through
-- the alters script.
--
-- SAFE TO RE-RUN? NO — `ALTER TABLE ADD COLUMN` fails with "duplicate column
-- name" on a second run, same tradeoff as every other listings ALTER. Run
-- once per database and let the error tell you it is already applied.

-- 1. listing_categories.group_id — Specs/listing-taxonomy.json §categories
--    `group`. NULL for marketplace-goods categories (cars, property, mobiles,
--    …), which are a different product and untouched by this change; NULL
--    also for any service category not yet re-pointed (the data file fixes
--    that for every category this spec covers).
ALTER TABLE listing_categories ADD COLUMN group_id TEXT;

-- 2. listings.media_mode — spec §3. 'audio_video' | 'audio_only'. NOT NULL
--    with a default so every existing row (including marketplace-goods rows,
--    which never read this field) is instantly valid.
ALTER TABLE listings ADD COLUMN media_mode TEXT NOT NULL DEFAULT 'audio_video';

-- Nothing else belongs in this file — see 2026-09-05-mkt-3group-data.sql for
-- the CREATE INDEX, the category seed INSERTs and the backfill UPDATEs.
