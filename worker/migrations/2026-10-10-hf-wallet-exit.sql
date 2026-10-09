-- [HF-WALLET-EXIT-1] Refunds of unused top-up money + pay-out-first account closure. DB_META. Contract: Specs/HF-CALLS-CONTRACT.md
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-10-hf-wallet-exit.sql
-- The two ALTER TABLE lines at the bottom fail harmlessly if re-run once the columns exist; run the file once.
CREATE TABLE IF NOT EXISTS hf_refund_requests (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  amount_rupees INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',   -- requested|approved|processing|refunded|failed|rejected|cancelled
  reason TEXT,                                 -- admin reject reason, or a system note
  wallet_ref TEXT,                             -- WalletDO reservation ref: hfrefund:<id>
  allocations TEXT NOT NULL DEFAULT '[]',      -- JSON [{topupId, rupees, status: pending|refunded|manual|failed, gatewayRefundId?, error?}]
  utr TEXT,                                    -- set when an admin pays by hand
  admin_uid TEXT,
  exit INTEGER NOT NULL DEFAULT 0,             -- 1 = created by the account-closure flow
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS hf_refund_requests_uid ON hf_refund_requests(uid, created_at);
CREATE INDEX IF NOT EXISTS hf_refund_requests_status ON hf_refund_requests(status, created_at);

CREATE TABLE IF NOT EXISTS hf_exit_requests (
  uid TEXT PRIMARY KEY,
  status TEXT NOT NULL,                        -- waiting_hold|waiting_payouts|ready|done|cancelled
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payout_id TEXT,                              -- hf_payout_requests.id of the exit payout
  refund_id TEXT,                              -- hf_refund_requests.id of the exit refund
  note TEXT
);
CREATE INDEX IF NOT EXISTS hf_exit_requests_status ON hf_exit_requests(status, updated_at);

ALTER TABLE hf_topups ADD COLUMN refunded_rupees INTEGER DEFAULT 0;
ALTER TABLE hf_payout_requests ADD COLUMN exit INTEGER DEFAULT 0;
