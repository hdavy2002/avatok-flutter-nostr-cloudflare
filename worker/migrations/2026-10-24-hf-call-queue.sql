-- [HF-CALL-MODES-P0] The call queue (HF-CALL-10). CREATE only (D1 rule 6). Idempotent.
-- Spec section 2.2. status: waiting|offered|connected|done|left|skipped|expired|closed.
-- skip_reason: fan_no_answer|low_balance|blocked|host_missed|host_offline|booking_conflict.
CREATE TABLE IF NOT EXISTS hf_call_queue (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  fan_uid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  skip_reason TEXT,
  host_miss_count INTEGER NOT NULL DEFAULT 0,
  call_id TEXT,
  joined_at INTEGER NOT NULL,
  offered_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,
  wa_join_at INTEGER,
  wa_next_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_call_queue_fan_active ON hf_call_queue(fan_uid) WHERE status IN ('waiting','offered');
CREATE INDEX IF NOT EXISTS idx_hf_call_queue_host ON hf_call_queue(host_uid, status, seq);
