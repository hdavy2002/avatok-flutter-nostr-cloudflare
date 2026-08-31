-- [MARKET-SECTION-1] listings.section — the bazaar section a listing belongs to.
--
-- DB: avatok-meta (DB_META), the same database as migrations/listings.sql.
-- Apply AFTER listings.sql and AFTER 2026-07-18-listings-taxonomy-columns.sql.
--
-- ---------------------------------------------------------------------------
-- THIS IS NOT `vertical`, AND THE DISTINCTION IS THE WHOLE POINT.
--
-- `listings.vertical` already exists and means 'commerce' | 'connect' — the
-- top-level marketplace/Connect split from [AVA-MKT-VERTICALS-1]. It is a
-- filter on every listing query, it scopes categories, and it picks the listing
-- fee key (`feeKeyFor` in lib/listing_billing.ts charges connect differently).
-- Overloading it with the bazaar's seven groups would have silently rewired
-- billing and category scoping.
--
-- A SECTION sits one level BELOW a vertical and one level ABOVE a category:
--
--     vertical  commerce ─┬─ section live_streaming ─┬─ category music
--                         │                          └─ category wellness
--                         ├─ section consulting      ─── category business
--                         └─ section astro_tarot     ─── category astrologers
--
-- It exists because the marketplace design groups listings by what the SESSION
-- IS (a ticketed group show, a 1:1 reading, an always-on agent), which neither
-- `kind` nor `category` expresses on its own — "Live streaming" vs "Consulting"
-- is a KIND distinction, while "Astro & tarot" is a CATEGORY one.
--
-- ---------------------------------------------------------------------------
-- WHY A STORED COLUMN AND NOT A VIEW / DERIVED EXPRESSION.
--
-- It was derived in the browser first (web/src/lib/verticals.ts). That could not
-- be filtered, counted or sorted server-side, so the marketplace's sidebar
-- filters only ever narrowed the page already loaded — with pagination they
-- looked like they were hiding results. Storing it makes it an ordinary
-- indexable predicate, which is what the rail and the sort actually need.
--
-- ---------------------------------------------------------------------------
-- SAFE TO RE-RUN? NO — `ALTER TABLE ADD COLUMN` fails with "duplicate column
-- name: section" on a second run. That is the same tradeoff as the taxonomy
-- migration this sits beside; run it once per database and let the error tell
-- you it is already applied. The UPDATE backfills BELOW are idempotent on their
-- own and can be re-run freely.

-- 1. The column. NOT NULL with a default, so every existing row is instantly
--    valid and no reader has to handle a null.
ALTER TABLE listings ADD COLUMN section TEXT NOT NULL DEFAULT 'live_streaming';

-- 2. Backfill, in the same precedence order the publish-time resolver uses
--    (worker/src/lib/listing_section.ts). Order matters: astro wins over kind,
--    because a tarot reading sold as a 1:1 is still astro.
UPDATE listings SET section = 'ai_voice_agents'
  WHERE kind LIKE 'agent%' OR kind = 'ai_agent';

UPDATE listings SET section = 'consulting'
  WHERE kind LIKE 'consult%';

UPDATE listings SET section = 'live_streaming'
  WHERE kind IN ('live_event', 'live', 'event');

-- Astro last so it overrides whatever kind put there.
UPDATE listings SET section = 'astro_tarot'
  WHERE category IN ('astrologers');

-- 3. Browse index. Mirrors idx_listings_browse but leads with section, because
--    the marketplace's default read is "published rows in ONE section, soonest
--    first" and that is the query the rail issues on every filter click.
CREATE INDEX IF NOT EXISTS idx_listings_section
  ON listings(status, section, starts_at);
