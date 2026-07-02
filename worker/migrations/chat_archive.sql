-- Deep chat archive index (Phase 3 hardening). Populated by the chat-archive
-- queue consumer (src/routes/archive.ts → archiveWrite); message bodies live in
-- the private BACKUP_R2 bucket keyed by r2_key. archiveList() pages this back as
-- the "everything, forever" history behind the recent InboxDO window.
-- Runtime also self-creates this via lazy-DDL; this file is the canonical schema.
CREATE TABLE IF NOT EXISTS message_index (
  serial     TEXT PRIMARY KEY,   -- canonical, chronologically-sortable msg id (globally unique)
  conv       TEXT NOT NULL,
  sender     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  media_ref  TEXT,
  client_id  TEXT,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgidx_conv ON message_index(conv, serial);
