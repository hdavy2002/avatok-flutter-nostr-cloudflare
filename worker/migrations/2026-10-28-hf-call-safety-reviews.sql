-- [HF-CALL-SAFETY-BE] Verdict + (short-lived) transcript of one recorded call, and the admin queue row for it. DB_META.
CREATE TABLE IF NOT EXISTS hf_call_reviews (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  recording_id TEXT,
  kind TEXT NOT NULL DEFAULT 'review',        -- review|danger|fan_report
  fan_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  women_lane INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'clean',      -- clean|selling|outside_payment|contact_sharing|abuse|sexual|danger
  score REAL NOT NULL DEFAULT 0,
  speaker TEXT,                               -- fan|influencer|NULL
  speaker_score REAL NOT NULL DEFAULT 0,
  target_uid TEXT,                            -- the person the verdict is about (the speaker)
  flagged_idx INTEGER,                        -- index into lines_json of the flagged line
  flagged_sec INTEGER,
  lines_json TEXT,                            -- [{sec,t,speaker,text}] ; NULL once transcript retention has passed
  summary TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'clean',       -- clean|queued|struck|dismissed|paused
  duration_sec INTEGER,
  call_at INTEGER,
  decided_by TEXT,
  decided_at INTEGER,
  decision_action TEXT,
  decision_note TEXT,
  transcript_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_call_reviews_call_kind ON hf_call_reviews(call_id, kind);
CREATE INDEX IF NOT EXISTS idx_hf_call_reviews_queue ON hf_call_reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_call_reviews_target ON hf_call_reviews(target_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_call_reviews_transcript ON hf_call_reviews(transcript_expires_at);
