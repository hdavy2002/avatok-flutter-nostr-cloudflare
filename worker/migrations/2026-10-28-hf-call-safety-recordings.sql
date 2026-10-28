-- [HF-CALL-SAFETY-BE] One row per Vobiz call recording AND the processing job for it (cron picks status in received/copied/transcribed/failed-retry). DB_META.
CREATE TABLE IF NOT EXISTS hf_call_recordings (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  recording_id TEXT NOT NULL UNIQUE,          -- Vobiz RecordingID: the webhook is idempotent on it
  role TEXT NOT NULL DEFAULT 'caller',        -- which leg was recorded
  vobiz_url TEXT,                             -- Vobiz RecordUrl (needs X-Auth headers; never shown to anyone)
  duration_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'received',    -- received|copied|transcribed|done|skipped|failed|deleted
  r2_key TEXT,                                -- private DIGITAL bucket: hf-call-audio/<call>/<recording>.mp3
  bytes INTEGER,
  women_lane INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,         -- a flagged / reported call keeps its audio hfFlaggedAudioDays
  audio_expires_at INTEGER,                   -- NULL while the clean-call rule (delete right after transcription) applies
  vobiz_deleted_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_call_recordings_job ON hf_call_recordings(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_hf_call_recordings_call ON hf_call_recordings(call_id);
CREATE INDEX IF NOT EXISTS idx_hf_call_recordings_audio ON hf_call_recordings(audio_expires_at);
