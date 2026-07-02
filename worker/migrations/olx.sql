-- Phase 5 (v5.2 §10.6) — AvaOLX marketplace. Tables in DB_MEDIA (avatok-media-meta).
-- Physical goods = free classifieds (contact via AvaChat, no money through AvaTalk).
-- Digital products = AvaCoins-priced; buyer pays → coins transfer (15% commission) →
-- signed R2 download; 24h refund if not downloaded. Listing/selling = Tier 2.

-- Classifieds (physical OR the public side of a digital product).
CREATE TABLE IF NOT EXISTS olx_listings (
  id           TEXT PRIMARY KEY,
  seller_uid  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'physical', -- 'physical'|'digital'
  title        TEXT NOT NULL,
  description  TEXT,                              -- auto-generated 2-page body
  category     TEXT,
  price_coins  INTEGER NOT NULL DEFAULT 0,        -- 0 for physical (contact to negotiate)
  location     TEXT,                              -- physical only (city/area, no precise PII)
  image_hashes TEXT,                              -- JSON array of blossom sha256 keys
  status       TEXT NOT NULL DEFAULT 'active',    -- 'active'|'sold'|'closed'
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_olx_seller ON olx_listings(seller_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_olx_browse ON olx_listings(kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_olx_cat ON olx_listings(category, status);

-- Digital product detail (the deliverable file in the private avatok-digital bucket).
CREATE TABLE IF NOT EXISTS olx_digital_products (
  listing_id   TEXT PRIMARY KEY,
  seller_uid  TEXT NOT NULL,
  r2_key       TEXT NOT NULL,                     -- key in avatok-digital (private)
  file_name    TEXT,
  mime         TEXT,
  size_bytes   INTEGER,
  created_at   INTEGER NOT NULL
);

-- Purchases (digital). Unlock = a download grant; 24h refund window if undownloaded.
CREATE TABLE IF NOT EXISTS olx_purchases (
  id            TEXT PRIMARY KEY,
  listing_id    TEXT NOT NULL,
  buyer_uid    TEXT NOT NULL,
  seller_uid   TEXT NOT NULL,
  price_coins   INTEGER NOT NULL,
  commission    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'paid',     -- 'paid'|'downloaded'|'refunded'
  downloaded_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_olxp_buyer ON olx_purchases(buyer_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_olxp_listing ON olx_purchases(listing_id);
