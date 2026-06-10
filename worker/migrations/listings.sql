-- Phase 6 — Listings pipeline + AvaExplore marketplace + creator channels.
-- DB: avatok-meta (DB_META). Events/consults marketplace — SEPARATE from AvaOLX
-- (digital goods, DB_MEDIA). Low-write global surface → D1 is allowed here.

-- Category config (server-driven rails; seeded below, editable by admin later).
CREATE TABLE IF NOT EXISTS listing_categories (
  id     TEXT PRIMARY KEY,          -- 'teachers' | 'astrologers' | ...
  label  TEXT NOT NULL,
  emoji  TEXT,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort) VALUES
  ('teachers',    'Teachers',    '📚', 1),
  ('astrologers', 'Astrologers', '🔮', 2),
  ('professors',  'Professors',  '🎓', 3),
  ('fitness',     'Fitness',     '💪', 4),
  ('music',       'Music',       '🎵', 5),
  ('cooking',     'Cooking',     '🍳', 6),
  ('business',    'Business',    '💼', 7),
  ('language',    'Languages',   '🗣️', 8),
  ('art',         'Art & Design','🎨', 9),
  ('wellness',    'Wellness',    '🧘', 10);

-- The marketplace listings table (live events + consult offerings).
CREATE TABLE IF NOT EXISTS listings (
  id               TEXT PRIMARY KEY,
  creator_id       TEXT NOT NULL,              -- Clerk uid
  kind             TEXT NOT NULL,              -- live_event | consult
  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL,
  price            INTEGER NOT NULL DEFAULT 0, -- coins (0 = free, A5)
  currency_display TEXT DEFAULT 'USD',
  country          TEXT,
  adults_only      INTEGER NOT NULL DEFAULT 0,
  badges           TEXT,                       -- JSON: extra icon flags (language, recorded, ...)
  cover_media      TEXT,                       -- JSON: [{type: image|video, r2_key}]
  starts_at        INTEGER,                    -- live events
  duration_min     INTEGER,
  capacity         INTEGER,                    -- consult group size 1|10|20 (1 = 1:1); live = NULL
  status           TEXT NOT NULL DEFAULT 'draft', -- draft|published|live|completed|cancelled
  joined_count     INTEGER NOT NULL DEFAULT 0,
  rating_avg       REAL,
  rating_count     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_browse  ON listings(status, kind, category, starts_at);
CREATE INDEX IF NOT EXISTS idx_listings_creator ON listings(creator_id, status, updated_at);

-- Reviews — only attendees may review (route checks vs bookings).
CREATE TABLE IF NOT EXISTS reviews (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  body       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(listing_id, author_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_creator ON reviews(creator_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_listing ON reviews(listing_id, created_at);

-- Channel EXTRAS only — identity (handle/display_name/avatar) stays in `users`.
CREATE TABLE IF NOT EXISTS creator_profiles (
  user_id           TEXT PRIMARY KEY,
  bio               TEXT,
  public_fields     TEXT,            -- JSON of what the creator made public
  rating_avg        REAL,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  follower_count    INTEGER NOT NULL DEFAULT 0,
  banner_r2_key     TEXT,            -- A7 channel polish
  links             TEXT,            -- JSON [{label,url}] (https only, enforced in route)
  intro_video_ref   TEXT,
  pinned_listing_id TEXT,
  updated_at        INTEGER
);

-- A2 follow system. (Named creator_follows — a legacy Nostr `follows` table
-- already exists in avatok-meta with npub columns.)
CREATE TABLE IF NOT EXISTS creator_follows (
  follower_id TEXT NOT NULL,
  creator_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  notify      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (follower_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_cfollows_creator ON creator_follows(creator_id, notify);

-- A2 anti-spam: max 2 fan-outs per creator per day.
CREATE TABLE IF NOT EXISTS fanout_log (
  creator_id TEXT NOT NULL,
  day        TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (creator_id, day)
);

-- A5 promotions: early-bird + promo codes.
CREATE TABLE IF NOT EXISTS listing_promotions (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- early_bird | promo_code
  pct_off    INTEGER NOT NULL,
  code       TEXT,
  max_uses   INTEGER,
  used       INTEGER NOT NULL DEFAULT 0,
  ends_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_promos_listing ON listing_promotions(listing_id);

-- Orders — escrow glue (full lifecycle lands in Phase 7). order id = escrow ref.
CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  buyer_id   TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  amount     INTEGER NOT NULL,        -- coins actually held (after promo; 0 = free)
  promo_id   TEXT,
  status     TEXT NOT NULL DEFAULT 'held', -- held|free|released|refunded
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_listing ON orders(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer   ON orders(buyer_id, created_at);

-- A1 marketplace search. Standalone FTS5 (listings are low-write; rows are
-- replaced on publish/update — simpler + safer than external-content triggers).
CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
  listing_id UNINDEXED,
  title,
  description,
  creator_name,
  category
);
