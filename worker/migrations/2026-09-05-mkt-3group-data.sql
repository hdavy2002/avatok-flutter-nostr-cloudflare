-- [MKT-3GROUP-1 / PRICE-HOURLY-1 2026-09-05] Three marketplace groups,
-- sub-category blips and hourly pricing — everything that is NOT a bare
-- `ALTER TABLE ... ADD COLUMN`.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-09-05-mkt-3group-alters.sql
-- (this file assumes listing_categories.group_id and listings.media_mode
-- already exist).
--
-- ⚠️ DO NOT run this through `scripts/d1_apply_alters.py` — that script scans
-- for ALTER lines only and silently skips a CREATE INDEX / INSERT / UPDATE
-- file, which is exactly why this is a SEPARATE file from the alters above.
-- Apply it with:
--   cd worker && npx wrangler d1 execute DB_META --remote --file=migrations/2026-09-05-mkt-3group-data.sql
-- (staging: swap --remote for --env staging --remote, or use scripts/cf.sh
-- worker d1 execute per the project's staging/prod wrapper convention — the
-- coordinator picks the environment, not this file).
--
-- IDEMPOTENT: every statement below is INSERT OR IGNORE / UPDATE-by-id /
-- CREATE INDEX IF NOT EXISTS, safe to re-run.
--
-- Source of truth: Specs/listing-taxonomy.json. If you are editing the
-- mapping below, edit that file first and regenerate this one — do not let
-- them drift, per that file's own `_readme`.

-- ---------------------------------------------------------------------------
-- 1. Index for the marketplace's group -> categories lookups.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_listing_categories_group ON listing_categories(group_id);

-- ---------------------------------------------------------------------------
-- 2. Re-point EXISTING service categories to their group (taxonomy `"new":
--    false` rows). Marketplace-goods categories (cars, property, mobiles, …)
--    are NOT touched — they keep group_id NULL, per spec §2.
-- ---------------------------------------------------------------------------

-- find_your_people
UPDATE listing_categories SET group_id = 'find_your_people' WHERE id = 'live_friends';
UPDATE listing_categories SET group_id = 'find_your_people' WHERE id = 'adda_rooms';

-- book_their_time
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'astrologers';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'teachers';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'professors';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'business';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'fitness';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'wellness';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'music';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'language';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'art';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'glow_up';
UPDATE listing_categories SET group_id = 'book_their_time' WHERE id = 'services';

-- ---------------------------------------------------------------------------
-- 3. New sub-category rows (taxonomy `"new": true`). Sort orders follow the
--    taxonomy file exactly (10-140 live, 210-320 find-your-people, 410-550
--    book-their-time) — these ranges sit clear of every sort value seeded by
--    earlier migrations (listings.sql's 1-10, the classifieds block, and
--    2026-08-31-bazaar-session-categories.sql's 30-32), so this file never
--    renumbers a row someone else already owns.
-- ---------------------------------------------------------------------------

-- 3.1 india_goes_live
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('live_cooking',      'Cooking',             '🍳', 10,  1, 'india_goes_live'),
  ('live_trek',         'Treks & hiking',      '🥾', 20,  1, 'india_goes_live'),
  ('live_puja',         'Puja & darshan',      '🪔', 30,  1, 'india_goes_live'),
  ('live_temple',       'Temple tours',        '🛕', 40,  1, 'india_goes_live'),
  ('live_festival',     'Festivals',           '🎉', 50,  1, 'india_goes_live'),
  ('live_music',        'Music',               '🎵', 60,  1, 'india_goes_live'),
  ('live_dance',        'Dance',               '💃', 70,  1, 'india_goes_live'),
  ('live_travel',       'Travel & road trips', '🛵', 80,  1, 'india_goes_live'),
  ('live_food_walk',    'Street food walks',   '🍜', 90,  1, 'india_goes_live'),
  ('live_fitness',      'Yoga & fitness',      '🧘', 100, 1, 'india_goes_live'),
  ('live_sports',       'Sports',              '🏏', 110, 1, 'india_goes_live'),
  ('live_art',          'Art & craft',         '🎨', 120, 1, 'india_goes_live'),
  ('live_satsang',      'Satsang & sermons',   '📿', 130, 1, 'india_goes_live'),
  ('live_everyday',     'Everyday life',       '☕', 140, 1, 'india_goes_live');

-- 3.2 find_your_people
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('listener',          'Listener',                '👂', 210, 1, 'find_your_people'),
  ('home_friend',       'Home friend',             '🏠', 220, 1, 'find_your_people'),
  ('late_night_friend', 'Late-night friend',       '🌙', 230, 1, 'find_your_people'),
  ('quiet_company',     'Quiet company',           '🤍', 240, 1, 'find_your_people'),
  ('chat_buddy',        'Chat buddy',              '💬', 250, 1, 'find_your_people'),
  ('walk_talk',         'Walk & talk',             '🚶', 260, 1, 'find_your_people'),
  ('language_buddy',    'Language buddy',          '🗣️', 270, 1, 'find_your_people'),
  ('college_friends',   'College circle',          '🎓', 280, 1, 'find_your_people'),
  ('senior_company',    'Senior company',          '🌻', 290, 1, 'find_your_people'),
  ('queer_friendly',    'Queer-friendly space',    '🏳️‍🌈', 300, 1, 'find_your_people');

-- 3.3 book_their_time
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('money_finance',     'Money & finance',    '💰', 450, 1, 'book_their_time'),
  ('career_coach',      'Career coaching',    '🧭', 460, 1, 'book_their_time'),
  ('legal_tax',         'Legal & tax',        '⚖️', 530, 1, 'book_their_time'),
  ('tech_help',         'Tech help',          '🛠️', 540, 1, 'book_their_time');

-- ---------------------------------------------------------------------------
-- 4. billing_unit backfill. Spec §4: "everything is priced per hour" is a
--    blanket business-model change, not opt-in per listing — every existing
--    live_event/consult row is backfilled to 'hour' so the pricing model and
--    the stored data agree from day one. Marketplace-goods kinds
--    (sell/buy/social) are NOT touched — hourly billing is not their model.
--    Safe to re-run: only rows not already 'hour' are touched.
-- ---------------------------------------------------------------------------
UPDATE listings SET billing_unit = 'hour'
  WHERE kind IN ('live_event', 'consult') AND (billing_unit IS NULL OR billing_unit <> 'hour');
