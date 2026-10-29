-- [SUPPORT-QUEUE-1] Queues carry IDs, never content.
-- email_outbox now holds everything the email consumer needs to send a message; the HTML body
-- and attachments live in R2 (BACKUP_R2, email-outbox/YYYY/MM/DD/<outbox_id>/...). The queue
-- message is just { job:'send', outboxId, key } where key = outbox_key (the idempotency key).
--
-- ADDITIVE ONLY. Old rows keep payload_json with the inline message (the consumer and
-- recoverEmailOutbox still understand them and upgrade them to R2 on the next enqueue).
-- ADD COLUMN is not idempotent in D1: apply with scripts/d1_apply_alters.py (reads
-- PRAGMA table_info first), then run the index statements below separately.
--
-- DEPLOY ORDER: this migration -> create the 4 email/whatsapp queues + DLQs -> deploy
-- avatok-consumers (accepts new + legacy shapes) -> deploy avatok-api (starts sending ids).

ALTER TABLE email_outbox ADD COLUMN outbox_id TEXT;          -- random uuid; the id in the queue message
ALTER TABLE email_outbox ADD COLUMN to_email TEXT;
ALTER TABLE email_outbox ADD COLUMN subject TEXT;
ALTER TABLE email_outbox ADD COLUMN from_addr TEXT;          -- NULL = consumer default sender
ALTER TABLE email_outbox ADD COLUMN reply_to_json TEXT;      -- {"email":..,"name":..} or NULL
ALTER TABLE email_outbox ADD COLUMN body_r2_key TEXT;        -- NULL on legacy rows
ALTER TABLE email_outbox ADD COLUMN attachments_json TEXT;   -- [{"name":..,"key":..}] base64 text objects in R2
ALTER TABLE email_outbox ADD COLUMN lane TEXT;               -- 'priority' | 'bulk'

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_outbox_id ON email_outbox(outbox_id) WHERE outbox_id IS NOT NULL;
