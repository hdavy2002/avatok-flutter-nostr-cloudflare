-- Ava Receptionist — premium "Ava answers after 5 rings" (Specs/PROPOSAL-AI-RECEPTIONIST.md).
-- First real AvaVoice deployment. Gemini Live via Cloudflare AI Gateway, 2-min cap.
-- Apply: wrangler d1 execute DB_META --remote --file=migrations/receptionist.sql
--
-- NOTE: per-owner config only — there is NO billing/escrow in v1 (premium perk;
-- metering is recorded via AI Gateway, AvaCoins charges come later). Tables live
-- in D1_META alongside avavoice_*.

-- One row per owner (the AvaTalk user whose missed calls Ava answers).
CREATE TABLE IF NOT EXISTS receptionist_settings (
  owner_uid         TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 0,      -- 0/1 (premium-gated to flip on)
  instructions_text TEXT,                            -- "Leave Instructions for Ava" free text
  voice_name        TEXT NOT NULL DEFAULT 'Puck',    -- Gemini Live prebuilt voice
  display_name      TEXT,                            -- how Ava refers to the owner ("Sonal")
  file_search_store TEXT,                            -- optional Gemini File Search store (RAG)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- One row per inbound call Ava answered (or attempted). Keyed-by-phone delivery.
CREATE TABLE IF NOT EXISTS receptionist_sessions (
  id                    TEXT PRIMARY KEY,
  owner_uid             TEXT NOT NULL,               -- callee whose Ava answered
  caller_uid            TEXT,                        -- caller's AvaTOK uid if known (else NULL)
  caller_phone          TEXT,                        -- normalized E.164 of the caller (delivery key)
  caller_name           TEXT,                        -- caller's display/contact name if known
  call_id               TEXT,                        -- the originating AvaTalk call id
  status                TEXT NOT NULL DEFAULT 'active', -- active|ended
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  duration_s            INTEGER NOT NULL DEFAULT 0,
  cutoff_reason         TEXT,                        -- caller_hangup|soft_wrap|hard_cap|error|kill_switch
  summary_json          TEXT,                        -- { caller_name, reason, callback, urgency }
  transcript            TEXT,                        -- full transcript text
  recording_url         TEXT,                        -- R2 key of the voicemail recording
  ai_gateway_request_id TEXT,                        -- AI Gateway cf-aig log id (metering hook)
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recept_sessions_owner ON receptionist_sessions(owner_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_recept_sessions_caller ON receptionist_sessions(owner_uid, caller_phone, created_at);
CREATE INDEX IF NOT EXISTS idx_recept_sessions_active ON receptionist_sessions(status, started_at);
