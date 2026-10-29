-- [HF-SUPPORT-1] Hello Fraands support ticketing. DB_META. Contract: Specs/HF-SUPPORT-CONTRACT.md
-- CREATE TABLE / CREATE INDEX only (re-runnable). Seeds are in 2026-10-29-hf-support-seed.sql, the optional FTS5
-- search index in 2026-10-29-hf-support-fts.sql, the only ALTER (email_outbox.headers_json) in
-- 2026-10-29-hf-support-email-outbox-headers.sql. Apply in that order: tables -> seed -> fts -> alter.
-- D1 rows stay small: full HTML bodies and raw .eml live in R2 (BACKUP_R2, prefix support/).

-- Ticket numbers: n is the LAST number handed out. UPDATE support_counter SET n=n+1 WHERE id=1 RETURNING n is atomic.
-- The seed sets n=10000, so the first ticket is HF-10001. Numbers are never reused (a merged/trashed ticket keeps its number).
CREATE TABLE IF NOT EXISTS support_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);

-- One row per person who has written to support. uid is NULL for an email-only guest until they verify (then all their
-- earlier tickets attach to the account: support_tickets.uid is back-filled by email).
CREATE TABLE IF NOT EXISTS support_contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT,                               -- lower-case; NULL for an app user with no email on file
  uid        TEXT,
  whatsapp   TEXT,                               -- E.164, only if the person gave/verified it
  name       TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_contacts_email ON support_contacts(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_contacts_uid ON support_contacts(uid) WHERE uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_tickets (
  number              INTEGER PRIMARY KEY,       -- 10001...  shown as HF-<number>
  uid                 TEXT,                      -- account, NULL for an unverified email-only sender
  contact_id          INTEGER NOT NULL,
  subject             TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',  -- calls|wallet|withdraw|bookings|influencer|app|report|other
  priority            TEXT NOT NULL DEFAULT 'normal', -- low|normal|high|urgent
  status              TEXT NOT NULL DEFAULT 'new',    -- new|open|waiting|on_hold|solved|closed|spam|trash
  assignee_uid        TEXT,
  channel             TEXT NOT NULL DEFAULT 'email',  -- email|app|web
  preview             TEXT NOT NULL DEFAULT '',       -- first 160 chars of the latest customer/staff message
  last_customer_at    INTEGER,
  last_staff_at       INTEGER,
  first_response_due_at INTEGER,
  first_responded_at  INTEGER,
  waiting_since       INTEGER,                   -- when it entered 'waiting' (drives the 5-day reminder)
  reminder_sent_at    INTEGER,
  solved_at           INTEGER,
  closed_at           INTEGER,
  snooze_until        INTEGER,
  merged_into         INTEGER,                   -- number of the ticket this one was merged into
  linked_from         INTEGER,                   -- number of the closed ticket this one continues
  money               INTEGER NOT NULL DEFAULT 0, -- 1 = money category: kept 8 years instead of 3
  unread_customer     INTEGER NOT NULL DEFAULT 0, -- 1 = staff replied and the customer has not opened it
  unread_staff        INTEGER NOT NULL DEFAULT 1,
  last_nudge_at       INTEGER,                   -- customer WhatsApp nudge throttle (once per 30 min)
  meta_json           TEXT,                      -- app version/build/device/os/lastScreen/platform from the form
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_uid ON support_tickets(uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_contact ON support_tickets(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets(assignee_uid, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id              TEXT PRIMARY KEY,              -- uuid
  ticket_number   INTEGER NOT NULL,
  author_type     TEXT NOT NULL,                 -- customer|staff|system|note   (note = internal, NEVER sent to the customer API)
  author_uid      TEXT,
  author_name     TEXT,
  text            TEXT NOT NULL DEFAULT '',      -- plain text, capped at 8000 chars; the full body is in R2
  html_r2_key     TEXT,                          -- BACKUP_R2 support/html/<ticket>/<id>.html
  raw_r2_key      TEXT,                          -- BACKUP_R2 support/inbound/...eml for email-borne messages
  preview         TEXT NOT NULL DEFAULT '',
  message_id_header TEXT,                        -- RFC 5322 Message-ID (angle brackets stripped)
  in_reply_to     TEXT,
  hash            TEXT,                          -- sha256 of normalised text, for the 10-minute identical-message merge
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_number, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_msgid ON support_messages(message_id_header) WHERE message_id_header IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_attachments (
  id            TEXT PRIMARY KEY,                -- uuid
  r2_key        TEXT NOT NULL,                   -- BACKUP_R2 support/att/... (purpose=signature: BLOBS support-signature/...)
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  ticket_number INTEGER,                         -- NULL while uploaded but not yet attached to a message
  message_id    TEXT,
  uid           TEXT,                            -- uploader
  purpose       TEXT NOT NULL DEFAULT 'ticket',  -- ticket|signature
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket ON support_attachments(ticket_number);
CREATE INDEX IF NOT EXISTS idx_support_attachments_message ON support_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_support_attachments_orphan ON support_attachments(created_at) WHERE ticket_number IS NULL;

CREATE TABLE IF NOT EXISTS support_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number INTEGER NOT NULL,
  actor         TEXT NOT NULL,                   -- 'system' | 'customer' | staff uid
  type          TEXT NOT NULL,                   -- created|status|priority|category|assign|merge|split|reply|note|reminder|nudge|alert|...
  data_json     TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_events_ticket ON support_events(ticket_number, created_at);

CREATE TABLE IF NOT EXISTS support_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_staff (
  email      TEXT PRIMARY KEY,                   -- lower-case; matched to a uid at login by the account's VERIFIED email
  uid        TEXT,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'agent',      -- admin|agent|viewer
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_staff_uid ON support_staff(uid) WHERE uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_canned (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  shortcut   TEXT,
  category   TEXT,
  body_html  TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- scope_key: 'team' or 'me:<uid>'. use_for is read from the 'me:' row: which signature that person's replies carry.
CREATE TABLE IF NOT EXISTS support_signatures (
  scope_key  TEXT PRIMARY KEY,
  html       TEXT NOT NULL DEFAULT '',
  use_for    TEXT NOT NULL DEFAULT 'team',       -- team|personal
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_blocklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                      -- email|domain
  value      TEXT NOT NULL,                      -- lower-case
  reason     TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_blocklist_value ON support_blocklist(kind, value);

-- Collision warning: one heartbeat per (ticket, staff member); a row older than 30 s is ignored and swept.
CREATE TABLE IF NOT EXISTS support_viewers (
  ticket_number INTEGER NOT NULL,
  uid           TEXT NOT NULL,
  name          TEXT,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (ticket_number, uid)
);

-- Every raw email that reached the worker. The queue carries only the id/R2 key; this row is the durable record so a
-- failed queue send can be re-queued by the cron (status 'received' older than 2 minutes).
CREATE TABLE IF NOT EXISTS support_inbound (
  id            TEXT PRIMARY KEY,                -- uuid (also the .eml file name)
  r2_key        TEXT NOT NULL,
  env_from      TEXT,
  env_to        TEXT,
  message_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'received', -- received|processed|duplicate|dropped|spam|failed
  reason        TEXT,
  ticket_number INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_support_inbound_status ON support_inbound(status, created_at);

-- Auto-reply limit: at most 3 automatic emails per recipient per hour.
CREATE TABLE IF NOT EXISTS support_autoreply_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_autoreply_recipient ON support_autoreply_log(recipient, created_at);

-- Admin WhatsApp alert window counter (one row per minute). n = alerts wanted in that minute; summarised = 1 once the
-- over-limit summary for that minute was queued.
CREATE TABLE IF NOT EXISTS support_alert_window (
  minute     INTEGER PRIMARY KEY,                -- floor(ms / 60000)
  n          INTEGER NOT NULL DEFAULT 0,
  new_n      INTEGER NOT NULL DEFAULT 0,
  reply_n    INTEGER NOT NULL DEFAULT 0,
  summarised INTEGER NOT NULL DEFAULT 0
);
