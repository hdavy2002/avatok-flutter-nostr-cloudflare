-- [WALLET-TXMETA-1] Rich charge metadata on the wallet audit trail (D1 `avatok-wallet`,
-- binding DB_WALLET). Carries WHAT a charge was for, WHO it was with, and the
-- Duration x Rate breakdown from the charge call site all the way into the row, so
-- the wallet statement renders context with NO cross-database lookup at read time.
--
-- Additive + fully backward-compatible: every column is nullable with no default, so
-- queue messages already in flight (which carry none of these) still insert cleanly.
-- Existing columns, indexes and the ON CONFLICT(id) DO NOTHING semantics are unchanged.
--
-- D1 has no "ADD COLUMN IF NOT EXISTS" — run these one at a time; a statement for a
-- column that already exists errors harmlessly.
--
--   category          -> coarse bucket: call|agent|transcribe|ava|video|market|topup|payout
--   context           -> short human string, e.g. "Voicemail from Marcus Reyes" (<=120 chars)
--   counterparty_name -> the other party's display name (counterparty_uid stays the id)
--   duration_sec      -> metered duration in seconds
--   rate_per_min      -> tokens per minute used for the breakdown
--
-- Apply to STAGING D1 first, then PROD as a deliberate step.

ALTER TABLE wallet_transactions ADD COLUMN category TEXT;
ALTER TABLE wallet_transactions ADD COLUMN context TEXT;
ALTER TABLE wallet_transactions ADD COLUMN counterparty_name TEXT;
ALTER TABLE wallet_transactions ADD COLUMN duration_sec INTEGER;
ALTER TABLE wallet_transactions ADD COLUMN rate_per_min REAL;
