-- [HF-INTRO-W1] HF-INTRO-VIDEO-1: influencer intro video + human approval. DB_META. CREATE only (scripts/d1_apply_alters.py skips CREATE, so apply by hand):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-28-hf-intro-video-tables.sql
-- Apply 2026-10-28-hf-intro-video-alters.sql too (hf_hosts columns). Flags hfIntroOnboardingEnabled / hfIntroReelsEnabled stay off until both are applied.

-- One row per recorded intro video (live camera, 10-20 s, portrait). Files live in the public media bucket (BLOBS) under intro-video/<uid>/<id>.<ext>.
CREATE TABLE IF NOT EXISTS hf_intro_videos (
  id TEXT PRIMARY KEY,                            -- hfin_<20 hex>; also the reel id (likes / comments / share use it as is)
  uid TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  poster_key TEXT,
  mime TEXT NOT NULL,                             -- video/mp4 | video/webm
  bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  lang TEXT,                                      -- language the influencer speaks in the video (hi|en|mr|bn|ta|te|gu|pa|kn|ml)
  topic TEXT,                                     -- what the video is about: a category id or 'general'
  views INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',           -- draft|submitted|approved|rejected|replaced
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_intro_videos_uid ON hf_intro_videos(uid, status);

-- One row per submission. A rejected person fixes and submits again = a NEW row (history stays).
CREATE TABLE IF NOT EXISTS hf_influencer_applications (
  id TEXT PRIMARY KEY,                            -- hfia_<20 hex>
  uid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',       -- submitted|approved|rejected
  categories_json TEXT NOT NULL DEFAULT '[]',     -- ids from lib/hf_categories.ts
  lang TEXT,
  intro_video_id TEXT NOT NULL,
  call_option TEXT NOT NULL,                      -- A (bookings only) | B (bookings + live)
  rate_rupees INTEGER,                            -- snapshot of hf_hosts.price_per_min at submit
  has_socials INTEGER NOT NULL DEFAULT 0,         -- snapshot: a verified social account existed at submit
  aadhaar_ok INTEGER NOT NULL DEFAULT 0,          -- snapshot: Aadhaar verified at submit
  submitted_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer_uid TEXT,
  reject_reasons_json TEXT,                       -- ["face_unclear", ...] (lib/hf_intro_video.ts REJECT_REASONS)
  reject_note TEXT
);
CREATE INDEX IF NOT EXISTS hf_intro_apps_status ON hf_influencer_applications(status, submitted_at);
CREATE INDEX IF NOT EXISTS hf_intro_apps_uid ON hf_influencer_applications(uid, submitted_at);
-- A person can have only ONE open submission (double taps / two devices cannot create two).
CREATE UNIQUE INDEX IF NOT EXISTS hf_intro_apps_one_open ON hf_influencer_applications(uid) WHERE status='submitted';
