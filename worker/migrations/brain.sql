-- AvaBrain — knowledge graph + memory. Lives in its OWN database (avatok-brain),
-- not DB_META, because the raw event log is high-volume. Importance is decayed
-- LAZILY at read time (no cron full-table writes). `scope` distinguishes
-- server-derived public facts from client-synced private (DM-derived) facts.
-- Apply: wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain.sql

CREATE TABLE IF NOT EXISTS brain_entities (
  id          TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  entity_type TEXT NOT NULL,           -- person|project|company|place|task|goal|interest|event|community
  name        TEXT NOT NULL,
  summary     TEXT,
  metadata    TEXT,                    -- JSON (minimize third-party PII)
  scope       TEXT NOT NULL DEFAULT 'public', -- 'public' (server) | 'private' (client-synced)
  importance  REAL NOT NULL DEFAULT 0.5,      -- raw; effective = importance * 0.995^daysSince(last_seen)
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_ent_user ON brain_entities(uid, entity_type);
CREATE INDEX IF NOT EXISTS idx_brain_ent_name ON brain_entities(uid, name);
CREATE INDEX IF NOT EXISTS idx_brain_ent_importance ON brain_entities(uid, importance DESC);

CREATE TABLE IF NOT EXISTS brain_relationships (
  id              TEXT PRIMARY KEY,
  uid            TEXT NOT NULL,
  from_entity_id  TEXT NOT NULL,
  to_entity_id    TEXT NOT NULL,
  relationship    TEXT NOT NULL,
  strength        REAL NOT NULL DEFAULT 0.5,
  context         TEXT,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_rel_user ON brain_relationships(uid);
CREATE INDEX IF NOT EXISTS idx_brain_rel_from ON brain_relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_brain_rel_to ON brain_relationships(to_entity_id);

CREATE TABLE IF NOT EXISTS brain_facts (
  id          TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  fact_type   TEXT NOT NULL,           -- preference|habit|goal|deadline|decision|reminder|insight
  content     TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'public',
  source_app  TEXT,
  source_id   TEXT,
  confidence  REAL NOT NULL DEFAULT 0.8,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_facts_user ON brain_facts(uid, fact_type);
CREATE INDEX IF NOT EXISTS idx_brain_facts_recent ON brain_facts(uid, updated_at DESC);

CREATE TABLE IF NOT EXISTS brain_daily_summaries (
  id          TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  date        TEXT NOT NULL,           -- YYYY-MM-DD
  summary     TEXT NOT NULL,
  highlights  TEXT,                    -- JSON array
  created_at  INTEGER NOT NULL,
  UNIQUE(uid, date)
);
CREATE INDEX IF NOT EXISTS idx_brain_daily ON brain_daily_summaries(uid, date DESC);

-- Short-TTL catch-up buffer (NOT a permanent source of truth). Pruned by cron.
CREATE TABLE IF NOT EXISTS brain_events (
  id          TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  source_app  TEXT NOT NULL,
  payload     TEXT NOT NULL,           -- JSON; PUBLIC content only server-side
  processed   INTEGER NOT NULL DEFAULT 0,
  trace_id    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL         -- created_at + 30d
);
CREATE INDEX IF NOT EXISTS idx_brain_events_user ON brain_events(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_events_unprocessed ON brain_events(processed, created_at) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_brain_events_expiry ON brain_events(expires_at);

-- NOTE: Vectorize vectors are stored ONE PER ENTITY with a deterministic id
-- `<uid>:ent:<brain_entities.id>`, updated in place. So a user's vector ids are
-- derivable from brain_entities — no separate vector-id table is needed, and the
-- vector count is bounded by entity count (not event count).
