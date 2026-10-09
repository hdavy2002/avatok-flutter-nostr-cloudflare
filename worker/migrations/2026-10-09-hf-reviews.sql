-- [HF-CALLS-1] Hello Fraands reviews + notify-me (DB_META). CREATE-only; apply with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-reviews.sql
-- hf_calls (calls agent) is read defensively; these tables do not depend on it existing.
CREATE TABLE IF NOT EXISTS hf_reviews (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,                 -- one review per completed paid call
  caller_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '',
  topic TEXT,                                   -- a TOPICS slug (lib/hf_options.ts) or NULL
  first_name TEXT NOT NULL DEFAULT 'A caller',  -- snapshot of the caller's first name at submit time
  minutes INTEGER NOT NULL DEFAULT 0,           -- billed minutes of the call, snapshot
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reject_reason TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hf_reviews_host ON hf_reviews(host_uid, status, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_reviews_status ON hf_reviews(status, created_at);
CREATE TABLE IF NOT EXISTS hf_review_tokens (
  token TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_review_tokens_call ON hf_review_tokens(call_id);
CREATE TABLE IF NOT EXISTS hf_notify (
  caller_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (caller_uid, host_uid)
);
CREATE INDEX IF NOT EXISTS idx_hf_notify_host ON hf_notify(host_uid);
