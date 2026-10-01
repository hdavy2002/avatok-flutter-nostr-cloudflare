-- [SAATHUM-SHOP-EDITOR-2 2026-10-02] Two flags on a product: "Show in New arrivals" and "Mark as Bestseller (premium)".
-- They are the single source of truth for the shop home's New arrivals / Bestsellers rows and for /shop/all?tag=new|best.
-- ALTER-only (CLAUDE.md D1 rule). Apply with the idempotent runner (safe to run twice):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-10-02-saathum-shop-flags.sql --binding DB_META
-- The code tolerates these columns being missing until this is applied (it reads them as 0), so deploy order cannot 500 the shop.
ALTER TABLE shop_products ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_products ADD COLUMN is_bestseller INTEGER NOT NULL DEFAULT 0;
