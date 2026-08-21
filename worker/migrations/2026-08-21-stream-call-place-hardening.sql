-- [STREAM-ENFORCE-2 2026-08-21] Hardening for POST /api/stream-calls/place.
--
-- 1. `ended_at` lets the glare check (job 3, plan Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md
--    §8) tell a "live" (approved, not yet ended) call apart from a stale one.
--    Set by the Stream webhook handler on call.ended / call.session_ended /
--    call.missed. NULL means "still open as far as the server knows".
-- 2. The pair index makes the reverse-direction glare lookup
--    (WHERE caller_uid=<other party> AND callee_uid=<this party>) cheap instead
--    of a table scan as call volume grows.
--
-- MUST BE APPLIED TO PROD D1 (avatok-meta) BEFORE THIS CODE IS DEPLOYED.
-- Apply with:
--   npx wrangler d1 execute avatok-meta --remote \
--     --file=worker/migrations/2026-08-21-stream-call-place-hardening.sql
-- (staging: same command with --env staging / the staging D1 binding, per
-- however scripts/cf.sh currently resolves environments — do NOT use bare
-- `wrangler`, see CLAUDE.md.)
--
-- This migration is additive and safe to run even if
-- worker/migrations/2026-08-19-stream-video-webhooks.sql (which creates
-- `stream_video_provider_decisions` and `stream_video_webhooks`) has NOT been
-- applied yet — in that case this file's ALTER TABLE will simply fail with
-- "no such table" and must be re-run after 2026-08-19's migration lands.
-- Confirm 2026-08-19 is applied first.

ALTER TABLE stream_video_provider_decisions ADD COLUMN ended_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_stream_video_provider_decisions_pair
  ON stream_video_provider_decisions(caller_uid, callee_uid, provider, ended_at);
