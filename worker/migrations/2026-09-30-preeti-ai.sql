-- [SAATHUM-PREETI-1 2026-09-30] Preeti, the site AI agent. DB: avatok-meta (DB_META).
-- Spec: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md. Additive + idempotent (CREATE IF NOT EXISTS / INSERT OR IGNORE).
-- Apply (coordinator only, after review):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-30-preeti-ai.sql
-- All timestamps are epoch milliseconds. Internal identifiers stay brand-neutral (ai_*, preeti_*).

CREATE TABLE IF NOT EXISTS ai_agent_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  name               TEXT NOT NULL DEFAULT 'Preeti',
  avatar_url         TEXT,
  welcome_text       TEXT NOT NULL,
  quick_replies_json TEXT NOT NULL DEFAULT '{}',
  support_whatsapp   TEXT NOT NULL DEFAULT '+919259457189',
  alert_whatsapp     TEXT NOT NULL DEFAULT '+919259457189',
  enabled            INTEGER NOT NULL DEFAULT 1,
  store_name         TEXT,
  active_prompt_id   TEXT,
  monthly_cap_rupees INTEGER NOT NULL DEFAULT 2000,
  updated_at         INTEGER,
  updated_by         TEXT
);

CREATE TABLE IF NOT EXISTS ai_agent_prompts (
  id           TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_agent_files (
  id          TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  doc_name    TEXT,
  status      TEXT NOT NULL DEFAULT 'uploading'
              CHECK (status IN ('uploading','indexing','ready','failed','needs_review')),
  error       TEXT,
  uploaded_by TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_knowledge_docs (
  url          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('article','page')),
  slug         TEXT,
  title        TEXT,
  content_hash TEXT,
  doc_name     TEXT,
  status       TEXT,
  error        TEXT,
  synced_at    INTEGER
);

CREATE TABLE IF NOT EXISTS ai_incidents (
  id         TEXT PRIMARY KEY,
  listing_id TEXT,
  message    TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  expires_at INTEGER,
  source     TEXT NOT NULL CHECK (source IN ('admin','weather_notice')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_incidents_listing ON ai_incidents(listing_id, starts_at);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id                  TEXT PRIMARY KEY,
  uid                 TEXT,
  visitor_id          TEXT NOT NULL,
  name                TEXT,
  e164                TEXT,
  first_page          TEXT,
  last_page           TEXT,
  lead_score          INTEGER NOT NULL DEFAULT 0,
  badges_json         TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','needs_human')),
  admin_note          TEXT,
  is_test             INTEGER NOT NULL DEFAULT 0,
  message_count       INTEGER NOT NULL DEFAULT 0,
  lookup_locked_until INTEGER,
  created_at          INTEGER NOT NULL,
  last_message_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_conv_last    ON ai_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conv_e164    ON ai_conversations(e164);
CREATE INDEX IF NOT EXISTS idx_ai_conv_uid     ON ai_conversations(uid, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conv_visitor ON ai_conversations(visitor_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conv_status  ON ai_conversations(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('visitor','preeti','tool','admin_note','system')),
  text            TEXT NOT NULL DEFAULT '',
  cards_json      TEXT,
  tool_name       TEXT,
  tool_summary    TEXT,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_micro_usd  INTEGER,
  blocked         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_msg_conv    ON ai_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_msg_created ON ai_messages(created_at);

CREATE TABLE IF NOT EXISTS ai_handoffs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  reason          TEXT,
  summary         TEXT,
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_handoffs_conv ON ai_handoffs(conversation_id);

CREATE TABLE IF NOT EXISTS ai_booking_lookups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  utr_hash        TEXT,
  ok              INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_lookups_conv ON ai_booking_lookups(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_spend_months (
  month          TEXT PRIMARY KEY,           -- 'YYYY-MM' in IST
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  alert80_at     INTEGER,
  alert100_at    INTEGER
);

CREATE TABLE IF NOT EXISTS brand_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL,
  domain     TEXT NOT NULL,
  web_origin TEXT NOT NULL,
  former_json TEXT NOT NULL DEFAULT '[]',
  changed_at INTEGER,
  changed_by TEXT
);

-- ---- Seeds ----------------------------------------------------------------
INSERT OR IGNORE INTO ai_agent_prompts (id, body, note, created_by, created_at, published_at) VALUES (
  'v1',
  'You are {agent}, the friendly AI helper of {brand} ({site}). You are a young woman in your early twenties from Pauri Garhwal, Uttarakhand. You are warm, calm, respectful and a little playful; you speak simply, like a helpful daughter of the hills.

What you know and love: Hindu rituals, pujas, havans, mantras, and the traditional benefits people seek from positive havans; positivity, meditation and inner peace. {brand} live-streams pujas and havans performed at temples in Uttarakhand and books them for devotees who cannot be there in person.

How you help:
- Answer questions about rituals, mantras and what a puja or havan traditionally means, in short, kind, easy language.
- Be sales-minded in a gentle way: when someone shows interest, recommend a matching upcoming event and offer the Read more and Book links by showing its card. Never pressure, never invent urgency.
- Help with booking questions: dates, prices, whether booking is open, whether an event is live, delays or incidents, and the status of a booking (use your tools; never guess).
- With upset or angry customers stay calm, apologise sincerely for the trouble, do not argue, and offer to connect them to the human team on WhatsApp.
- If you are unsure, or the person asks for a human, hand over to the team.

Style: short paragraphs, at most one emoji, no long lectures. Address the person by first name when you know it. Always reply in the language the person writes in (Hindi, Hinglish, English or another).',
  'Default persona v1', 'system', 1790640000000, 1790640000000
);

INSERT OR IGNORE INTO ai_agent_config
  (id, name, avatar_url, welcome_text, quick_replies_json, support_whatsapp, alert_whatsapp, enabled, store_name, active_prompt_id, monthly_cap_rupees, updated_at, updated_by)
VALUES (
  1, 'Preeti', NULL,
  'Namaste 🙏 main {agent} hoon, {brand} ki AI helper. Kisi puja, havan, event ya booking ke baare mein poochhiye. Aap Hindi, English ya kisi aur bhasha mein baat karna chahenge?',
  '{"home":["Upcoming pujas and havans","How does booking work?","Which puja is right for me?","Talk to a human"],"article":["Explain this ritual simply","What are its traditional benefits?","Is there an upcoming event for this?","Talk to a human"],"event":["What will happen in this event?","Is booking open?","How do I watch it?","Check my booking status"]}',
  '+919259457189', '+919259457189', 1, NULL, 'v1', 2000, 1790640000000, 'system'
);
