-- [SAATHUM-SHOP-API-CATALOG-1 2026-10-01] Shop (Hindu T-shirts) -- every shop table.
-- Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md section 2. CREATE-only (d1_apply_alters.py would skip these).
-- Apply (production is a deliberate step the coordinator takes, never an agent):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-saathum-shop.sql
-- Times are epoch ms INTEGER. Money is whole rupees unless a column is named *_paise.

CREATE TABLE IF NOT EXISTS shop_collections (
  id TEXT PRIMARY KEY,                       -- 'col-' + 8 hex
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_products (
  id TEXT PRIMARY KEY,                       -- 'prd-' + 8 hex
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  collection_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  fit TEXT NOT NULL DEFAULT 'Regular' CHECK (fit IN ('Regular','Oversized')),
  print_type TEXT NOT NULL DEFAULT 'Big front print',   -- 'Chest print'|'Big front print'|'Back print'|'Embroidery'
  audience TEXT NOT NULL DEFAULT 'Adults' CHECK (audience IN ('Adults','Kids')),
  price_rupees INTEGER NOT NULL CHECK (price_rupees BETWEEN 1 AND 100000),
  mrp_rupees INTEGER,
  colours_json TEXT NOT NULL DEFAULT '[]',   -- [{"name":"Black","hex":"#222222"}]
  sizes_json TEXT NOT NULL DEFAULT '[]',     -- ["S","M","L","XL","XXL"] or kids ["2-3Y",...]
  images_json TEXT NOT NULL DEFAULT '[]',    -- [{"url":"https://...","label":"Front"}]; first = card image
  badge TEXT NOT NULL DEFAULT '' CHECK (badge IN ('','new','best','sale')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live','draft','hidden','archived')),
  printrove_ref TEXT,
  sold_count INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_products_status_collection ON shop_products (status, collection_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_status_created ON shop_products (status, created_at);

-- slot in: 'hero_hotspots','new_arrivals','featured_banner','bestsellers','sale','also_like'
CREATE TABLE IF NOT EXISTS shop_slots (
  slot TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  until_at INTEGER,
  PRIMARY KEY (slot, product_id)
);

-- keys: 'hero', 'featured_banner', 'policy' (shapes in the spec)
CREATE TABLE IF NOT EXISTS shop_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS shop_coupons (
  code TEXT PRIMARY KEY,                     -- UPPERCASE
  kind TEXT NOT NULL CHECK (kind IN ('pct','flat')),
  value INTEGER NOT NULL,
  min_order_rupees INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  valid_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_orders (
  order_id TEXT PRIMARY KEY,                 -- 'shp_' + 20 hex
  order_no TEXT UNIQUE NOT NULL,             -- 'SHP-' + 8 upper hex of order_id
  uid TEXT NOT NULL,
  request_key TEXT NOT NULL,
  items_json TEXT NOT NULL,                  -- frozen [{product_id,slug,name,colour,size,qty,unit_rupees,image_url}]
  subtotal_rupees INTEGER NOT NULL,
  discount_rupees INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  gst_rate_pct INTEGER NOT NULL,
  gst_rupees INTEGER NOT NULL,
  total_rupees INTEGER NOT NULL CHECK (total_rupees > 0),
  address_json TEXT NOT NULL,
  contact_name TEXT,
  terms_accepted_at INTEGER NOT NULL,
  refund_policy_accepted_at INTEGER NOT NULL,
  refund_policy_version TEXT NOT NULL,
  -- payment (mirrors saathum_checkouts so the UPI rail can match either table)
  pay_status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (pay_status IN ('awaiting_payment','confirmed','review_pending','expired','cancelled')),
  receiving_account_key TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  rounding_discount_paise INTEGER NOT NULL DEFAULT 0,
  payer_reference TEXT,
  reference_revision INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  utr TEXT,
  payer_vpa TEXT,
  matched_message_hash TEXT,
  confirm_source TEXT,
  paid_claimed_at INTEGER,
  reviewed_by TEXT,
  review_note TEXT,
  reviewed_at INTEGER,
  review_alerted_at INTEGER,
  receipt_no TEXT,
  confirmed_at INTEGER,
  expires_at INTEGER NOT NULL,
  email_sent_at INTEGER,
  -- fulfilment
  fulfil_status TEXT NOT NULL DEFAULT 'new'
    CHECK (fulfil_status IN ('new','at_printer','shipped','delivered','cancelled','refunded')),
  printrove_order_ref TEXT,
  courier TEXT,
  awb TEXT,
  tracking_url TEXT,
  eta_text TEXT,
  sent_to_printer_at INTEGER,
  shipped_at INTEGER,
  delivered_at INTEGER,
  cancel_reason TEXT,
  refund_utr TEXT,
  refunded_at INTEGER,
  problem_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (uid, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_orders_account_reference
  ON shop_orders (receiving_account_key, payer_reference) WHERE payer_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shop_orders_match ON shop_orders (receiving_account_key, amount_paise, pay_status);
CREATE INDEX IF NOT EXISTS idx_shop_orders_uid ON shop_orders (uid, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders (pay_status, fulfil_status, created_at);

CREATE TABLE IF NOT EXISTS shop_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- created, paid_claimed, confirmed, rejected, at_printer, shipped, delivered, cancelled, refunded, problem_reported
  actor TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_order_events_order ON shop_order_events (order_id, at);
