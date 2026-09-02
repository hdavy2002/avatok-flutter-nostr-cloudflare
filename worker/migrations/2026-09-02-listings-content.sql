-- [LIST-CONTENT-2] Card/page content columns for the listing-content-and-booking
-- spec. DB: avatok-meta (DB_META). ALTERs only — mixing a CREATE in here would
-- break scripts/d1_apply_alters.py, which parses ALTERs and ONLY ALTERs (see
-- 2026-07-18-listings-taxonomy-columns.sql:70-75 for why that split is load-bearing).
--
-- Source: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.1. These are
-- the fields items 1, 3, 4, 5, 12, 13 in table A need: a real one-liner (`blurb`),
-- a pretty URL (`slug`), a schedule shape beyond one instant (`schedule_mode` +
-- `recurrence_days` + `recurrence_time`), a timezone, a billing-unit override,
-- the free lane (E), a per-order seat cap, a consult/AI response-time chip, and
-- the curated vibe-tag picklist. `price_semantics` itself is NOT a new column —
-- it already lives on `listing_categories` (2026-07-18-listings-taxonomy-columns.sql)
-- and gets joined into CARD_SELECT/shapeCard in the route code, not added here.
--
-- Verified column name: `listings.creator_id` (worker/migrations/listings.sql:28,
-- also used throughout 2026-07-18-listings-taxonomy-columns.sql and
-- 2026-08-29-listings-series-id.sql). There is no `seller_id` on this table.
--
-- IDEMPOTENCY — same hazard as every ALTER-only file here: SQLite/D1 has no
-- `ADD COLUMN IF NOT EXISTS`, so a raw re-run aborts at the first duplicate and
-- silently leaves the rest missing. Every NOT NULL below carries a DEFAULT, so
-- no existing row is orphaned; nullable columns backfill NULL, which is the
-- correct "not set yet" value for a card/page that has never had this data.
--
-- APPLY (idempotent, resumable, staging by default, prod fail-closed):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-listings-content.sql --binding DB_META --dry-run
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-listings-content.sql --binding DB_META
--   ALLOW_PROD=1 python3 scripts/d1_apply_alters.py worker/migrations/2026-09-02-listings-content.sql --binding DB_META
--
-- RAW (only ever correct on a known-fresh DB; aborts on first duplicate elsewhere):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-listings-content.sql
--
-- NOT EXECUTED BY CREATING THIS FILE. Ships dark per spec §I step 1 — nothing
-- reads these columns yet.

ALTER TABLE listings ADD COLUMN blurb TEXT;                                   -- card one-liner, 55-110 chars, creator-written
ALTER TABLE listings ADD COLUMN slug TEXT;                                    -- pretty URL; unique per creator via the index below
ALTER TABLE listings ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'fixed_date'; -- fixed_date|recurring|on_request|always_on
ALTER TABLE listings ADD COLUMN recurrence_days TEXT;                         -- JSON [0..6], recurring only
ALTER TABLE listings ADD COLUMN recurrence_time TEXT;                         -- 'HH:MM' local, recurring only
ALTER TABLE listings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'; -- IANA; every existing listing is India-only today
ALTER TABLE listings ADD COLUMN billing_unit TEXT;                            -- session|minute|10min|chat|night|game; overrides the category default
ALTER TABLE listings ADD COLUMN free_entry INTEGER NOT NULL DEFAULT 0;        -- E: creator pays, buyer pays 0
ALTER TABLE listings ADD COLUMN max_per_booking INTEGER NOT NULL DEFAULT 4;   -- seat qty cap per order
ALTER TABLE listings ADD COLUMN response_time_min INTEGER;                    -- consult/AI: "10 MIN RESPONSE" chip
ALTER TABLE listings ADD COLUMN vibe_tags TEXT;                               -- JSON, <=2, curated picklist only (never free text)
ALTER TABLE listings ADD COLUMN credential TEXT;                             -- consult: "CA - 8 YRS" one-liner, shown only after KYC (spec §2.2)

-- Unique per creator, not global — two different creators may both pick "yoga".
-- CREATE INDEX (not an ALTER), so d1_apply_alters.py's ALTER-only parser will
-- not see this line at all: it is safe to leave in this file (the regex only
-- matches ALTER TABLE ... ADD COLUMN), but on the guarded path it will NOT be
-- applied automatically — run it once via the raw `cf.sh ... --command` path
-- after the ALTERs above have landed, or include it in the raw file-apply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_creator_slug ON listings(creator_id, slug);
