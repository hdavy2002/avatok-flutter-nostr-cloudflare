-- Ava Receptionist v2 — persona UI, activation modes, in-thread delivery
-- (Specs/PROPOSAL-RECEPTIONIST-V2.md). Additive ALTERs on the v1 tables.
-- Apply: wrangler d1 execute DB_META --remote --file=migrations/receptionist_v2.sql
--
-- SQLite/D1 has no "ADD COLUMN IF NOT EXISTS"; each ALTER errors if the column
-- already exists. Run once; re-runs of an individual line that already applied
-- can be ignored. (The trigger is RING-based — there is NO miss-counter table.)

-- Persona / behaviour (injected into the locked, server-side system prompt).
ALTER TABLE receptionist_settings ADD COLUMN persona_name   TEXT;     -- what Ava calls herself ("Maya")
ALTER TABLE receptionist_settings ADD COLUMN language_code  TEXT;     -- BCP-47; NULL = auto-detect
ALTER TABLE receptionist_settings ADD COLUMN greeting_text  TEXT;     -- exact opening line (optional)
ALTER TABLE receptionist_settings ADD COLUMN custom_prompt  TEXT;     -- advanced; appended, never replaces safety scaffold

-- Activation (v2 §2). answer_all = Mode B (answer on first ring); status feeds
-- the prompt ("Sonal is travelling…"); decline_to_ava = Mode C decline path.
ALTER TABLE receptionist_settings ADD COLUMN answer_all     INTEGER NOT NULL DEFAULT 0; -- 0/1: answer every call on the first ring
ALTER TABLE receptionist_settings ADD COLUMN status_preset  TEXT;     -- busy|travelling|meeting|driving|holiday|after_hours|custom
ALTER TABLE receptionist_settings ADD COLUMN status_custom  TEXT;     -- free text when status_preset='custom'
ALTER TABLE receptionist_settings ADD COLUMN decline_to_ava INTEGER NOT NULL DEFAULT 0; -- 0/1: red Decline routes to Ava

-- How a given call was handed off (telemetry / analytics split).
ALTER TABLE receptionist_sessions ADD COLUMN activation_mode TEXT;    -- rings|first_ring|manual|decline
