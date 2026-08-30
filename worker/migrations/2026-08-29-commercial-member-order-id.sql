-- [COMM-LIVE-AUTH-1] Move the per-ticket order_id off the SHARED session row and onto
-- the per-member row, where it belongs.
--
-- NOT EXECUTED BY CREATING THIS FILE. Like every other commercial migration
-- (see 2026-08-24-commercial-stream-sessions.sql:2-3), this is applied deliberately,
-- by hand, against a named environment. No runner references it.
--
-- WHY
-- ---
-- authorizeProviderJoin stamped the FIRST joiner's order_id onto commercial_sessions and
-- then re-verified it for every subsequent joiner. Live-event tickets have one order_id
-- each, so buyer #2 always mismatched and was refused 409 "commercial session authority
-- mismatch". Worse: the live_event host entitlement carries order_id NULL, so whenever
-- the host joined first, EVERY paying viewer was refused — while live settlement, which
-- only checks HOST connected time, still paid the creator 80% and the platform 20%.
--
-- order_id is a property of a PURCHASE. commercial_sessions is a property of an EVENT.
-- One live event has one session and N purchases. Putting a per-purchase value on the
-- shared row was a grain error, and the authority check faithfully enforced it.
--
-- The check itself was not wrong to exist — it stops a concurrent insert authorizing
-- against a different session. It keeps every other field (session id, kind, listing,
-- booking, creator, provider, call type, call id, scheduled_at), all of which derive
-- from the listing rather than from a buyer. Only order_id leaves.
--
-- Nullable, no backfill: the commercial lane has never been enabled in production
-- (all six commercial* flags read false on 2026-08-29), so there are no live rows.
-- Verify before applying:
--   SELECT COUNT(*) FROM commercial_session_members;

ALTER TABLE commercial_session_members ADD COLUMN order_id TEXT;

-- Answers "which ticket admitted this person", which is what the session-row check was
-- reaching for, at the right grain and without constraining anyone else's admission.
CREATE INDEX IF NOT EXISTS idx_commercial_member_order
  ON commercial_session_members(order_id);

-- NOT DENORMALIZED ONTO commercial_participant_intervals, deliberately. Intervals are
-- written from signed provider webhooks, which carry a provider_user_id and no order.
-- The order is already reachable by joining commercial_session_members on
-- (commercial_session_id, account_id), so copying it would add a second place for the
-- same fact to be wrong. Settlement (commercial_settlement.ts) joins that way already.
