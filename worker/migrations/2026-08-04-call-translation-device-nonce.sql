-- [CALL-TRANSLATE-2B-3] Bind provider-token issuance to the device that created
-- the session. NULLable on purpose: sessions created by pre-nonce clients carry
-- NULL and are never rejected. Enforcement is "both sides present and unequal".
-- Must be applied BEFORE deploying the matching worker code: /start writes this
-- column, so a worker on the new code against an un-migrated D1 cannot create a
-- session at all.
ALTER TABLE translation_call_sessions ADD COLUMN device_nonce TEXT;
