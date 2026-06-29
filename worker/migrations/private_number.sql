-- Owner request 2026-06-29: optional user-exposed private number (DB_META / avatok-meta).
--
-- A user may add a private phone number and opt to expose it. When
-- show_private_number=1, the AvaTOK dialpad resolves private_number to this
-- account (worker/src/routes/api.ts resolve) so calls ring their AvaTOK app, and
-- the share card shows it instead of the AvaTOK number. private_number is stored
-- as DIGITS (matches the numeric resolve). Not verified yet (verification stub).
--
-- Backward-compatible: both columns are optional / default 0, so existing rows
-- are unaffected. The resolve query is GUARDED to fall back to AvaTOK-only if
-- this migration hasn't been applied — apply it BEFORE deploying avatok-api so
-- the opt-in path works.
ALTER TABLE users ADD COLUMN private_number TEXT;
ALTER TABLE users ADD COLUMN show_private_number INTEGER NOT NULL DEFAULT 0;
