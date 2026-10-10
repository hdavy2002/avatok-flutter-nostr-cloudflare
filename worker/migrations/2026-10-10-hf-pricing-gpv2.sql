-- [HF-TOK-GPV2] Google Play packs are now Rs 120 / 240 / 600 / 1,200 (Play Console already changed; product ids cannot change).
-- New pricing version gp-v2: buyer pays 60 paise a token, a token is worth 51 paise of call time (Rs 120 -> 200 tokens -> Rs 102).
-- INSERT / UPDATE only (no ALTERs, no CREATEs): run with `wrangler d1 execute --file`. Safe to run twice: the insert is IGNORE and the
-- pack updates only touch rows that are still on gp-v1. Existing lots keep their own pricing_version and value (old gp-v1 lots stay Rs 0.82).
INSERT OR IGNORE INTO hf_pricing_versions (id, provider, purchase_paise_per_token, redemption_paise_per_token, provider_fee_bps, tax_mode, effective_from, status, note)
VALUES ('gp-v2', 'google_play', 60, 51, 1500, 'none_unregistered', CAST(strftime('%s','now') AS INTEGER) * 1000, 'active', 'HF-TOK-GPV2: packs Rs 120/240/600/1200 give 200/400/1000/2000 tokens; 1 token = Rs 0.51 of call value');
UPDATE hf_pricing_versions SET status = 'retired' WHERE id = 'gp-v1' AND status = 'active' AND EXISTS (SELECT 1 FROM hf_pricing_versions WHERE id = 'gp-v2');
UPDATE hf_token_products SET tokens = 200,  pricing_version = 'gp-v2' WHERE product_id = 'hf_tokens_100'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 400,  pricing_version = 'gp-v2' WHERE product_id = 'hf_tokens_200'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 1000, pricing_version = 'gp-v2' WHERE product_id = 'hf_tokens_500'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 2000, pricing_version = 'gp-v2' WHERE product_id = 'hf_tokens_1000' AND pricing_version = 'gp-v1';
