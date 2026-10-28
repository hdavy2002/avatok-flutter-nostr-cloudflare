-- [HF-CALL-SAFETY-BE] Safety messages waiting to go out (WhatsApp + email + push). Held for quiet hours (8 am to 11 pm IST); UNIQUE notice_key makes a retry a no-op. DB_META.
CREATE TABLE IF NOT EXISTS hf_safety_notices (
  id TEXT PRIMARY KEY,
  notice_key TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  event TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT,
  send_after INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_safety_notices_due ON hf_safety_notices(sent_at, send_after);
