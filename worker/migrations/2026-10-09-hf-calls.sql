-- [HF-CALLS-1] Hello Fraands masked paid calls. DB_META. Contract: Specs/HF-CALLS-CONTRACT.md
-- CREATE TABLE only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-calls.sql)
CREATE TABLE IF NOT EXISTS hf_calls (
  id TEXT PRIMARY KEY,
  caller_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  rate_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ringing_host',   -- ringing_host|host_declined|no_answer|ringing_caller|caller_no_answer|connected|completed|failed|blocked
  lane TEXT,                                      -- 'women' | 'lgbtq' | NULL
  created_at INTEGER NOT NULL,
  host_answered_at INTEGER,
  connected_at INTEGER,
  ended_at INTEGER,
  billed_minutes INTEGER NOT NULL DEFAULT 0,
  charged_paise INTEGER NOT NULL DEFAULT 0,
  host_earning_paise INTEGER NOT NULL DEFAULT 0,
  host_earned_tokens INTEGER NOT NULL DEFAULT 0,  -- whole rupees actually credited to the host wallet (fractions are carried across calls)
  end_reason TEXT,                                -- caller_hangup|host_hangup|hash_block|time_limit|balance|error
  host_leg_uuid TEXT,
  caller_leg_uuid TEXT,
  conference_name TEXT
);
CREATE INDEX IF NOT EXISTS hf_calls_caller ON hf_calls(caller_uid, created_at);
CREATE INDEX IF NOT EXISTS hf_calls_host ON hf_calls(host_uid, created_at);
CREATE INDEX IF NOT EXISTS hf_calls_created ON hf_calls(created_at);
CREATE INDEX IF NOT EXISTS hf_calls_status ON hf_calls(status, created_at);

CREATE TABLE IF NOT EXISTS hf_blocks (
  blocker_uid TEXT NOT NULL,
  blocked_uid TEXT NOT NULL,
  call_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_uid, blocked_uid)
);
CREATE INDEX IF NOT EXISTS hf_blocks_blocked ON hf_blocks(blocked_uid);

CREATE TABLE IF NOT EXISTS hf_incidents (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  reporter_uid TEXT NOT NULL,
  kind TEXT NOT NULL,                             -- 'hash_block'
  created_at INTEGER NOT NULL                     -- kept 1 year
);
CREATE INDEX IF NOT EXISTS hf_incidents_call ON hf_incidents(call_id);
CREATE INDEX IF NOT EXISTS hf_incidents_created ON hf_incidents(created_at);
