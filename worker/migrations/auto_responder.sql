-- STREAM F (AI Messenger Batch): auto-responder "Ava replies while you're away".
-- Per-user (uid) settings for the away auto-reply. One row per account (the uid is
-- the PK); the row is authoritative in D1 (DB_META / avatok-meta) and MIRRORED to
-- KV (key `arsp:cfg:<uid>` in TOKENS) for the hot-path read on /api/msg/send so the
-- send route never does a D1 round-trip per incoming DM.
--
-- Per-account scoping: uid is the Clerk-verified account id, so parent + each child
-- account (sharing one phone) each get their own independent row — no cross-account
-- leak. The GET/PUT routes (worker/src/routes/auto_responder.ts) always scope by uid.
CREATE TABLE IF NOT EXISTS auto_responder_settings (
  uid            TEXT    PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 0,   -- master toggle (0/1)
  mode           TEXT    NOT NULL DEFAULT 'travelling', -- travelling|busy|sleeping|driving|custom
  message        TEXT,                          -- the away message (<=200 chars; per-mode default if null)
  audience       TEXT    NOT NULL DEFAULT 'known', -- 'known' (contacts only) | 'everyone' (except blocked)
  -- Duration: 'off' = until turned off; 'hours' = for N hours from set_at; 'schedule' = daily window.
  duration_kind  TEXT    NOT NULL DEFAULT 'off',   -- off|hours|schedule
  duration_hours INTEGER,                          -- when duration_kind='hours' (1|4|8|24)
  active_until   INTEGER,                          -- ms epoch; when duration_kind='hours', set_at + hours
  sched_start    INTEGER,                          -- daily schedule start, minutes-from-midnight (0..1439)
  sched_end      INTEGER,                          -- daily schedule end, minutes-from-midnight (0..1439)
  -- Conversation depth: 'once' = one reply per contact per day; 'chat' = AI mode, up to
  -- 3 auto-exchanges per contact per day (hard cap enforced in the consumer + KV counters).
  depth          TEXT    NOT NULL DEFAULT 'once',   -- once|chat
  reply_lang     INTEGER NOT NULL DEFAULT 1,        -- reply in sender's language (default ON)
  urgent_escalate INTEGER NOT NULL DEFAULT 1,       -- high-priority push for urgent messages (default ON)
  away_digest    INTEGER NOT NULL DEFAULT 1,        -- post an away-digest on disable / schedule-end (default ON)
  set_at         INTEGER,                           -- ms epoch when last enabled/updated (anchors 'hours')
  updated_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_arsp_enabled ON auto_responder_settings(enabled);
