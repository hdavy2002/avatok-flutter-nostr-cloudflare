-- [WEB-GATEWAY-FIX5 2026-09-19] Hide the legacy paid-companionship categories.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-09-18-webgw-taxonomy.sql (this
-- file assumes listing_categories already has these rows and the group_id
-- column).
--
-- Source of truth: Specs/listing-taxonomy.json (regenerate web/Flutter
-- mirrors with scripts/gen_listing_taxonomy.py — never hand-edit them). Those
-- 12 `find_your_people` categories now carry `"hidden": true` there; this
-- migration is the D1 half of the same decision — `active = 0` stops
-- GET /api/explore/categories from offering them to a picker or chip. It does
-- NOT touch any existing listing row or its stored `listings.category` — a
-- published row keeps its category forever, same contract as the
-- 2026-09-18-webgw-taxonomy.sql `live_friends`/`adda_rooms`/`astrologers`/
-- `glow_up` precedent this mirrors.
--
-- Only 10 ids here, not 12: `live_friends` and `adda_rooms` were already set
-- `active = 0` by 2026-09-18-webgw-taxonomy.sql. This file is idempotent
-- (UPDATE-by-id) so re-running it after that one is harmless either way.
--
-- ⚠️ DO NOT run this through scripts/d1_apply_alters.py — that script scans
-- for `ALTER TABLE ... ADD COLUMN` lines only and silently skips everything
-- else in a file, including the UPDATE statement below. Apply with:
--   cd worker && npx wrangler d1 execute DB_META --remote --file=migrations/2026-09-19-webgw-hide-companionship-categories.sql
-- (staging: scripts/cf.sh worker d1 execute DB_META --file=migrations/2026-09-19-webgw-hide-companionship-categories.sql
-- with .avatok-target set to staging; prod requires ALLOW_PROD=1 — the
-- coordinator picks the environment, not this file). NOT applied by this
-- change — this file is added only, per the brief's hard rule against
-- touching remote resources.
--
-- IDEMPOTENT: UPDATE-by-id, safe to re-run.

UPDATE listing_categories SET active = 0 WHERE id IN (
  'listener', 'home_friend', 'late_night_friend', 'quiet_company', 'chat_buddy',
  'walk_talk', 'language_buddy', 'college_friends', 'senior_company', 'queer_friendly'
);
