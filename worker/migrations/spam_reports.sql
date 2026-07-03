-- STREAM B (AI Messenger Batch — stranger safety gate). D1 / avatok-meta.
--
-- When a stranger-gated recipient taps "Report spam", the server copies the last
-- N (default 10) message envelopes of the reported conversation into this table
-- for moderation review, then blocks the sender. One row PER reported ENVELOPE so
-- moderators see the exact content that was reported (content-addressed by the
-- report id + the original message serial/client_id).
--
-- Brand-new table — a no-op for everything else. The reporter is the caller
-- (Clerk uid); reported_uid is the sender being reported (best-effort, resolved
-- from the conv membership at report time).
CREATE TABLE IF NOT EXISTS spam_reports (
  id            TEXT NOT NULL,             -- one report id shared by every copied envelope
  conv          TEXT NOT NULL,             -- the reported conversation id
  reporter_uid  TEXT NOT NULL,             -- who filed the report (the recipient)
  reported_uid  TEXT,                      -- who is being reported (the sender), best-effort
  msg_serial    TEXT,                      -- original message id / client_id (dedupe key)
  sender        TEXT,                      -- envelope sender uid
  kind          TEXT,                      -- text | audio | image | ...
  body          TEXT,                      -- plaintext body (server-readable arch)
  media_ref     TEXT,
  msg_created_at INTEGER,                  -- original message created_at
  created_at    INTEGER NOT NULL,          -- when the report was filed
  PRIMARY KEY (id, msg_serial)
);
CREATE INDEX IF NOT EXISTS idx_spam_reports_conv ON spam_reports (conv);
CREATE INDEX IF NOT EXISTS idx_spam_reports_reported ON spam_reports (reported_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_spam_reports_reporter ON spam_reports (reporter_uid, created_at);
