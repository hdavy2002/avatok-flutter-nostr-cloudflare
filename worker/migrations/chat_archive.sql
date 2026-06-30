-- Phase 1 (ABLY-R2-1): durable message archive INDEX (DB_META / avatok-meta).
-- The message BODY lives in R2 (BACKUP_R2, key chat/<conv>/<serial>.json). This
-- D1 table is the queryable index used for fast paged reads on thread-open
-- (range by serial/created_at) and for AI-search backfill. Decoupling the store
-- from the per-user InboxDO lets Ably own realtime while Cloudflare owns the
-- durable archive + AI context (see Specs/ABLY-TRANSPORT-R2-ARCHIVE-PROPOSAL.md).
CREATE TABLE IF NOT EXISTS message_index (
  conv       TEXT    NOT NULL,
  serial     TEXT    NOT NULL,          -- canonical message id (chronologically sortable)
  sender     TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'text',
  preview    TEXT,                       -- short snippet (list/search without an R2 read)
  media_ref  TEXT,
  client_id  TEXT,                        -- sender's optimistic id (shared across peers) — client dedupe key on scroll-up
  r2_key     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conv, serial)
);
-- [IDX-PRUNE-1] idx_msgidx_conv_created removed: paged thread reads use the
-- PRIMARY KEY (conv, serial) (archive.ts: WHERE conv=? ORDER BY serial DESC).
-- serial is chronologically sortable, so a (conv, created_at) index is redundant
-- write amplification. drop_idx_msgidx_conv_created.sql drops it where applied.
CREATE INDEX IF NOT EXISTS idx_msgidx_sender       ON message_index(sender, created_at DESC);
