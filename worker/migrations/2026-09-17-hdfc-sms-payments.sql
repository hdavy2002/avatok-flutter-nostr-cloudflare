-- [PAY-HDFC-SMS-1] Staging-first private UPI/SMS payment rail.
CREATE TABLE IF NOT EXISTS hdfc_sms_receipts (
  message_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  message TEXT NOT NULL,
  received_at TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hdfc_sms_payment_intents (
  intent_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind='live_event'),
  amount_paise INTEGER NOT NULL CHECK (amount_paise>0),
  status TEXT NOT NULL CHECK (status IN ('pending','payment_received','confirmed','expired','review_pending')),
  bank_reference TEXT,
  commercial_order_id TEXT,
  last_error TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hdfc_intents_match ON hdfc_sms_payment_intents(status,amount_paise,expires_at);
CREATE INDEX IF NOT EXISTS idx_hdfc_intents_uid ON hdfc_sms_payment_intents(uid,created_at);
