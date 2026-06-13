-- AvaVision — creator-built AI VISION coaching agents ("AvaVoice with eyes").
-- Spec: Specs/AVAVISION-PROPOSAL.md + Specs/avavision-build/MASTER-PROMPT.md.
-- Mirrors avavoice.sql 1:1, plus the vision columns. Low-write listing/booking
-- surfaces only; per-session high-frequency state is counted in D1 (slot cap +
-- snapshot quota) — NO Durable Object (master §3 / Phase 1 reality).
-- Apply to avatok-meta (prod + staging) via the REST migration recipe (Phase Z).

CREATE TABLE IF NOT EXISTS avavision_agents (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT '',
  system_profile      TEXT NOT NULL DEFAULT '',
  voice_name          TEXT NOT NULL DEFAULT 'Puck',
  avatar_url          TEXT,
  rate_per_hour       INTEGER NOT NULL DEFAULT 0,    -- coins (USD cents); 0 for creator_pays
  payer_mode          TEXT NOT NULL DEFAULT 'user_pays', -- user_pays | creator_pays
  session_limit_min   INTEGER NOT NULL DEFAULT 30,   -- 5|10|30|60 (60 = platform hard cap)
  file_search_store   TEXT,                           -- Gemini File Search store resource name
  status              TEXT NOT NULL DEFAULT 'draft',  -- draft|published|suspended|deleted
  -- ── vision additions (master §A / Phase 1 build step 1) ──────────────────
  template_id         TEXT NOT NULL DEFAULT '',       -- avavision-templates.json template id
  capability          TEXT NOT NULL DEFAULT 'gemini_only', -- pose|hand|face_landmark|face_detect|gesture|object|image_class|segmentation|holistic|gemini_only
  mediapipe_solution  TEXT,                            -- MediaPipe Tasks solution id (NULL when gemini_only)
  engine_default      TEXT NOT NULL DEFAULT 'gemini',  -- movenet|mediapipe_pose|mediapipe|gemini
  overlay_enabled     INTEGER NOT NULL DEFAULT 0,
  overlay_style       TEXT NOT NULL DEFAULT 'none',    -- skeleton|hand_mesh|face_mesh|bounding_box|segmentation_mask|none
  scoring_mode        TEXT NOT NULL DEFAULT 'none',    -- geometry|gemini_qualitative|hybrid|none
  score_label         TEXT,                            -- on-screen score badge label (NULL = no score)
  vision_mode         TEXT NOT NULL DEFAULT 'live',    -- live|snapshot|both|gemini_only
  agentic_snapshot_enabled    INTEGER NOT NULL DEFAULT 0,
  free_snapshots_per_session  INTEGER NOT NULL DEFAULT 0,
  media_resolution    TEXT NOT NULL DEFAULT 'LOW',     -- video locked into the ephemeral token
  platforms_json      TEXT NOT NULL DEFAULT '{"android":true,"ios":false,"web":true}',
  save_snapshots      INTEGER NOT NULL DEFAULT 0,      -- OFF by default (safety)
  rubric_id           TEXT,                            -- optional scoring rubric (deferred use)
  safety_notes_json   TEXT NOT NULL DEFAULT '[]',      -- platform-enforced guardrails (from template)
  images              TEXT,                            -- JSON array of 1–5 public CDN URLs (mandatory at publish)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avvis_agents_status  ON avavision_agents(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_avvis_agents_creator ON avavision_agents(creator_id);

CREATE TABLE IF NOT EXISTS avavision_agent_files (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  doc_name   TEXT,                                     -- File Search document name (NULL = not indexed yet)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avvis_files_agent ON avavision_agent_files(agent_id);

CREATE TABLE IF NOT EXISTS avavision_bookings (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  scheduled_at   INTEGER NOT NULL,
  booked_minutes INTEGER NOT NULL,
  language       TEXT NOT NULL DEFAULT 'en-US',
  rate_per_hour  INTEGER NOT NULL DEFAULT 0,           -- snapshot at booking time
  escrow_coins   INTEGER NOT NULL DEFAULT 0,
  order_id       TEXT,                                  -- escrow bucket: escrow:<order_id> (avvis_ namespace)
  status         TEXT NOT NULL DEFAULT 'booked',        -- booked|in_progress|completed|cancelled|no_show
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avvis_bookings_user  ON avavision_bookings(user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_avvis_bookings_agent ON avavision_bookings(agent_id, created_at);

CREATE TABLE IF NOT EXISTS avavision_sessions (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  booking_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  language       TEXT NOT NULL DEFAULT 'en-US',
  limit_minutes  INTEGER NOT NULL DEFAULT 60,
  started_at     INTEGER NOT NULL,
  last_beat_at   INTEGER NOT NULL,
  billed_minutes INTEGER NOT NULL DEFAULT 0,
  gross_coins    INTEGER NOT NULL DEFAULT 0,
  creator_coins  INTEGER NOT NULL DEFAULT 0,           -- creator's 50% share (0 for creator_pays)
  refund_coins   INTEGER NOT NULL DEFAULT 0,
  -- ── vision session telemetry (master §A) ─────────────────────────────────
  frames_streamed INTEGER NOT NULL DEFAULT 0,
  snapshot_calls  INTEGER NOT NULL DEFAULT 0,          -- D1 snapshot-quota counter (no token bucket)
  avg_score       INTEGER,                              -- nullable; reported by client at stop
  peak_score      INTEGER,                              -- nullable
  status         TEXT NOT NULL DEFAULT 'active',        -- active|ended
  end_reason     TEXT,                                  -- user|agent_wrapup|hard_cap|disconnect|kill_switch
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avvis_sessions_agent ON avavision_sessions(agent_id, status, last_beat_at);
CREATE INDEX IF NOT EXISTS idx_avvis_sessions_user  ON avavision_sessions(user_id, started_at);

-- Optional: saved "Analyze my form" snapshots (only when agent.save_snapshots=1).
-- r2_key is per-account scoped (avavision/<creator_id>/<agent_id>/<session_id>/...).
CREATE TABLE IF NOT EXISTS avavision_snapshots (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  score      INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avvis_snapshots_session ON avavision_snapshots(session_id, created_at);
