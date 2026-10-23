-- [HF-MERCH-CORE-1 2026-10-23] Influencer merch shop -- CREATE-only half (indexes on the ALTERed columns are here too, so they
-- run AFTER the alters). Spec: Specs/SPEC-2026-10-23-HF-MERCH.md section 3. Apply (coordinator only):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-10-23-hf-merch-tables.sql
-- Times are epoch ms INTEGER, money is integer paise.

CREATE INDEX IF NOT EXISTS idx_shop_products_seller ON shop_products (seller_uid, review_status);
CREATE INDEX IF NOT EXISTS idx_shop_orders_seller ON shop_orders (seller_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_orders_approval ON shop_orders (approval_status, created_at);

-- Platform-only money ledger (admin eyes only). op_id = hfplat:<kind>:<order_id>, UNIQUE, so a retry never doubles a row.
-- kind: merch_share (+) | printrove_cost (-, payable) | cashfree_fee (-, estimate) | gst (-, estimate), and the four *_rev reversals on refund.
CREATE TABLE IF NOT EXISTS hf_platform_ledger (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  order_id TEXT,
  seller_uid TEXT,
  op_id TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_platform_ledger_time ON hf_platform_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_hf_platform_ledger_order ON hf_platform_ledger (order_id);

-- A fan's saved delivery addresses (max 5 per uid, enforced in code).
CREATE TABLE IF NOT EXISTS hf_merch_addresses (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_merch_addresses_uid ON hf_merch_addresses (uid, updated_at);
