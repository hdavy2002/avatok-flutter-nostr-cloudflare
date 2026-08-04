CREATE TABLE IF NOT EXISTS upi_accounts (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  vpa TEXT NOT NULL,
  vpa_hash TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  name_match TEXT NOT NULL DEFAULT 'unchecked',
  kyc_status TEXT NOT NULL DEFAULT 'missing',
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_active_uid ON upi_accounts(uid) WHERE status IN ('pending','verified');
CREATE INDEX IF NOT EXISTS idx_upi_vpa_hash ON upi_accounts(vpa_hash);

CREATE TABLE IF NOT EXISTS upi_payout_requests (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  upi_account_id TEXT NOT NULL,
  gross_coins INTEGER NOT NULL,
  gross_inr_paise INTEGER NOT NULL,
  tds_inr_paise INTEGER,
  net_inr_paise INTEGER NOT NULL,
  tax_year TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  wallet_ref TEXT NOT NULL,
  reserve_expires_at INTEGER NOT NULL,
  utr TEXT,
  bank_ref TEXT,
  admin_uid TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upi_req_status ON upi_payout_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_upi_req_uid ON upi_payout_requests(uid, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_req_utr ON upi_payout_requests(utr) WHERE utr IS NOT NULL;
