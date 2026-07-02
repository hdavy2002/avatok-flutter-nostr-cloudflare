-- Deep chat archive index (Phase 3 hardening). Written by the avatok-consumers
-- worker's chat-archive queue consumer (consumers/src/archive.ts → handleArchive):
-- message bodies live in the private BACKUP_R2 bucket (chat/<conv>/<serial>.json),
-- this index makes them queryable + pageable (avatok-api archiveList reads it).
-- The consumer also self-creates this via lazy-DDL; this is the canonical schema.
-- Idempotency key = (conv, serial). Lives in DB_META (avatok-meta / -staging).
CREATE TABLE IF NOT EXISTS message_index (
  conv       TEXT NOT NULL,
  serial     TEXT NOT NULL,        -- canonical, chronologically-sortable msg id
  sender     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  preview    TEXT,                 -- short snippet for list/search (no R2 read)
  media_ref  TEXT,
  client_id  TEXT,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conv, serial)       -- covers archiveList's WHERE conv=? AND serial<? ORDER BY serial DESC
);
