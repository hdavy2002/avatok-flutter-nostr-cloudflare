-- Owner request 2026-06-29: TRUE pending-membership group invites (DB_META / avatok-meta).
--
-- When platform_config.groupInvitesEnabled is ON, adding someone to a group
-- creates a PENDING invite here instead of an immediate conversation_members
-- row. The invitee Accepts (→ becomes a real member) or Declines. Because
-- pending users are NOT in conversation_members, the message router/fan-out is
-- completely unaffected — zero risk to existing group messaging.
--
-- Brand-new table, so this is a no-op for everything else.
CREATE TABLE IF NOT EXISTS group_invites (
  conv       TEXT NOT NULL,
  uid        TEXT NOT NULL,
  inviter    TEXT,
  group_name TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined
  created_at INTEGER,
  PRIMARY KEY (conv, uid)
);
CREATE INDEX IF NOT EXISTS idx_group_invites_uid ON group_invites (uid, status);
