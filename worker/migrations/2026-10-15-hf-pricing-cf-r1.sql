-- [HF-CASHFREE-TOPUP-1] Pricing version for rupee-wallet credits bought on the website through Cashfree. Safe to run twice.
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-15-hf-pricing-cf-r1.sql
INSERT OR IGNORE INTO hf_pricing_versions (id, provider, purchase_paise_per_token, redemption_paise_per_token, provider_fee_bps, tax_mode, effective_from, status, note)
VALUES ('cf-r1', 'cashfree', 100, 100, 0, 'none_unregistered', CAST(strftime('%s','now') AS INTEGER) * 1000, 'active',
        'HF-CASHFREE-TOPUP-1: website top-up, any amount; credit = paid / 1.18 (GST inclusive), to the paisa');
