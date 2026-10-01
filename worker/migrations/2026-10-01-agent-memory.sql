-- [AUMFE-AGENT-MEMORY-1 2026-10-01] Shared agent memory core: customer astro profile, remembered facts, agent sessions.
-- DB: avatok-meta (DB_META). Additive + idempotent. CREATE only — ALTERs live in 2026-10-01-agent-memory-alters.sql.
-- Apply (coordinator only, after review):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-agent-memory.sql
-- All timestamps are epoch milliseconds.

CREATE TABLE IF NOT EXISTS astro_profiles (
  uid              TEXT PRIMARY KEY,
  name             TEXT,
  gender           TEXT,
  dob              TEXT,              -- 'YYYY-MM-DD'
  tob              TEXT,              -- 'HH:MM' 24h, NULL when unknown
  tob_unknown      INTEGER NOT NULL DEFAULT 0,
  place            TEXT,
  lat              REAL,
  lon              REAL,
  tzone            REAL,              -- hours offset, e.g. 5.5
  tz_id            TEXT,              -- IANA, e.g. 'Asia/Kolkata'
  language         TEXT,
  snapshot_json    TEXT,              -- computed chart snapshot (written by the astrology lib)
  snapshot_version INTEGER,
  computed_at      INTEGER,
  memory_consent   INTEGER NOT NULL DEFAULT 0,
  consent_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_memory (
  id                     TEXT PRIMARY KEY,
  uid                    TEXT NOT NULL,
  agent                  TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('fact','open_thread','summary')),
  text                   TEXT NOT NULL,
  source_conversation_id TEXT,
  mem0_id                TEXT,
  created_at             INTEGER NOT NULL,
  deleted_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_memory_uid ON ai_memory(uid, deleted_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  agent             TEXT NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('voice','chat')),
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  minutes           REAL,
  cost_paise        INTEGER,
  transcript_r2_key TEXT,
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'active'  -- active | ended | summarised | summary_failed
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_uid ON agent_sessions(uid, started_at DESC);
