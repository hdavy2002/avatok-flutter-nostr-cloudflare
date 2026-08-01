-- [RECEPT-NO-RUNTIME-DDL-1] Move the receptionist's self-migrating columns OFF
-- the call hot path (Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md — "No runtime DDL
-- on any call path", freeze decision 14).
--
-- WHY THIS EXISTS
-- ---------------
-- routes/receptionist.ts had `ensureStatusColumns()`: 25 ALTER TABLE statements
-- executed SEQUENTIALLY, guarded by a module-level `_receptColsEnsured` boolean.
-- That boolean is per-ISOLATE, not global — so every time Cloudflare spun up a
-- cold isolate, the very next call to /api/receptionist/start paid 25 serial
-- remote D1 round-trips BEFORE any receptionist work began.
--
-- That is a user-facing latency defect, not a migration strategy. It sits
-- directly in the decline -> Ava handoff, and it is a large part of why Ava took
-- several seconds to start speaking (prod: ws_connect_ms 6994 and 7965 on two
-- separate calls). It is also unbounded: every new column ever added made every
-- cold-isolate call slower, forever.
--
-- Schema migration is a DEPLOYMENT responsibility. This file is that deployment
-- step. After it is applied, ensureStatusColumns() becomes a no-op and the DDL
-- is deleted from the request path.
--
-- IDEMPOTENT AND SAFE TO RE-RUN. Every statement is the same guarded
-- ADD COLUMN the runtime code was already issuing, so on an already-migrated
-- database each one simply errors as "duplicate column" and D1 continues. The
-- columns are all NULLable with no default, exactly as the runtime path created
-- them, so this changes no existing row and no existing read.
--
-- D1 BINDING: DB_META (avatok-meta) — same database as receptionist_settings
-- and receptionist_sessions.
--
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote \
--   --file=migrations/2026-08-01-receptionist-columns-deploy-time.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules.)

-- ── receptionist_settings ──────────────────────────────────────────────────
-- F1: owner status note + expiry + default answering language.
ALTER TABLE receptionist_settings ADD COLUMN status_note TEXT;
ALTER TABLE receptionist_settings ADD COLUMN status_expires_at INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN answer_lang TEXT;

-- F2: customizable greeting — preset id + festival auto-greeting toggle.
ALTER TABLE receptionist_settings ADD COLUMN greeting_style TEXT;
ALTER TABLE receptionist_settings ADD COLUMN festival_greeting INTEGER;

-- [RECEPT-MODE-1] per-user answering mode: "agent" | "vm" | NULL (use flags).
ALTER TABLE receptionist_settings ADD COLUMN mode TEXT;

-- [RECEPT-ONBOARD-1] where the agent answers: "cell" | "app" | "all".
ALTER TABLE receptionist_settings ADD COLUMN agent_scope TEXT;

-- [AVACALL-SET-1] legacy paid per-user prefs, kept for back-compat echo.
ALTER TABLE receptionist_settings ADD COLUMN ai_receptionist_enabled INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN pstn_voicemail_enabled INTEGER;

-- [AVARECEPT-LANES-1] per-lane masters + shared per-scenario toggles (legacy).
ALTER TABLE receptionist_settings ADD COLUMN recept_avatok_enabled INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_pstn_enabled INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_on_missed INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_on_rejected INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_on_unreachable INTEGER;

-- [RECEPT-BACKEND-TOGGLES-1] the CURRENT model the routing decision reads:
-- two independent lanes x four independent scenarios. NULL = "never set" and
-- resolves to the sensible default in code (not_picked_up + rejected -> ON,
-- unreachable + redirect_all -> OFF).
ALTER TABLE receptionist_settings ADD COLUMN recept_pstn_not_picked_up INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_pstn_rejected INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_pstn_unreachable INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_pstn_redirect_all INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_avatok_not_picked_up INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_avatok_rejected INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_avatok_unreachable INTEGER;
ALTER TABLE receptionist_settings ADD COLUMN recept_avatok_redirect_all INTEGER;

-- ── receptionist_sessions ──────────────────────────────────────────────────
ALTER TABLE receptionist_sessions ADD COLUMN activation_mode TEXT;
ALTER TABLE receptionist_sessions ADD COLUMN team_id TEXT;
ALTER TABLE receptionist_sessions ADD COLUMN team_slot INTEGER;
