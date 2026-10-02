-- [AUMFE-VOICE-AGENTS-DB-1 2026-10-02] Voice guides as DATA (Admin -> Voice guides). DB: avatok-meta (DB_META).
-- CREATE only, idempotent. NOT applied by the implementer. The Meera seed rows are in 2026-10-02-voice-agents-seed.sql.
-- Apply (coordinator only, after review; CREATEs are NOT applied by d1_apply_alters.py):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-02-voice-agents.sql
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-02-voice-agents-seed.sql
-- All timestamps are epoch milliseconds.

CREATE TABLE IF NOT EXISTS voice_agents (
  id                   TEXT PRIMARY KEY,                 -- slug, e.g. 'astrology'
  name                 TEXT NOT NULL,                    -- persona name, e.g. 'Meera'
  subject              TEXT NOT NULL,                    -- 'Astrology'
  blurb                TEXT NOT NULL DEFAULT '',
  initial              TEXT NOT NULL DEFAULT '',
  tint                 TEXT NOT NULL DEFAULT '#07545b',
  avatar_url           TEXT,
  voice                TEXT NOT NULL,                    -- Gemini prebuilt voice name
  language             TEXT NOT NULL DEFAULT 'hi-IN',
  tool_pack            TEXT NOT NULL DEFAULT 'knowledge_only',  -- code: lib/voice_agents/tool_packs.ts
  price_per_min_tokens INTEGER,                          -- wallet tokens (1 token = Rs 1) per started minute; NULL = platform default
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preview','live','archived')),
  sort                 INTEGER NOT NULL DEFAULT 0,
  published_prompt_id  TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  updated_by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_agents_status ON voice_agents(status, sort);

CREATE TABLE IF NOT EXISTS voice_agent_prompts (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  persona      TEXT NOT NULL,                            -- owner-written persona; {{brand}} is replaced at call time
  greeting     TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  published_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_agent_prompts_ver ON voice_agent_prompts(agent_id, version);

CREATE TABLE IF NOT EXISTS voice_agent_docs (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('file','url','text')),
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,                              -- R2 key (file/text) or the https URL
  bytes      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','indexing','ready','failed')),
  chunks     INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  indexed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voice_agent_docs_agent ON voice_agent_docs(agent_id, created_at DESC);
