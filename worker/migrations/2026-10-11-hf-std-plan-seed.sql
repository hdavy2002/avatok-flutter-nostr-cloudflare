-- [HF-STD-PLAN-1] INSERT / UPDATE only (run with `scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-11-hf-std-plan-seed.sql`).
-- Run AFTER 2026-10-11-hf-std-plan-alters.sql. Safe to run twice.
-- New pricing version gp-r2: wallet lots hold RUPEES (100 paise per unit; 1 paisa = 10,000 micro units). The credit of each Play purchase is
-- computed from Play's real INR price: wallet = paid / 1.18 (hfTopupGstBps), so Rs 120 adds Rs 101.69. The `tokens` column of a gp-r2
-- product is NOT used for crediting (kept only as the sort key); list_price_paise is the fallback price when Play reports no INR price.
INSERT OR IGNORE INTO hf_pricing_versions (id, provider, purchase_paise_per_token, redemption_paise_per_token, provider_fee_bps, tax_mode, effective_from, status, note)
VALUES ('gp-r2', 'google_play', 100, 100, 1500, 'none_unregistered', CAST(strftime('%s','now') AS INTEGER) * 1000, 'active',
        'HF-STD-PLAN-1: rupee wallet; credit = Play INR price / 1.18 (GST inclusive), to the paisa');
-- Keep the shipped gp-r1 SKUs intact for flag-OFF and old clients. Standard uses distinct Play SKUs, so a flag flip cannot reinterpret an
-- in-flight purchase. The updates repair a database that briefly received the superseded in-place gp-r2 seed and make reruns idempotent.
UPDATE hf_pricing_versions SET status = 'active' WHERE id = 'gp-r1';
UPDATE hf_token_products SET tokens=102,  pricing_version='gp-r1', list_price_paise=NULL, active=1 WHERE product_id='hf_tokens_100';
UPDATE hf_token_products SET tokens=204,  pricing_version='gp-r1', list_price_paise=NULL, active=1 WHERE product_id='hf_tokens_200';
UPDATE hf_token_products SET tokens=510,  pricing_version='gp-r1', list_price_paise=NULL, active=1 WHERE product_id='hf_tokens_500';
UPDATE hf_token_products SET tokens=1020, pricing_version='gp-r1', list_price_paise=NULL, active=1 WHERE product_id='hf_tokens_1000';
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active, list_price_paise) VALUES ('hf_rupees_120', 120, 'gp-r2', 1, 12000);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active, list_price_paise) VALUES ('hf_rupees_240', 240, 'gp-r2', 1, 24000);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active, list_price_paise) VALUES ('hf_rupees_600', 600, 'gp-r2', 1, 60000);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active, list_price_paise) VALUES ('hf_rupees_1200', 1200, 'gp-r2', 1, 120000);
UPDATE hf_token_products SET tokens=120,  pricing_version='gp-r2', active=1, list_price_paise=12000  WHERE product_id='hf_rupees_120';
UPDATE hf_token_products SET tokens=240,  pricing_version='gp-r2', active=1, list_price_paise=24000  WHERE product_id='hf_rupees_240';
UPDATE hf_token_products SET tokens=600,  pricing_version='gp-r2', active=1, list_price_paise=60000  WHERE product_id='hf_rupees_600';
UPDATE hf_token_products SET tokens=1200, pricing_version='gp-r2', active=1, list_price_paise=120000 WHERE product_id='hf_rupees_1200';
