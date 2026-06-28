-- Phase 5 (ABLY-R2-5): owner-private chat state in D1 (DB_META / avatok-meta).
-- Decision D2 (2026-06-28): once Ably owns transport + R2 owns the archive, the
-- per-user InboxDO no longer needs to hold the owner's PRIVATE state. These tables
-- take it over: read position (unread counts across devices), soft-delete/Undo
-- flags, and the call log. All keyed by uid (per-account). Dark + dual-written
-- behind MSG_STATE_STORE=d1 until the client reads from here.

-- My read position per conversation (restores unread state on a fresh device).
CREATE TABLE IF NOT EXISTS msg_read_state (
  uid     TEXT    NOT NULL,
  conv    TEXT    NOT NULL,
  read_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, conv)
);

-- My soft-delete (delete-for-me / the owner side of delete-for-everyone) + Undo.
CREATE TABLE IF NOT EXISTS msg_hidden (
  uid        TEXT    NOT NULL,
  target     TEXT    NOT NULL,        -- message id hidden/un-hidden
  hidden     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, target)
);

-- My call history (multi-device synced; the owner's private list).
CREATE TABLE IF NOT EXISTS call_log_d1 (
  uid      TEXT    NOT NULL,
  entry_id TEXT    NOT NULL,
  name     TEXT,
  seed     TEXT,
  video    INTEGER NOT NULL DEFAULT 0,
  dir      TEXT    NOT NULL DEFAULT 'outgoing',
  ts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_calllog_uid_ts ON call_log_d1(uid, ts DESC);
