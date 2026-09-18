-- Allow independent anonymous customers to have separate waiting attempts.
-- Private/admin smoke flows still enforce their single-attempt guard in code.
DROP INDEX IF EXISTS hdfc_sms_smoke_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS hdfc_sms_smoke_one_active
 ON hdfc_sms_smoke_intents(receiving_account_key,uid) WHERE active=1;
