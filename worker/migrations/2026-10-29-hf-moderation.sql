-- [HF-MOD-2 2026-10-29] AI safety check on uploads (rulebook HF-MOD-3/4/5). CREATE only: apply with
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-29-hf-moderation.sql
CREATE TABLE IF NOT EXISTS hf_moderation_jobs (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- profile_photo|cover_photo|host_photo|intro_poster|intro_video
  subject_id TEXT NOT NULL,                -- hf_user_photos.id / hf_intro_videos.id
  r2_key TEXT NOT NULL,                    -- PRIVATE DIGITAL key of the file being checked (hf-mod/pending/...)
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|checking|passed|flagged|needs_look|refused|failed
  verdict_json TEXT,                       -- {reasons:[...], probs:{question:p}, ...}
  policy_version TEXT NOT NULL,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER,
  UNIQUE(kind, subject_id, policy_version)
);
CREATE INDEX IF NOT EXISTS hf_mod_jobs_status ON hf_moderation_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS hf_mod_jobs_uid ON hf_moderation_jobs(uid, kind, created_at);

CREATE TABLE IF NOT EXISTS hf_user_photos (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- profile|cover|host
  pending_key TEXT,                        -- DIGITAL (private) while checking
  public_key TEXT,                         -- BLOBS (public) once passed
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER,
  status TEXT NOT NULL,                    -- checking|active|refused|failed|superseded
  reason TEXT,                             -- sentence shown to the person when refused/failed
  job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_user_photos_uid ON hf_user_photos(uid, kind, status, created_at);
