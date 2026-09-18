-- [HDFC-SMS-2] Two-table smoke authority. The migration-only seed creates the
-- readiness VIEW after reserving every legacy hash/reference in one transaction.
-- Applying this schema alone intentionally does NOT enable ingress or claims.
CREATE TABLE IF NOT EXISTS hdfc_sms_smoke_intents (
 intent_id TEXT PRIMARY KEY,
 uid TEXT NOT NULL,
 request_key TEXT NOT NULL,
 receiving_account_key TEXT NOT NULL,
 amount_paise INTEGER NOT NULL DEFAULT 100 CHECK(amount_paise=100),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 recover_until INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 superseded_by TEXT,
 payer_reference TEXT CHECK(payer_reference IS NULL OR (length(payer_reference)=12 AND payer_reference NOT GLOB '*[^0-9]*')),
 reference_revision INTEGER NOT NULL DEFAULT 0 CHECK(reference_revision>=0),
 updated_at INTEGER NOT NULL,
 UNIQUE(uid,request_key),
 CHECK(expires_at>created_at AND recover_until=expires_at+86400000)
);
CREATE UNIQUE INDEX IF NOT EXISTS hdfc_sms_smoke_one_active
 ON hdfc_sms_smoke_intents(receiving_account_key,uid) WHERE active=1;
CREATE TABLE IF NOT EXISTS hdfc_sms_smoke_receipts (
 message_hash TEXT PRIMARY KEY,
 receiving_account_key TEXT NOT NULL,
 bank_reference TEXT CHECK(bank_reference IS NULL OR (length(bank_reference)=12 AND bank_reference NOT GLOB '*[^0-9]*')),
 amount_paise INTEGER,
 currency TEXT,
 received_at_ms INTEGER,
 received_at_end_ms INTEGER,
 ingested_at INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('accepted','review_required','legacy')),
 reason_code TEXT,
 claimed_intent_id TEXT UNIQUE REFERENCES hdfc_sms_smoke_intents(intent_id),
 claimed_at INTEGER,
 CHECK((claimed_intent_id IS NULL)=(claimed_at IS NULL)),
 CHECK(disposition='legacy' OR (amount_paise IS NOT NULL AND typeof(amount_paise)='integer' AND amount_paise>0 AND currency IS NOT NULL AND currency='INR' AND received_at_ms IS NOT NULL AND received_at_end_ms IS NOT NULL AND received_at_end_ms>=received_at_ms AND received_at_end_ms-received_at_ms<=999)),
 CHECK(disposition<>'legacy' OR claimed_intent_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS hdfc_sms_smoke_bank_identity
 ON hdfc_sms_smoke_receipts(receiving_account_key,bank_reference) WHERE bank_reference IS NOT NULL;
