-- [HF-MERCH-CORE-1 2026-10-23] Influencer merch shop -- ALTER-only half. Spec: Specs/SPEC-2026-10-23-HF-MERCH.md section 3.
-- ALTER and CREATE live in SEPARATE files (d1_apply_alters.py only applies ALTERs). Apply (coordinator only, never an agent):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-10-23-hf-merch-alters.sql --binding DB_META
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-10-23-hf-merch-tables.sql
-- Apply BOTH before the worker that contains HF-MERCH-CORE-1 is deployed (the 5-minute fulfilment tick reads approval_status).
-- shop_orders.delivered_at ALREADY exists (2026-10-01-saathum-shop.sql) and is reused: it is NOT added again here.
-- hf_host_ledger.kind has NO CHECK constraint (2026-10-10-hf-tokens.sql), so kind 'merch_earning' needs no table rebuild.

-- Influencer-owned products live in shop_products with status='hidden' (so the house shop, which reads status='live', never shows
-- them); their public visibility is review_status='live'.
ALTER TABLE shop_products ADD COLUMN seller_uid TEXT;
ALTER TABLE shop_products ADD COLUMN review_status TEXT;          -- draft|pending|live|rejected|hidden (NULL = house product)
ALTER TABLE shop_products ADD COLUMN review_note TEXT;
ALTER TABLE shop_products ADD COLUMN markup_rupees INTEGER;
ALTER TABLE shop_products ADD COLUMN design_id TEXT;              -- studio_designs.id (the print file row)
ALTER TABLE shop_products ADD COLUMN deleted_at INTEGER;
ALTER TABLE shop_products ADD COLUMN merch_json TEXT;             -- frozen product facts: catalogue product, sizes+base price, placement, mockups (additive to the spec)

ALTER TABLE shop_orders ADD COLUMN seller_uid TEXT;
ALTER TABLE shop_orders ADD COLUMN pay_method TEXT;               -- wallet|cashfree (NULL = legacy UPI shop order)
ALTER TABLE shop_orders ADD COLUMN merch_json TEXT;               -- frozen snapshot (money split, product, colour, size, qty, image, design)
ALTER TABLE shop_orders ADD COLUMN approval_status TEXT;          -- pending|approved|rejected (NULL = not a merch order)
ALTER TABLE shop_orders ADD COLUMN approved_by TEXT;
ALTER TABLE shop_orders ADD COLUMN approved_at INTEGER;
ALTER TABLE shop_orders ADD COLUMN reject_reason TEXT;
ALTER TABLE shop_orders ADD COLUMN cashfree_order_id TEXT;
ALTER TABLE shop_orders ADD COLUMN wallet_op_id TEXT;
ALTER TABLE shop_orders ADD COLUMN refund_status TEXT;            -- none|done|pending_manual
ALTER TABLE shop_orders ADD COLUMN earning_credited_at INTEGER;
