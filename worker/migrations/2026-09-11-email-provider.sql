-- Cloudflare Email Service primary / Brevo fallback (§3.3 of
-- Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md).
-- Extends the JOURNEY-04 email_outbox (2026-09-09-commercial-email-delivery.sql)
-- with provider attribution + delivery-event state, and adds the two new
-- tables the Cloudflare `email-events` queue consumer and the fallback policy
-- need (§5). ADD COLUMN is not idempotent in D1/SQLite, and a raw
-- `d1 execute --file` STOPS at the first "duplicate column name". Statement
-- order is therefore deliberate: the idempotent CREATE TABLEs run FIRST (so a
-- re-run or a DB whose columns were added by scripts/d1_apply_alters.py still
-- gets both tables), then the ALTERs, then the index (needs `provider`). If a
-- re-run aborts at the ALTERs, create the index separately — deploy.sh does:
--   d1 execute ... --command "CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_msg ..."

-- Suppression list: addresses producers must skip enqueueing for (hard bounce /
-- complaint / provider rejection / manual). Cloudflare suppresses on its own
-- side too, but the Brevo fallback path would otherwise happily re-mail them.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,           -- lowercased
  reason TEXT NOT NULL,             -- hard_bounce | complaint | rejected | manual
  source TEXT NOT NULL,             -- cloudflare | brevo | admin
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- Idempotency guard for the email-events queue consumer (Cloudflare event
-- subscription delivery is at-least-once).
CREATE TABLE IF NOT EXISTS email_events_seen (
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

ALTER TABLE email_outbox ADD COLUMN provider TEXT;              -- 'cloudflare' | 'brevo'
ALTER TABLE email_outbox ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN last_event TEXT;            -- delivered|deferred|bounced|complained|rejected
ALTER TABLE email_outbox ADD COLUMN last_event_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_msg ON email_outbox(provider, provider_message_id);
