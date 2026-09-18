-- Public ₹1 tests associate a self-reported payer, never verified identity.
-- Existing intents/receipts retain NULL: historical SMS cannot auto-confirm.
ALTER TABLE hdfc_sms_smoke_intents ADD COLUMN payer_vpa TEXT;
ALTER TABLE hdfc_sms_smoke_intents ADD COLUMN payer_phone TEXT;
ALTER TABLE hdfc_sms_smoke_receipts ADD COLUMN payer_vpa TEXT;
DROP INDEX hdfc_sms_smoke_one_active;
CREATE UNIQUE INDEX hdfc_sms_smoke_one_active
 ON hdfc_sms_smoke_intents(receiving_account_key)
 WHERE active=1 AND payer_vpa IS NULL;
CREATE UNIQUE INDEX hdfc_sms_public_payer_active
 ON hdfc_sms_smoke_intents(receiving_account_key,payer_vpa,amount_paise)
 WHERE active=1 AND payer_vpa IS NOT NULL;
CREATE UNIQUE INDEX hdfc_sms_public_owner_active
 ON hdfc_sms_smoke_intents(uid) WHERE active=1 AND payer_vpa IS NOT NULL;
CREATE INDEX hdfc_sms_public_payer_recovery
 ON hdfc_sms_smoke_intents(receiving_account_key,payer_vpa,amount_paise,recover_until);
