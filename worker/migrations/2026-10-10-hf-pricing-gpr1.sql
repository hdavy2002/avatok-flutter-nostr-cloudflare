-- [HF-WALLET-RUPEES] No tokens for the user: the caller wallet holds rupees. Play packs (product ids unchanged) cost Rs 120 / 240 / 600 / 1,200
-- and add Rs 102 / 204 / 510 / 1,020 to the wallet. New pricing version gp-r1: 1 internal unit = Rs 1 of call value (redemption 100 paise).
-- purchase_paise_per_token = 118 is only an APPROXIMATE fallback (about 120/102), used when Play does not report an INR price; paid_paise
-- always comes from Play's real price. (gp-v2 was never deployed; this replaces it.)
-- INSERT / UPDATE only (no ALTERs, no CREATEs): run with `wrangler d1 execute --file`. Safe to run twice and safe on a DB that is still on gp-v1:
-- the insert is IGNORE and the pack updates only touch rows that are still on gp-v1. Existing lots keep their own pricing_version and value (old gp-v1 lots stay Rs 0.82).
INSERT OR IGNORE INTO hf_pricing_versions (id, provider, purchase_paise_per_token, redemption_paise_per_token, provider_fee_bps, tax_mode, effective_from, status, note)
VALUES ('gp-r1', 'google_play', 118, 100, 1500, 'none_unregistered', CAST(strftime('%s','now') AS INTEGER) * 1000, 'active', 'HF-WALLET-RUPEES: packs Rs 120/240/600/1200 add Rs 102/204/510/1020 to the wallet; 1 unit = Rs 1');
UPDATE hf_pricing_versions SET status = 'retired' WHERE id = 'gp-v1' AND status = 'active' AND EXISTS (SELECT 1 FROM hf_pricing_versions WHERE id = 'gp-r1');
UPDATE hf_token_products SET tokens = 102,  pricing_version = 'gp-r1' WHERE product_id = 'hf_tokens_100'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 204,  pricing_version = 'gp-r1' WHERE product_id = 'hf_tokens_200'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 510,  pricing_version = 'gp-r1' WHERE product_id = 'hf_tokens_500'  AND pricing_version = 'gp-v1';
UPDATE hf_token_products SET tokens = 1020, pricing_version = 'gp-r1' WHERE product_id = 'hf_tokens_1000' AND pricing_version = 'gp-v1';
