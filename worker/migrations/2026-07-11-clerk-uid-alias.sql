-- [ACCT-RELINK-1] Clerk uid alias — heal accounts orphaned by a changed Clerk id.
-- Spec/context: an account is keyed by the Clerk user id (users.uid). If that Clerk
-- user is destroyed (e.g. the account-deletion cascade's step 13 deletes the Clerk
-- user) and the SAME person signs back in with Google, Clerk mints a BRAND-NEW user
-- id. /api/me then finds no `users` row for the new id and forks the person into
-- onboarding + "choose a new number", orphaning their real account (handle, number,
-- messages) under the old, now-dead uid.
--
-- Fix: an alias table mapping the NEW Clerk id -> the ORIGINAL account uid. /api/me
-- relinks by the Clerk-verified email on a miss; auth.ts:resolveCanonicalUid() then
-- makes EVERY authenticated request resolve the new id to the original uid, so all
-- existing data (InboxDO messages, wallet, media — all keyed by the original uid)
-- stays intact. We alias, never re-key: DO storage is bound to the original uid and
-- cannot be moved.
--
-- Apply: scripts/cf.sh worker d1 execute avatok-meta --remote --file=migrations/2026-07-11-clerk-uid-alias.sql
-- Run against DB_META. Safe to run once; CREATE ... IF NOT EXISTS is idempotent.
-- The worker guards every read/write of this table in try/catch, so shipping the
-- code before this migration lands simply disables aliasing (no errors).

CREATE TABLE IF NOT EXISTS clerk_uid_alias (
  alias_clerk_id TEXT PRIMARY KEY,   -- the NEW Clerk user id produced after re-auth
  canonical_uid  TEXT NOT NULL,      -- the ORIGINAL account uid (users.uid)
  reason         TEXT,               -- e.g. 'email_relink'
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clerk_uid_alias_canonical
  ON clerk_uid_alias(canonical_uid);
