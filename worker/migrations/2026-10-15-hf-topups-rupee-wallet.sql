-- [HF-CASHFREE-TOPUP-1] Website top-ups land in the RUPEE wallet (hf_token_lots, pricing cf-r1) with 18% GST taken out:
-- wallet_paise = paid / 1.18 (to the paisa), gst_paise = paid - wallet_paise. ALTERs only (apply with scripts/d1_apply_alters.py
-- or one --command each). The pricing seed is in 2026-10-15-hf-pricing-cf-r1.sql.
ALTER TABLE hf_topups ADD COLUMN wallet_paise INTEGER;
ALTER TABLE hf_topups ADD COLUMN gst_paise INTEGER;
ALTER TABLE hf_topups ADD COLUMN lot_id TEXT;
