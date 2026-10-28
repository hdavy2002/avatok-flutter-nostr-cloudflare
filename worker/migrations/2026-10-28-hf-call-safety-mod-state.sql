-- [HF-CALL-SAFETY-BE] Account standing for call safety. No row = active. DB_META.
CREATE TABLE IF NOT EXISTS hf_mod_state (
  uid TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',      -- active|paused|banned
  reason TEXT,                                -- strikes|danger|admin|ban
  review_due_at INTEGER,
  prior_host_status TEXT,                     -- hf_hosts.status before our pause hid the profile (restored on restore)
  payout_pending INTEGER NOT NULL DEFAULT 0,  -- ban: matured earnings still to be paid out to the UPI
  updated_at INTEGER NOT NULL,
  by_uid TEXT
);
CREATE INDEX IF NOT EXISTS idx_hf_mod_state_status ON hf_mod_state(status, updated_at);
