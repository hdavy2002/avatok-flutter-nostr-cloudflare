-- [AVA-VOICE-STYLE-1] / WS-14c — per-user "how Ava speaks" preference.
--
-- Owner decision, 2026-08-07: Ava speaks fun Hinglish Gen-Z by default
-- ("hold karo, mein 2K la raha hoon"), changeable in Ava's settings. India is
-- the only market.
--
-- WHY A NEW TABLE. There is no general per-user preference API in this worker:
-- GET /api/me returns profile columns only, `user_settings` (migrations/meta.sql)
-- is orphaned (referenced solely by the deletion sweep), and `user_vault` is
-- client-encrypted so the server cannot read it. This copies the auto-responder
-- pattern exactly (migrations/auto_responder.sql) — the one shape in this repo
-- that is already proven for "server-readable per-user setting on a hot path".
--
-- STORAGE MODEL
--   • Authoritative row lives here, in D1 (DB_META / avatok-meta).
--   • MIRRORED to KV (TOKENS, key `avast:style:<uid>`) because this value is read
--     on EVERY Ava turn (do/ava_agent.ts buildPrompt, composio.ts's agent loops,
--     ava_gemini.ts, ava_delegate.ts). The mirror keeps that a single fast KV get
--     instead of a D1 round-trip per turn. A mirror miss falls back to D1 and
--     re-warms it — see readVoiceStyle() in worker/src/lib/ava_persona.ts, which
--     owns both the key prefix and this table name.
--
-- PER-ACCOUNT SCOPING (Rulebook, mandatory). `uid` is the Clerk-verified account
-- id and is the PRIMARY KEY, so a parent and each child account sharing one phone
-- get independent rows. The GET/PUT routes always scope by ctx.uid — a caller can
-- only ever read or write their own row.
--
-- `style` is stored as READABLE TEXT, not the numeric enum. Only the platform
-- default (`avaVoiceStyleDefault`) is a number, and only because routes/config.ts
-- accepts nothing but `number` and `boolean` — a string config key 400s on
-- `putConfig`. Nothing forces that limitation onto D1 or the HTTP API.
--
-- No row = "follow the platform default". Deleting a row is how a user resets.
CREATE TABLE IF NOT EXISTS ava_voice_style_settings (
  uid        TEXT    PRIMARY KEY,           -- Clerk-verified account id (per-account scope)
  style      TEXT    NOT NULL DEFAULT 'hinglish', -- 'en' | 'hi' | 'hinglish' | 'auto'
  updated_at INTEGER NOT NULL DEFAULT 0     -- ms epoch of the last write
);
