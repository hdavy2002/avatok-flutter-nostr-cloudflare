-- [ADMIN2-USERS 2026-09-26] Admin 2 "Block user". DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
--
-- One row per CURRENTLY blocked account (unblock deletes the row; the history of who
-- blocked/unblocked whom lives in admin_audit on DB_WALLET). The block itself is enforced
-- in three places, all written by routes/admin2_users.ts:
--   1. Clerk ban (POST /v1/users/:id/ban) -> cannot sign in; Clerk revokes every session.
--   2. account_status.status='perm_banned' -> authz.ts requireUser (already checked on
--      every authed request) refuses the user's still-valid JWT with 403.
--   3. this row -> the admin list's Blocked filter, reason and who/when.
CREATE TABLE IF NOT EXISTS admin2_user_blocks (
  uid        TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL,
  admin_uid  TEXT NOT NULL,
  reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin2_user_blocks_at ON admin2_user_blocks(blocked_at);
