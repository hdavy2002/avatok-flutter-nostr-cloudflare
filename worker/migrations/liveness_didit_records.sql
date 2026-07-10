-- [LIVE-DIDIT-5] (owner decision 2026-07-10) Our OWN permanent record of every
-- didit.me liveness check — name/email/phone AS THEY WERE at check time (the
-- user may rename later), the verdict + score, and R2 keys for the archived
-- portrait + video clip. Keeps the evidence portable if we ever leave Didit.
CREATE TABLE IF NOT EXISTS liveness_didit_records (
  session_id     TEXT PRIMARY KEY,          -- Didit session uuid
  uid            TEXT NOT NULL,             -- Clerk uid (vendor_data)
  status         TEXT NOT NULL DEFAULT 'created', -- created | Approved | Declined | Abandoned | Expired
  name           TEXT,                      -- display name at check time
  first_name     TEXT,
  last_name      TEXT,
  email          TEXT,                      -- raw email at check time (user consented to identity check)
  phone          TEXT,                      -- E.164 if known
  score          REAL,                      -- Didit liveness score (0-100)
  r2_portrait_key TEXT,                     -- VERIFICATION bucket key of archived selfie
  r2_video_key   TEXT,                      -- VERIFICATION bucket key of archived clip
  created_at     INTEGER NOT NULL,          -- ms epoch, session created
  decided_at     INTEGER                    -- ms epoch, verdict landed
);
CREATE INDEX IF NOT EXISTS idx_ldr_uid ON liveness_didit_records(uid);
CREATE INDEX IF NOT EXISTS idx_ldr_status ON liveness_didit_records(status);
