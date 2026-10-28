-- [HF-CALL-SAFETY-BE] Every time an employee opens a flagged review, a full transcript or the audio clip. Kept 1 year. DB_META.
CREATE TABLE IF NOT EXISTS hf_review_access_log (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  admin_uid TEXT NOT NULL,
  action TEXT NOT NULL,                       -- open_lines|full_transcript|clip
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_review_access_log_review ON hf_review_access_log(review_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_review_access_log_created ON hf_review_access_log(created_at);
