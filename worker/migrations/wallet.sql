-- Phase 2 (v5.2 §10.1) — AvaWallet. D1 binding DB_WALLET = avatok-wallet (APAC).
-- AUTHORITATIVE balance math lives in WalletDO (per-user SQLite, atomic). These D1
-- tables are the ASYNC AUDIT TRAIL (via Q_WALLET) + queryable history/holds. Never
-- compute spendable balance from here — read the DO.
-- 1 AvaCoin = $0.01 (~₹0.85). Amounts are integer coins. ⚠️ Real money-in is
-- flag-gated OFF in prod pending legal (§10.1).

-- Mirror of each user's current balance (eventually-consistent; DO is source of truth).
CREATE TABLE IF NOT EXISTS wallet_balances (
  uid        TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL DEFAULT 0,   -- coins
  held        INTEGER NOT NULL DEFAULT 0,   -- coins in 7-day earning hold (not yet spendable)
  updated_at  INTEGER NOT NULL
);

-- Append-only audit ledger.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                TEXT PRIMARY KEY,        -- uuid
  uid              TEXT NOT NULL,
  type              TEXT NOT NULL,           -- 'topup'|'spend'|'earn'|'hold_release'|'refund'|'gift'|'payout'
  amount            INTEGER NOT NULL,        -- signed: +credit / -debit (coins)
  balance_after     INTEGER,                 -- balance snapshot after applying (best-effort)
  app_name          TEXT,                    -- which app drove it
  counterparty_uid TEXT,                    -- the other side (creator/buyer), if any
  commission        INTEGER NOT NULL DEFAULT 0, -- coins taken as commission (on earns)
  ref               TEXT,                    -- free-form reference (listing id, stream id, session id) — NO PII
  status            TEXT NOT NULL DEFAULT 'settled', -- 'settled'|'pending'|'reversed'
  created_at        INTEGER NOT NULL,
  -- [WALLET-TXMETA-1] Rich charge metadata carried from the charge call site, so the
  -- wallet statement can show what a charge was FOR without a cross-DB lookup at read
  -- time. All nullable/additive (see 2026-07-22-wallet-tx-metadata.sql for existing DBs).
  category          TEXT,                    -- call|agent|transcribe|ava|video|market|topup|payout
  context           TEXT,                    -- short human string, e.g. "Voicemail from Marcus Reyes" (<=120 chars)
  counterparty_name TEXT,                    -- the other party's display name
  duration_sec      INTEGER,                 -- metered duration in seconds
  rate_per_min      REAL                     -- tokens per minute (Duration x Rate breakdown)
);
CREATE INDEX IF NOT EXISTS idx_wtx_uid ON wallet_transactions(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_wtx_type ON wallet_transactions(type, created_at);

-- Stripe top-up sessions (real-money in). status flips on webhook.
CREATE TABLE IF NOT EXISTS topup_records (
  id                TEXT PRIMARY KEY,        -- uuid
  uid              TEXT NOT NULL,
  stripe_session_id TEXT,                    -- Checkout Session id
  amount_coins      INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL,        -- USD cents charged (coins * 1)
  currency          TEXT NOT NULL DEFAULT 'usd',
  status            TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'paid'|'failed'|'expired'
  created_at        INTEGER NOT NULL,
  paid_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_topup_uid ON topup_records(uid, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_session ON topup_records(stripe_session_id);

-- 7-day earnings hold (§10.1). Cron releases matured holds → spendable.
CREATE TABLE IF NOT EXISTS earning_holds (
  id            TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  amount        INTEGER NOT NULL,            -- coins held
  source_app    TEXT,
  source_tx_id  TEXT,
  available_at  INTEGER NOT NULL,            -- created_at + 7 days
  released      INTEGER NOT NULL DEFAULT 0,  -- 0|1
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holds_release ON earning_holds(released, available_at);
CREATE INDEX IF NOT EXISTS idx_holds_uid ON earning_holds(uid, released);

-- Per-app commission rates (§10.1). Seeded; editable.
CREATE TABLE IF NOT EXISTS commission_rates (
  app_name    TEXT PRIMARY KEY,
  rate        REAL NOT NULL,                 -- 0..1 (e.g. 0.30 = 30%)
  updated_at  INTEGER NOT NULL
);
INSERT INTO commission_rates (app_name, rate, updated_at) VALUES
  ('avalive',   0.30, 0),
  ('avadate',   0.25, 0),
  ('avamatri',  0.25, 0),
  ('avachat',   0.20, 0),
  ('gifts',     0.30, 0),
  ('avalinked', 0.20, 0),
  ('avatube',   0.25, 0),
  ('avaolx',    0.15, 0)
ON CONFLICT(app_name) DO NOTHING;
