-- [HF-VOBIZ-SPEND-1] Hello Fraands Vobiz spend monitor. DB_META. Contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md
-- CREATE TABLE / INDEX only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-10-hf-vobiz-spend.sql)
-- Money = paise (INTEGER). Times = epoch ms (INTEGER).
-- NEVER PURGED: owner decision - keep these records 8 years. No cron may DELETE from any hf_vobiz_* table.
-- Chained tables (legs, leg_cdr_log, balance, recharges) carry row_hash/prev_hash (sha256 chain); see lib/hf_vobiz_ledger.ts.

CREATE TABLE IF NOT EXISTS hf_vobiz_legs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_uuid TEXT NOT NULL UNIQUE,
  call_id TEXT,
  role TEXT NOT NULL,
  user_uid TEXT,
  direction TEXT,
  from_number TEXT, to_number TEXT,
  start_at INTEGER, answer_at INTEGER, end_at INTEGER,
  duration_sec INTEGER, billsec INTEGER,
  cost_paise INTEGER, streaming_cost_paise INTEGER, total_cost_paise INTEGER, currency TEXT,
  hangup_cause TEXT, hangup_source TEXT, mos REAL,
  source TEXT NOT NULL,
  webhook_json TEXT,
  cdr_json TEXT,
  cdr_checked_at INTEGER,
  cdr_attempts INTEGER NOT NULL DEFAULT 0,
  mismatch TEXT,
  created_at INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_vobiz_legs_call ON hf_vobiz_legs(call_id);
CREATE INDEX IF NOT EXISTS hf_vobiz_legs_user ON hf_vobiz_legs(user_uid, end_at);
CREATE INDEX IF NOT EXISTS hf_vobiz_legs_end ON hf_vobiz_legs(end_at);
CREATE INDEX IF NOT EXISTS hf_vobiz_legs_cdr ON hf_vobiz_legs(cdr_checked_at, cdr_attempts);

CREATE TABLE IF NOT EXISTS hf_vobiz_leg_cdr_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_uuid TEXT NOT NULL,
  cdr_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_vobiz_leg_cdr_log_leg ON hf_vobiz_leg_cdr_log(leg_uuid);

CREATE TABLE IF NOT EXISTS hf_vobiz_balance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  balance_paise INTEGER, available_paise INTEGER, reserved_paise INTEGER, promo_paise INTEGER, credit_limit_paise INTEGER,
  status TEXT,
  account_active INTEGER, account_enabled INTEGER, risk_status TEXT,
  ok INTEGER NOT NULL,
  http_status INTEGER, error TEXT, raw_json TEXT,
  row_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_vobiz_balance_at ON hf_vobiz_balance(at);

CREATE TABLE IF NOT EXISTS hf_vobiz_recharges (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  kind TEXT NOT NULL,
  utr TEXT, invoice_no TEXT, note TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_vobiz_recharges_at ON hf_vobiz_recharges(at);

CREATE TABLE IF NOT EXISTS hf_vobiz_alerts (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  amount_paise INTEGER,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  sent_whatsapp INTEGER NOT NULL DEFAULT 0,
  sent_email INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  acked_by TEXT
);
CREATE INDEX IF NOT EXISTS hf_vobiz_alerts_created ON hf_vobiz_alerts(created_at);

CREATE TABLE IF NOT EXISTS hf_vobiz_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  period_from INTEGER NOT NULL,
  period_to INTEGER NOT NULL,
  user_uid TEXT,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  emailed_to TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hf_vobiz_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
