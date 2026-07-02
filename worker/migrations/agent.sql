-- Phase 7 (v5.2 §7/§20) — Agentic layer. Tables in DB_META. Per-app persona
-- isolation is CRITICAL: an agent only knows what the user wrote in THAT app's
-- persona — never the full brain, never another app's persona.

-- One persona per (uid, app). persona_prompt + looking_for + boundaries + auto_approve.
CREATE TABLE IF NOT EXISTS agent_personas (
  uid           TEXT NOT NULL,
  app_name       TEXT NOT NULL,           -- 'avadate'|'avalinked'|'avaolx'|...
  persona_prompt TEXT NOT NULL,           -- the user's self-description for this app
  looking_for    TEXT,                    -- what they want (match criteria)
  boundaries     TEXT,                    -- hard constraints (never crossed)
  auto_approve   INTEGER NOT NULL DEFAULT 0, -- 0 = always inbox; 1 = auto + 1h undo
  enabled        INTEGER NOT NULL DEFAULT 1,
  moderation     TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'safe'|'unsafe' (moderated on save)
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (uid, app_name)
);

-- Agent-to-agent conversations (NOT E2E; persona-scoped). Self-expire after 30 days.
CREATE TABLE IF NOT EXISTS agent_conversations (
  id            TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,            -- owner (this row's perspective)
  app_name      TEXT NOT NULL,
  peer_uid     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active'|'concluded'|'paused'|'expired'|'unsafe'
  match_score   REAL,                     -- compatibility pre-check 0..1
  turns         INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  transcript    TEXT,                     -- JSON [{speaker, content}] (for inbox display)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL          -- created + 30 days
);
CREATE INDEX IF NOT EXISTS idx_aconv_uid ON agent_conversations(uid, app_name, created_at);
CREATE INDEX IF NOT EXISTS idx_aconv_expire ON agent_conversations(expires_at);

-- Agent Inbox = the single agent surface (§20). Color-coded per app, WhatsApp-style.
CREATE TABLE IF NOT EXISTS agent_inbox (
  id              TEXT PRIMARY KEY,
  uid            TEXT NOT NULL,
  app_name        TEXT NOT NULL,
  conversation_id TEXT,
  type            TEXT NOT NULL,          -- 'match'|'action'|'summary'|'message'
  title           TEXT NOT NULL,
  body            TEXT,
  summary         TEXT,
  proposed_action TEXT,                   -- 'connect'|'book'|'buy'|'reply'|...
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'dismissed'|'undone'|'auto_approved'
  undo_until      INTEGER,                -- auto_approve consequential action → now+1h
  data            TEXT,                   -- JSON payload for the action
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_uid ON agent_inbox(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON agent_inbox(uid, status, created_at);
