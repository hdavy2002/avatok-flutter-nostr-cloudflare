-- [AUMFE-POD-CORE-1 2026-10-01] Shop Studio + print-on-demand (Printrove, swappable) -- every table.
-- Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 2. CREATE-only (d1_apply_alters.py would skip these).
-- Apply (production is a deliberate step the coordinator takes, never an agent):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-aumfe-pod.sql
-- Times are epoch ms INTEGER. Money is whole rupees unless a column is named *_paise.

CREATE TABLE IF NOT EXISTS pod_catalog (
  provider TEXT NOT NULL,
  provider_product_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',        -- mens_tee|womens_tee|kids_tee|toddler_tee|hoodie|sweatshirt|polo|crop_top|crop_hoodie|other
  name TEXT NOT NULL,
  category TEXT,
  variants_json TEXT NOT NULL DEFAULT '[]',  -- [{provider_variant_id, colour, colour_hex, size, base_cost_paise, sku?}]
  size_chart_json TEXT,
  raw_json TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_product_id)
);
CREATE INDEX IF NOT EXISTS idx_pod_catalog_kind ON pod_catalog(provider, kind);

CREATE TABLE IF NOT EXISTS studio_designs (
  id TEXT PRIMARY KEY,                       -- 'dsn-' + 8 hex
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','live','retired')),
  step TEXT NOT NULL DEFAULT 'upload',       -- upload|product|design|photos|publish
  art_key TEXT, art_w INTEGER, art_h INTEGER, art_bytes INTEGER, art_mime TEXT, art_checks_json TEXT, art_preview_url TEXT,
  products_json TEXT NOT NULL DEFAULT '[]',  -- chosen [{kind, provider_product_id, side}]
  placement_json TEXT,
  print_key TEXT, print_w INTEGER, print_h INTEGER, print_sha256 TEXT, print_preview_url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  locked_at INTEGER,                         -- print file locked once published; edits -> version+1
  colours_json TEXT NOT NULL DEFAULT '[]',
  copy_json TEXT,
  prices_json TEXT,
  product_id TEXT,                           -- shop_products.id after publish
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_designs_status ON studio_designs(status, updated_at);

CREATE TABLE IF NOT EXISTS studio_photos (
  id TEXT PRIMARY KEY,                       -- 'sph-' + 8 hex
  design_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model','flat','closeup')),
  colour TEXT,
  url TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  checks_json TEXT,
  status TEXT NOT NULL DEFAULT 'kept' CHECK (status IN ('kept','removed')),
  sort INTEGER NOT NULL DEFAULT 0,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_photos_design ON studio_photos(design_id, kind);

CREATE TABLE IF NOT EXISTS pod_listings (
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  design_id TEXT,
  design_version INTEGER,
  provider_design_ref TEXT,
  provider_listing_ref TEXT,
  status TEXT NOT NULL,
  error TEXT,
  published_at INTEGER,
  PRIMARY KEY (product_id, provider)
);

CREATE TABLE IF NOT EXISTS pod_variant_map (
  product_id TEXT NOT NULL,
  colour TEXT NOT NULL,
  size TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_variant_id TEXT NOT NULL,
  base_cost_paise INTEGER,
  sku TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, colour, size, provider)
);

CREATE TABLE IF NOT EXISTS shop_fulfilments (
  order_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  reference_number TEXT NOT NULL UNIQUE,
  provider_order_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','printing','shipped','delivered','problem','cancelled')),
  request_json TEXT,
  last_response_json TEXT,
  provider_status TEXT,
  courier TEXT,
  awb TEXT,
  tracking_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_polled_at INTEGER,
  last_error TEXT,
  sent_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_fulfilments_retry ON shop_fulfilments(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_shop_fulfilments_poll ON shop_fulfilments(status, last_polled_at);

CREATE TABLE IF NOT EXISTS shop_fulfilment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  provider_status TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_fulfilment_events_order ON shop_fulfilment_events(order_id, at);
