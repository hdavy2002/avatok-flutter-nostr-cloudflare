-- [SAATHUM-TAXONOMY-1 2026-09-20] Saathum devotional-services taxonomy narrowing.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-09-13-cat-puja.sql (this file
-- assumes listing_categories already has the group_id column and the
-- live_puja_ritual row).
--
-- Source of truth: Specs/listing-taxonomy.json (regenerate the web/Flutter
-- mirrors with `python3 scripts/gen_listing_taxonomy.py` — never hand-edit
-- them). This file is the D1 half of the same decision recorded there:
--
--   1. Seven new book_their_time categories for the Saathum 1:1 keep-list
--      (Specs/SPEC.md "Categories Saathum keeps"): palmistry, tarot_reading,
--      numerology, kundli_matching, vastu, pandit_consultation, meditation.
--      worker/src/lib/listing_section.ts ASTRO_CATEGORIES was extended in the
--      same change to route these into the astro_tarot section (which
--      Saathum keeps visible) instead of the generic consulting section
--      (which Saathum hides below) — without that, these categories would
--      publish but never render anywhere.
--
--   2. `active = 0` on every category outside the Saathum keep-list — this is
--      what stops GET /api/explore/categories (worker/src/routes/listings.ts
--      exploreCategories) and GET /api/marketplace/categories
--      (worker/src/routes/categories.ts marketplaceCategories) from offering
--      them to a picker or chip. It does NOT touch listings.category on any
--      existing row — a published listing keeps its category forever, same
--      contract as every prior `active` toggle on this table
--      (2026-09-19-webgw-hide-companionship-categories.sql,
--      2026-08-31-bazaar-session-categories.sql, etc).
--
-- Each row's Specs/listing-taxonomy.json entry carries `"hidden": true` and a
-- matching `_note` — read that file for the per-category reasoning. The
-- shelf-level hides (consulting, glow_up, ai_voice_agents, live_friends,
-- adda_rooms) are a JSON/mirror-only concept (`_hidden_sections`) with no D1
-- row of their own — SECTIONS are a TEXT column value, not a table — so they
-- are not part of this migration.
--
-- ⚠️ DO NOT run this through scripts/d1_apply_alters.py — it scans for
-- `ALTER TABLE ... ADD COLUMN` lines only and silently skips everything else
-- in a file, which both statements below are. Apply with:
--   cd worker && npx wrangler d1 execute DB_META --remote --file=migrations/2026-09-20-saathum-taxonomy.sql
-- (staging: scripts/cf.sh worker d1 execute DB_META --file=migrations/2026-09-20-saathum-taxonomy.sql
-- with .avatok-target=staging; prod requires ALLOW_PROD=1 — the coordinator
-- picks the environment, per SPEC.md hard rule 8). NOT APPLIED BY THIS LANE.
--
-- IDEMPOTENT: INSERT OR IGNORE by primary key, UPDATE-by-id. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Seven new book_their_time categories (Specs/SPEC.md keep-list, 1:1 NEW).
--    Sort 411-417 sits directly after astrologers (410) and clear of every
--    other book_their_time sort value (420-550), all of which are deactivated
--    below. No intent/price_semantics/detail_template given, matching the
--    precedent set by 2026-09-05-mkt-3group-data.sql's new-category inserts —
--    these are consult-kind listings, not commerce-vertical AI-composed ones.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('palmistry',           'Palmistry',           '🤲', 411, 1, 'book_their_time'),
  ('tarot_reading',       'Tarot reading',       '🃏', 412, 1, 'book_their_time'),
  ('numerology',          'Numerology',          '🔢', 413, 1, 'book_their_time'),
  ('kundli_matching',     'Kundli matching',     '💑', 414, 1, 'book_their_time'),
  ('vastu',               'Vastu',               '🧭', 415, 1, 'book_their_time'),
  ('pandit_consultation', 'Pandit consultation', '🙏', 416, 1, 'book_their_time'),
  ('meditation',          'Meditation',          '🧘', 417, 1, 'book_their_time');

-- ---------------------------------------------------------------------------
-- 2. Deactivate every category outside the Saathum keep-list — 36 of the 42
--    rows that existed before this migration. (BRIEFS.md says "30 of the
--    existing 42"; counting the explicit SPEC.md keep-list gives 36 — see
--    REPORT.md for the reconciliation. This migration follows SPEC.md, the
--    more explicit and authoritative source.)
-- ---------------------------------------------------------------------------

-- india_goes_live — everything except Puja & darshan, Puja, Temple tours,
-- Satsang & sermons, Festivals.
UPDATE listing_categories SET active = 0 WHERE id IN (
  'live_cooking', 'live_trek', 'live_music', 'live_dance', 'live_travel',
  'live_food_walk', 'live_fitness', 'live_sports', 'live_art', 'live_everyday'
);

-- find_your_people — the whole group (all 12 companionship categories).
UPDATE listing_categories SET active = 0 WHERE id IN (
  'listener', 'home_friend', 'late_night_friend', 'quiet_company', 'chat_buddy',
  'walk_talk', 'language_buddy', 'college_friends', 'senior_company',
  'queer_friendly', 'live_friends', 'adda_rooms'
);

-- book_their_time — everything except astrologers (and the 7 new rows above).
UPDATE listing_categories SET active = 0 WHERE id IN (
  'teachers', 'professors', 'business', 'money_finance', 'career_coach',
  'fitness', 'wellness', 'music', 'language', 'art', 'glow_up', 'legal_tax',
  'tech_help', 'services'
);

-- VERIFY (read-only, either environment):
--   scripts/cf.sh worker d1 execute DB_META --remote --command \
--     "SELECT group_id, SUM(active) AS active, COUNT(*) AS total FROM listing_categories WHERE group_id IS NOT NULL GROUP BY group_id;"
--   -- expect: india_goes_live 5/15, find_your_people 0/12, book_their_time 8/22.
--   scripts/cf.sh worker d1 execute DB_META --remote --command \
--     "SELECT id, label, sort FROM listing_categories WHERE group_id='book_their_time' AND active=1 ORDER BY sort;"
--   -- expect: astrologers, palmistry, tarot_reading, numerology,
--   -- kundli_matching, vastu, pandit_consultation, meditation. 8 rows.
