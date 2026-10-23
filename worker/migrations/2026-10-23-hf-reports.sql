-- [HF-DAILY-FLOWS-1] /report form stored (was an email draft only). Apply with the usual D1 migration step before the worker deploy:
-- the route answers 503 not_ready until this table exists, and the page then falls back to the email draft.
CREATE TABLE IF NOT EXISTS hf_reports (
  id TEXT PRIMARY KEY,
  uid TEXT,                              -- set when the reporter was signed in
  contact TEXT NOT NULL,                 -- what the reporter typed (phone or email)
  profile TEXT NOT NULL,
  call_ref TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | closed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_reports_status ON hf_reports(status, created_at);
