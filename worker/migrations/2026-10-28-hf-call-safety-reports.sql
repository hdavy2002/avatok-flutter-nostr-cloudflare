-- [HF-CALL-SAFETY-BE] A party's post-call report. One per (call, reporter). DB_META.
CREATE TABLE IF NOT EXISTS hf_call_reports (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  reporter_uid TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_call_reports_call_reporter ON hf_call_reports(call_id, reporter_uid);
