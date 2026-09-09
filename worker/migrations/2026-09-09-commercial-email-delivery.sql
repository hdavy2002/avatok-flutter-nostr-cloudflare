-- JOURNEY-04 — extend the existing email outbox with durable delivery state.
-- The base CREATE is repeated defensively because production may not have run
-- 2026-09-03 yet. If it exists, all following ALTERs preserve its rows.
CREATE TABLE IF NOT EXISTS email_outbox (
  outbox_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed')),
  payload_json TEXT NOT NULL,
  error_message TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE email_outbox ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE email_outbox ADD COLUMN recipient_id TEXT;
ALTER TABLE email_outbox ADD COLUMN order_id TEXT;
ALTER TABLE email_outbox ADD COLUMN message_version TEXT;
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE email_outbox ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN queue_accepted_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_outbox ADD COLUMN accepted_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN delivered_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN bounced_at INTEGER;

UPDATE email_outbox
   SET delivery_status=CASE WHEN state='sent' AND kind='brevo_send' THEN 'provider_accepted' ELSE 'queued' END
 WHERE delivery_status='queued';

-- Legacy queued rows have no retry timestamp. Make them immediately eligible;
-- permanent provider failures use NULL and stay out of recovery sweeps.
UPDATE email_outbox SET next_attempt_at=0
 WHERE delivery_status='queued' AND next_attempt_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_outbox_delivery
  ON email_outbox(delivery_status,next_attempt_at,lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_order_recipient
  ON email_outbox(order_id,recipient_id,message_version);
