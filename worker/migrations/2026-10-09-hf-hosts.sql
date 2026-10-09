-- [HF-HOST-PLATFORM-1] Hello Fraands host profiles, avatars, media, generation jobs. DB_META.
-- CREATE TABLE only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-hosts.sql)
CREATE TABLE IF NOT EXISTS hf_hosts (
  uid TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft|generating|pending_host|pending_review|live|paused|rejected
  display_name TEXT, about TEXT,
  tagline TEXT, quote TEXT, about_polished TEXT,
  languages_json TEXT NOT NULL DEFAULT '[]', style TEXT, topics_json TEXT NOT NULL DEFAULT '[]',
  conversation_lang TEXT,                         -- language of the sample conversation (e.g. 'hi')
  price_per_min INTEGER NOT NULL DEFAULT 20,
  hours_json TEXT NOT NULL DEFAULT '{}',
  health_consent INTEGER NOT NULL DEFAULT 0,
  women_lane INTEGER NOT NULL DEFAULT 0,
  lgbtq_lane INTEGER NOT NULL DEFAULT 0,
  lgbtq_public INTEGER NOT NULL DEFAULT 0,
  avatar_id TEXT,
  voice_sample_r2 TEXT, voice_seconds INTEGER, voice_consent_at INTEGER,
  gen_attempts INTEGER NOT NULL DEFAULT 0,
  agreements_at INTEGER,
  review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
  submitted_at INTEGER, live_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_hosts_status ON hf_hosts(status, updated_at);

CREATE TABLE IF NOT EXISTS hf_avatars (
  id TEXT PRIMARY KEY,
  image_key TEXT NOT NULL,                        -- BLOBS key hf/avatars/<id>.png
  gender TEXT NOT NULL,                           -- woman|man
  age_band TEXT NOT NULL,                         -- 20s|30s|40s|50s+
  look TEXT NOT NULL,                             -- traditional|casual|office
  status TEXT NOT NULL DEFAULT 'active',          -- active|retired
  taken_by_uid TEXT UNIQUE,
  prompt TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_avatars_pick ON hf_avatars(status, gender, age_band, look);

CREATE TABLE IF NOT EXISTS hf_host_media (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                             -- profile|gallery|sample_audio
  r2_key TEXT NOT NULL,                           -- BLOBS (public) key hf/hosts/<uid>/...
  caption TEXT, transcript_json TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',          -- active|hidden|superseded
  job_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_host_media_uid ON hf_host_media(uid, kind, status, sort);

CREATE TABLE IF NOT EXISTS hf_media_jobs (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'host_media',        -- host_media|avatar_batch
  instance_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',          -- queued|running|done|failed
  stage TEXT,                                     -- text|images|voice|conversation|safety
  stages_json TEXT NOT NULL DEFAULT '{}',
  error TEXT, cost_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_media_jobs_uid ON hf_media_jobs(uid, created_at);
