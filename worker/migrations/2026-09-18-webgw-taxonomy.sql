-- [WEB-GATEWAY-F 2026-09-18] Payment-gateway-review taxonomy cleanup.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-09-05-mkt-3group-data.sql
-- (this file assumes listing_categories.group_id already exists).
--
-- Source of truth: Specs/listing-taxonomy.json (regenerate web/Flutter
-- mirrors with scripts/gen_listing_taxonomy.py — never hand-edit them). The
-- worker's own (kind, category) -> section mirror,
-- worker/src/lib/listing_section.ts, is NOT generated and was hand-updated
-- in this same change — see Specs/WEBGW-INT-REPORT.md.
--
-- ⚠️ DO NOT run this through scripts/d1_apply_alters.py — that script scans
-- for `ALTER TABLE ... ADD COLUMN` lines only and silently skips everything
-- else in a file, including the INSERT/UPDATE statements below. Apply with:
--   cd worker && npx wrangler d1 execute DB_META --remote --file=migrations/2026-09-18-webgw-taxonomy.sql
-- (staging: scripts/cf.sh worker d1 execute DB_META --file=migrations/2026-09-18-webgw-taxonomy.sql
-- with .avatok-target set to staging; prod requires ALLOW_PROD=1 — the
-- coordinator picks the environment, not this file). NOT applied by this
-- change — this file is added only, per the brief's hard rule against
-- touching remote resources.
--
-- IDEMPOTENT: INSERT OR IGNORE / UPDATE-by-id, safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. New group_classes categories (find_your_people). Sort continues the
--    existing 210-320 find_your_people block from 2026-09-05-mkt-3group-data.sql.
--    Each id resolves to the group_classes SECTION in
--    worker/src/lib/listing_section.ts SECTION_CATEGORIES, not consulting —
--    a scheduled, multi-seat class, not a 1:1.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('group_language_practice', 'Language practice',    '🗣️', 330, 1, 'find_your_people'),
  ('group_fitness_batch',     'Fitness & yoga batch',  '🧘', 340, 1, 'find_your_people'),
  ('group_exam_revision',     'Exam revision',         '📖', 350, 1, 'find_your_people'),
  ('group_music_class',       'Music class',           '🎵', 360, 1, 'find_your_people'),
  ('group_cooking_class',     'Cooking class',         '🍳', 370, 1, 'find_your_people');

-- ---------------------------------------------------------------------------
-- 2. Mark categories of newly-HIDDEN sections inactive (Specs/listing-
--    taxonomy.json `_hidden_sections`: live_friends, adda_rooms, astro_tarot,
--    glow_up). `active = 0` stops new listings choosing them via
--    GET /api/explore/categories; it does NOT touch any existing listing row
--    or its stored `listings.section` — a published row keeps its section
--    forever, per the contract on listing_section.ts's SECTIONS_WITHOUT_A_SOURCE.
--    astro_tarot has no category of its own — 'astrologers' resolves to it via
--    listing_section.ts's ASTRO_CATEGORIES set, so that row is what gets hidden.
-- ---------------------------------------------------------------------------
UPDATE listing_categories SET active = 0 WHERE id IN ('live_friends', 'adda_rooms', 'glow_up', 'astrologers');
