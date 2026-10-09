-- [HF-PAYOUT-1] HF host withdrawals (manual). DB_META. Contract: Specs/HF-CALLS-CONTRACT.md
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-payouts.sql
CREATE TABLE IF NOT EXISTS hf_payout_requests (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  amount_rupees INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',   -- requested|approved|paid|rejected|cancelled
  bank_snapshot TEXT,                         -- JSON {accountLast4, ifsc, name}; never the full account number
  wallet_ref TEXT,                            -- WalletDO reservation ref: hfpayout:<id>
  utr TEXT,
  reject_reason TEXT,
  admin_uid TEXT,
  withdrawable_at_request INTEGER,            -- what the host could withdraw when asking (shown to the admin)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS hf_payout_requests_host ON hf_payout_requests(host_uid, created_at);
CREATE INDEX IF NOT EXISTS hf_payout_requests_status ON hf_payout_requests(status, created_at);
