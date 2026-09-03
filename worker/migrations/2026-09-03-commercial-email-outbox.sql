-- Phase 7/Phase 5 — durable email outbox dedupe for commercial booking mail.
-- Additive only. Shared by worker-side mail helpers and the consumers Brevo sender.

CREATE TABLE IF NOT EXISTS email_outbox (
  outbox_key    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed')),
  payload_json  TEXT NOT NULL,
  error_message TEXT,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_state
  ON email_outbox(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_kind
  ON email_outbox(kind, created_at);
