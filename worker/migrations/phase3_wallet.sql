-- Phase 3 — AvaPayout tax-data capture (A1 compliance runway). DB_WALLET.
-- We store what year-end reporting (1099-K / DAC7) will need — no tax math yet.
-- Collected in the add-bank flow (after KYC, before first withdrawal).
ALTER TABLE payout_accounts ADD COLUMN tax_country TEXT;       -- tax residency (ISO-3166-1 a2)
ALTER TABLE payout_accounts ADD COLUMN tax_id_type TEXT;       -- 'pan'|'ssn'|'ein'|'vat'|'tin'|...
ALTER TABLE payout_accounts ADD COLUMN tax_id_last4 TEXT;      -- last 4 only — never the full id
ALTER TABLE payout_accounts ADD COLUMN tax_form_status TEXT NOT NULL DEFAULT 'missing'; -- 'missing'|'collected'
