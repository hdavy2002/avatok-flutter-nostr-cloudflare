-- [HF-DASH-V3-1] New customer dashboard: profile extras, notification preference, support tickets.
CREATE TABLE IF NOT EXISTS hf_user_profile (
  uid TEXT PRIMARY KEY,
  city TEXT,
  languages_json TEXT NOT NULL DEFAULT '[]',
  talk_about TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hf_user_prefs (
  uid TEXT PRIMARY KEY,
  notify_whatsapp INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hf_support_tickets (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_support_tickets_uid ON hf_support_tickets(uid, created_at);
