-- AvaAdmin — platform Mission-Control dashboard (PHASE 6).
-- Additive ONLY (CREATE TABLE IF NOT EXISTS). Lives in DB_WALLET alongside
-- admin_audit so the audit / roles / alerts data sits together. Apply to the
-- avatok-wallet D1 (prod + staging). Do NOT ALTER any existing table.

-- Tiered admin access (§5.14). A uid present in ADMIN_UIDS with NO row here
-- defaults to 'super' (so the current ADMIN_UIDS-only setup keeps working).
CREATE TABLE IF NOT EXISTS admin_roles (
  uid         TEXT PRIMARY KEY,
  role        TEXT NOT NULL,             -- 'super' | 'finance' | 'analyst' | 'readonly'
  granted_by  TEXT,                      -- admin uid that set this role
  created_at  INTEGER NOT NULL
);

-- Admin-defined alert thresholds (§5.12).
CREATE TABLE IF NOT EXISTS admin_alert_rules (
  id          TEXT PRIMARY KEY,
  metric      TEXT NOT NULL,             -- 'error_rate'|'recon_diff'|'escrow_imbalance'|'failed_payout'|'csam_hit'|'agent_saturation'|'settlement_dlq'
  comparator  TEXT NOT NULL,             -- 'gt'|'gte'|'lt'|'lte'|'eq'|'ne'
  threshold   REAL NOT NULL,
  window_sec  INTEGER NOT NULL DEFAULT 3600,
  channels    TEXT NOT NULL DEFAULT '[]', -- JSON array: ['email','slack','push']
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Opened alerts (an evaluation pass writes a row when a rule trips) (§5.12).
CREATE TABLE IF NOT EXISTS admin_alerts (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT,                    -- FK admin_alert_rules.id (nullable for ad-hoc)
  metric        TEXT NOT NULL,
  observed      REAL NOT NULL,           -- the value that tripped the rule
  threshold     REAL NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'warning', -- 'critical'|'warning'|'info'
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',     -- 'open'|'acknowledged'|'resolved'
  acked_by      TEXT,
  acked_at      INTEGER,
  resolved_by   TEXT,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_status ON admin_alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_alert_rules_enabled ON admin_alert_rules(enabled);
