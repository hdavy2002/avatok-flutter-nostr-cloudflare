-- [LIVE-GRACE-1] ALTER ONLY -- do not apply automatically (coordinator/DEPLOY WP
-- runs this with `scripts/d1_apply_alters.py`, which per CLAUDE.md pitfall #6
-- applies only ALTER ADD COLUMN lines -- keep it that way, no CREATE TABLE here).
--
-- RULEBOOK-PAID-SESSIONS.md v2 §4 L4/L5: a live-event host disconnect starts a
-- grace window before the event is ended for good. `reconnect_deadline_ms` is
-- the wall-clock deadline for that window; `end_outcome` records why a session
-- ended (`host_no_return` is the only value WP8 writes -- NULL means the normal
-- end path).
--
-- Deliberately NOT touched: `commercial_sessions.state`'s CHECK constraint
-- (scheduled|backstage|live|ending|ended|cancelled|reconciliation_pending).
-- Widening it to add a literal 'reconnecting' value would require a full
-- table rebuild in SQLite/D1, which is not ALTER-only-safe. The raw `state`
-- column stays 'live' for the whole grace window; `commercialLiveState`
-- (worker/src/routes/commercial_stream_sessions.ts, safeSessionState) PROJECTS
-- state:'reconnecting' at the API layer from
-- (kind='live_event' AND state='live' AND reconnect_deadline_ms > now).
--
-- NOT APPLIED by this agent. Coordinator/DEPLOY WP to run it.

ALTER TABLE commercial_sessions ADD COLUMN reconnect_deadline_ms INTEGER;
ALTER TABLE commercial_sessions ADD COLUMN end_outcome TEXT;
