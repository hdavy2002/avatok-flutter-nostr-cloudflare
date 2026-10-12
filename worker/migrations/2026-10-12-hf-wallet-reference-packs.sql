-- [HF-REF-WALLET-1] Exact wallet catalogue used by the native reference screen.
--
-- These are fixed Google Play catalogue products. The purchase price remains
-- authoritative from Play; list_price_paise is only the honest INR fallback
-- when Play cannot return localized product details.

INSERT OR IGNORE INTO hf_token_products
  (product_id, tokens, pricing_version, active, list_price_paise)
VALUES
  ('hf_rupees_360', 360, 'gp-r2', 1, 36000),
  ('hf_rupees_500', 500, 'gp-r2', 1, 50000);

UPDATE hf_token_products
SET tokens=360, pricing_version='gp-r2', active=1, list_price_paise=36000
WHERE product_id='hf_rupees_360';

UPDATE hf_token_products
SET tokens=500, pricing_version='gp-r2', active=1, list_price_paise=50000
WHERE product_id='hf_rupees_500';

-- The exact screen exposes four safe fixed choices: 120, 240, 360 and 500.
-- Do not offer a typed arbitrary amount or the superseded 600/1200 packs.
UPDATE hf_token_products
SET active=0
WHERE product_id IN ('hf_rupees_600', 'hf_rupees_1200');
