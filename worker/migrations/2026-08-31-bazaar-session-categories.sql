-- [MARKET-SECTION-2] Three categories that open the last three bazaar sections.
--
-- DB: avatok-meta (DB_META). Apply AFTER 2026-08-31-listings-section.sql.
--
-- WHY CATEGORIES AND NOT A NEW `kind` — a listing's section is resolved from
-- (kind, category) by worker/src/lib/listing_section.ts, and a category is a
-- ROW while a kind is a code path. Live friends and Glow-up studio are both
-- ordinary paid 1:1 sessions in every respect that the booking, payment and
-- GetStream lanes care about; only the framing differs. Giving them a `kind`
-- would have meant three new branches through checkout for no behavioural
-- difference. Adda rooms genuinely IS a different delivery (a group room), but
-- see the gate note below — that difference is enforced at publish time, not by
-- a taxonomy row.
--
-- SORT ORDERS start at 30 to sit clear of the seeded 1–10 in listings.sql and
-- the classifieds block above them, so this file never has to renumber a row
-- someone is already filed under.
--
-- IDEMPOTENT: INSERT OR IGNORE, safe to re-run.

INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active) VALUES
  ('live_friends', 'Live friends',    '💬', 30, 1),
  ('adda_rooms',   'Adda rooms',      '🫖', 31, 1),
  ('glow_up',      'Glow-up studio',  '✨', 32, 1);

-- Existing rows are untouched: nothing today is filed under these ids, so there
-- is no backfill and no listing changes section as a result of this migration.
