-- AvaVoice — creator-built AI voice agents (Specs/AVAVOICE-PROPOSAL.md).
-- Low-write listing/booking surfaces only — per-call high-frequency state will
-- move to a per-agent AgentPresenceDO in Phase 6 (sessions stay here as audit).

CREATE TABLE IF NOT EXISTS avavoice_agents (
  id                TEXT PRIMARY KEY,
  creator_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  system_profile    TEXT NOT NULL DEFAULT '',
  voice_name        TEXT NOT NULL DEFAULT 'Puck',
  avatar_url        TEXT,
  rate_per_hour     INTEGER NOT NULL DEFAULT 0,   -- coins (USD cents); 0 for creator_pays
  payer_mode        TEXT NOT NULL DEFAULT 'user_pays', -- user_pays | creator_pays
  session_limit_min INTEGER NOT NULL DEFAULT 30,  -- 5|10|30|60 (60 = platform hard cap)
  vision_enabled    INTEGER NOT NULL DEFAULT 0,
  file_search_store TEXT,                          -- Gemini File Search store resource name
  status            TEXT NOT NULL DEFAULT 'draft', -- draft|published|suspended|deleted
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avv_agents_status  ON avavoice_agents(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_avv_agents_creator ON avavoice_agents(creator_id);

CREATE TABLE IF NOT EXISTS avavoice_agent_files (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  doc_name   TEXT,                                 -- File Search document name (NULL = not indexed yet)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avv_files_agent ON avavoice_agent_files(agent_id);

CREATE TABLE IF NOT EXISTS avavoice_bookings (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  scheduled_at   INTEGER NOT NULL,
  booked_minutes INTEGER NOT NULL,
  language       TEXT NOT NULL DEFAULT 'en-US',
  rate_per_hour  INTEGER NOT NULL DEFAULT 0,       -- snapshot at booking time
  escrow_coins   INTEGER NOT NULL DEFAULT 0,
  order_id       TEXT,                              -- escrow bucket: escrow:<order_id>
  status         TEXT NOT NULL DEFAULT 'booked',    -- booked|in_progress|completed|cancelled|no_show
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avv_bookings_user  ON avavoice_bookings(user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_avv_bookings_agent ON avavoice_bookings(agent_id, created_at);

CREATE TABLE IF NOT EXISTS avavoice_sessions (
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
  creator_coins  INTEGER NOT NULL DEFAULT 0,       -- creator's 50% share (0 for creator_pays)
  refund_coins   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',   -- active|ended
  end_reason     TEXT,                              -- user|agent_wrapup|hard_cap|disconnect|kill_switch
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avv_sessions_agent ON avavoice_sessions(agent_id, status, last_beat_at);
CREATE INDEX IF NOT EXISTS idx_avv_sessions_user  ON avavoice_sessions(user_id, started_at);
