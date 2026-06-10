-- Phase 2 (marketplace plan, reconciled 2026-06-10) — double-entry ledger layered
-- onto the existing WalletDO engine. D1 binding DB_WALLET = avatok-wallet.
--
-- Balance authority for USER accounts stays WalletDO (per-user DO SQLite).
-- wallet_accounts here holds ESCROW + PLATFORM buckets ONLY — they have no DO
-- because nothing races on them; the Q_WALLET consumer recomputes their balance
-- from the ledger inside the same batch that inserts the row (idempotent).
-- 1 AvaCoin = $0.01. Integer coins everywhere.

-- Escrow + platform buckets (user balances live in WalletDO; mirror in wallet_balances).
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id          TEXT PRIMARY KEY,           -- 'escrow:<orderId>' | 'platform:fees'
  kind        TEXT NOT NULL,              -- 'escrow' | 'platform'
  balance     INTEGER NOT NULL DEFAULT 0, -- coins
  updated_at  INTEGER NOT NULL
);

-- Immutable double-entry ledger. id = op_id (the idempotency id carried through
-- WalletDO and Q_WALLET), so replays are PK no-ops. Rows are NEVER edited/deleted;
-- 'adjustment' type is reserved for admin fixes (applied via WalletDO + ledger).
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id          TEXT PRIMARY KEY,           -- op_id
  debit       TEXT NOT NULL,              -- account money leaves:  'user:<clerkId>' | 'escrow:<orderId>' | 'platform:fees' | 'external:stripe' | 'external:wise'
  credit      TEXT NOT NULL,              -- account money enters
  amount      INTEGER NOT NULL,           -- coins (always positive)
  type        TEXT NOT NULL,              -- topup|purchase_hold|escrow_release|refund|fee|payout|storage_charge|donation|adjustment
  ref         TEXT,                       -- orderId / bookingId / eventId / stripe pi_... / cs_...
  meta        TEXT,                       -- JSON: title, counterpart name, fee breakdown, reason
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_acct_time  ON wallet_ledger(debit,  created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_acct_time2 ON wallet_ledger(credit, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref        ON wallet_ledger(ref);
-- One topup credit per Stripe payment: replays of the webhook no-op on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_topup_ref ON wallet_ledger(ref) WHERE type = 'topup';

-- Money-ops console audit trail (A2): every admin action is logged.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL,
  action      TEXT NOT NULL,              -- 'refund' | 'adjust' | 'ledger_search' | 'account_view' | 'escrow_hold' | 'escrow_release'
  target      TEXT,                       -- uid / orderId / account id
  meta        TEXT,                       -- JSON: amount, reason, query
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit(created_at DESC);

-- Nightly reconciliation results (A2). ok=1 → all invariants held.
CREATE TABLE IF NOT EXISTS recon_runs (
  date        TEXT PRIMARY KEY,           -- 'YYYY-MM-DD' (UTC)
  ok          INTEGER NOT NULL,           -- 0|1
  diff_json   TEXT,                       -- JSON array of mismatches (empty when ok)
  created_at  INTEGER NOT NULL
);
