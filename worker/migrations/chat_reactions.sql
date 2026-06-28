-- Phase 4 (ABLY-R2-4): per-message reactions (DB_META / avatok-meta).
-- The LIVE reaction rides Ably (react:<conv> channel, client→client). This table
-- is the durable summary so reactions survive reopen + feed "reacted by" lists +
-- restore from the R2 archive. One row per (message, user, emoji); toggling off
-- deletes the row. Aggregate counts are computed at read time.
CREATE TABLE IF NOT EXISTS message_reactions (
  conv       TEXT    NOT NULL,
  target     TEXT    NOT NULL,        -- the message serial being reacted to
  uid        TEXT    NOT NULL,        -- who reacted
  emoji      TEXT    NOT NULL,        -- reaction (emoji)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conv, target, uid, emoji)
);
CREATE INDEX IF NOT EXISTS idx_msgreact_target ON message_reactions(conv, target);
