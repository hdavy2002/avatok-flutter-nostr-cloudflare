-- Liveness V3_1 — AI-avatar / second-phone / injected-camera defense layer
-- (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md §0-C, 2026-07-06).
--
-- ADDITIVE ONLY. This does NOT edit the already-committed migration
-- (worker/migrations/liveness_v3.sql). It:
--   1. adds an active_checks column to liveness_v3_sessions (server-randomized
--      flash/vibrate/challenge-gap schedule persisted per session), and
--   2. adds the avatar-defense score columns + capture_meta blob to
--      liveness_v3_verdicts (append-only audit of what the defense layer computed).
--
-- Applied to DB_META (same shard as the base V3 tables).
-- DO NOT apply automatically — the orchestrator/owner applies migrations.
-- SQLite/D1 has no "ADD COLUMN IF NOT EXISTS"; these ALTERs are idempotent by
-- being run once at rollout (a re-run erroring on "duplicate column" is benign).

-- ── 1. Session: persist the server-randomized active_checks schedule. ─────────
-- JSON {flash_sequence:[{color,t_offset_ms,duration_ms}], vibrate:{...}|null,
--       challenge_gaps_ms:[...]}. NULL for sessions created before this rollout.
ALTER TABLE liveness_v3_sessions ADD COLUMN active_checks TEXT;

-- ── 2. Verdict: avatar-defense scores + the raw capture_meta the client sent. ──
-- Scores are 0..100 or NULL (uncomputable → NULL, never a penalty). display_signals
-- is the per-signal weighted breakdown; camera_path is the integrity summary
-- (rooted/emulator/virtual_camera/instrumentation + verbatim play_integrity);
-- capture_meta is the size-capped (~32KB) client payload for forensic re-review.
ALTER TABLE liveness_v3_verdicts ADD COLUMN display_suspicion_score  INTEGER;  -- 0..100 | NULL
ALTER TABLE liveness_v3_verdicts ADD COLUMN flash_correlation_score  INTEGER;  -- 0..100 | NULL
ALTER TABLE liveness_v3_verdicts ADD COLUMN sensor_correlation_score INTEGER;  -- 0..100 | NULL
ALTER TABLE liveness_v3_verdicts ADD COLUMN display_signals          TEXT;     -- JSON breakdown
ALTER TABLE liveness_v3_verdicts ADD COLUMN camera_path              TEXT;     -- JSON integrity summary
ALTER TABLE liveness_v3_verdicts ADD COLUMN timing_anomaly           INTEGER;  -- 0|1
ALTER TABLE liveness_v3_verdicts ADD COLUMN policy_escalation        INTEGER;  -- 0|1
ALTER TABLE liveness_v3_verdicts ADD COLUMN device_context_changed   INTEGER;  -- 0|1 (informational)
ALTER TABLE liveness_v3_verdicts ADD COLUMN capture_meta             TEXT;     -- JSON, ≤32KB
