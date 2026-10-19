-- [HF-WIRE-13] Call money monitor: cases the monitor could not (or must not) fix on its own, for an admin to read. DB_META.
-- CREATE only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-money-audit.sql)
-- One row per (subject, rule): the monitor upserts, so running it again never makes a second row.
CREATE TABLE IF NOT EXISTS hf_money_audit (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'call' | 'booking'
  subject_type TEXT NOT NULL,         -- 'call' | 'booking'
  subject_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'open' (admin to look) | 'fixed' (monitor put it right) | 'resolved' (admin closed it)
  uid TEXT,                           -- the caller / customer
  host_uid TEXT,
  expected_paise INTEGER,
  actual_paise INTEGER,
  detail TEXT,                        -- JSON
  fix_op_id TEXT,                     -- ledger op id of the correction when status='fixed'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, rule)
);
CREATE INDEX IF NOT EXISTS hf_money_audit_status ON hf_money_audit(status, created_at);
CREATE INDEX IF NOT EXISTS hf_money_audit_uid ON hf_money_audit(uid);
CREATE INDEX IF NOT EXISTS hf_money_audit_host ON hf_money_audit(host_uid);
