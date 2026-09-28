-- [WA-NOTIFY-1 2026-09-28] Outbox for buyer WhatsApp notifications (live-stream
-- link, video-download link), drained by the paced cron sweep in
-- lib/whatsapp_notify.ts (runWhatsAppOutboxDrain). One row per (checkout, kind,
-- link) so a re-save of the same link is a no-op and a corrected link sends
-- fresh — same idea as the email_outbox dedupe key in
-- routes/saathum_checkout.ts sendSaathumVideoReadyEmails.
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_id  TEXT NOT NULL,
  uid          TEXT NOT NULL,
  listing_id   TEXT NOT NULL,
  kind         TEXT NOT NULL, -- 'live_link' | 'video_ready'
  url_hash     TEXT NOT NULL, -- sha256(url).slice(0,16); a corrected link is a new row
  e164         TEXT NOT NULL,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sent_at      INTEGER,
  UNIQUE (checkout_id, kind, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_queued ON whatsapp_outbox(status, created_at);
