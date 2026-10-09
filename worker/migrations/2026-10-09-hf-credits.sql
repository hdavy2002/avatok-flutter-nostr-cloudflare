-- [HF-WALLET-1] HF test credits: spend-only, kept apart from the withdrawable paid wallet. DB_META. Contract: Specs/HF-CALLS-CONTRACT.md
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-credits.sql
-- (the ALTER TABLE lines fail harmlessly if re-run once the columns exist; run them once)
CREATE TABLE IF NOT EXISTS hf_credits (
  uid TEXT PRIMARY KEY,
  test_balance INTEGER NOT NULL DEFAULT 0,        -- whole rupees, spendable on HF calls only
  test_reserved INTEGER NOT NULL DEFAULT 0,       -- held for calls in progress
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS hf_credit_ledger (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,                             -- grant|call_reserve|call_spend|migrate|admin_reverse
  ref TEXT,
  op_id TEXT UNIQUE NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_credit_ledger_uid ON hf_credit_ledger(uid, created_at);

-- Host share of calls paid with test credits: never withdrawable, never enters the wallet.
CREATE TABLE IF NOT EXISTS hf_host_test_earnings (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  call_id TEXT NOT NULL UNIQUE,
  rupees INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_host_test_earnings_host ON hf_host_test_earnings(host_uid, created_at);

ALTER TABLE hf_calls ADD COLUMN paid_rupees INTEGER;
ALTER TABLE hf_calls ADD COLUMN test_rupees INTEGER;
ALTER TABLE hf_calls ADD COLUMN host_paid_rupees INTEGER;
ALTER TABLE hf_calls ADD COLUMN host_test_rupees INTEGER;
