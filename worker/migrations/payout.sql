-- Phase 4 (v5.2 §10.3) — AvaPayout. Tables in DB_WALLET (avatok-wallet). Creators
-- withdraw earned coins to a bank account via Wise. Min 1,000 coins ($10); only
-- spendable (post-7-day-hold) coins are withdrawable. ⚠️ PRODUCTION TRANSFERS ARE
-- FLAG-GATED OFF pending legal (§10.3 BLOCKING).

-- A creator's linked payout destination (bank account → Wise recipient).
CREATE TABLE IF NOT EXISTS payout_accounts (
  id                 TEXT PRIMARY KEY,
  npub               TEXT NOT NULL,
  label              TEXT,                  -- user label, e.g. "HDFC ****1234"
  country            TEXT NOT NULL DEFAULT 'IN',
  currency           TEXT NOT NULL DEFAULT 'INR',
  account_holder     TEXT,                  -- name on account (PII — kept here, never logged)
  ifsc               TEXT,                  -- India IFSC (other countries: routing/IBAN)
  account_number_last4 TEXT,                -- only the last 4 stored for display
  wise_recipient_id  TEXT,                  -- Wise recipient account id (once created)
  status             TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'verified'|'rejected'
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payacct_npub ON payout_accounts(npub, status);

-- Withdrawal requests. Lifecycle: requested → quoted → transferred → funded →
-- (webhook) completed | failed. Coins debited from WalletDO at request time.
CREATE TABLE IF NOT EXISTS payout_requests (
  id               TEXT PRIMARY KEY,
  npub             TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  amount_coins     INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL,         -- USD cents (coins * 1)
  target_currency  TEXT NOT NULL DEFAULT 'INR',
  wise_quote_id    TEXT,
  wise_transfer_id TEXT,
  status           TEXT NOT NULL DEFAULT 'requested', -- 'requested'|'quoted'|'transferred'|'funded'|'completed'|'failed'|'refunded'
  failure_reason   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payreq_npub ON payout_requests(npub, created_at);
CREATE INDEX IF NOT EXISTS idx_payreq_status ON payout_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payreq_transfer ON payout_requests(wise_transfer_id);
