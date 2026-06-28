-- Team Receptionist (IVR / auto-attendant) — Specs/TEAM-RECEPTIONIST-IVR-SPEC.md, 2026-06-28.
-- A Team is ONE billing unit owned by the subscribing manager. The manager adds
-- staff (name, role/department, voice, greeting, AvaTOK number); the ordered staff
-- list IS the "press 1 / press 2" menu on the team's AvaTOK number. Staff become Pro
-- for free while on the team, and ALL their AvaTOK expenses bill to the team wallet.
--
-- Apply to DB_META (avatok-meta):
--   wrangler d1 execute avatok-meta --remote --file=migrations/team_plan.sql
--   (or via the D1 REST /query endpoint).
--
-- Reuses: avatok_numbers (number->uid resolve), receptionist_settings/sessions
-- (per-staff Ava fallback + voicemail), WalletDO (team wallet), subscriptions/tierOf.

-- One row per team = one billing unit owned by the subscribing manager.
CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,          -- uuid
  owner_uid     TEXT NOT NULL,             -- the manager (subscriber)
  name          TEXT NOT NULL,             -- "Hilton"
  team_number   TEXT,                      -- the AvaTOK number that runs the IVR (avatok_numbers.number)
  greeting_text TEXT,                      -- "You've reached Hilton"
  greeting_clip TEXT,                      -- optional R2 key of a recorded greeting
  billing_uid   TEXT NOT NULL,             -- wallet that pays for member usage (defaults to owner_uid)
  plan_tier     INTEGER NOT NULL DEFAULT 2,-- effective tier granted to members (2 = Pro)
  seat_limit    INTEGER NOT NULL DEFAULT 5,
  -- Monthly pooled allowances ($50 plan): unlimited calls, 1000 receptionist
  -- minutes, ~3000 AI messages. Pools reset on period_start + 30d. NULL = unlimited.
  recept_min_quota  INTEGER NOT NULL DEFAULT 1000,
  ai_msg_quota      INTEGER NOT NULL DEFAULT 3000,
  recept_min_used   INTEGER NOT NULL DEFAULT 0,
  ai_msg_used       INTEGER NOT NULL DEFAULT 0,
  period_start      INTEGER,               -- epoch-ms of the current monthly window
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_number ON teams(team_number) WHERE team_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_uid);

-- One row per menu entry / staff member. slot = the "press N" digit / button order.
CREATE TABLE IF NOT EXISTS team_members (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  slot          INTEGER NOT NULL,          -- 1..9 (the press-N key / button order)
  display_name  TEXT NOT NULL,             -- "Julie"
  role_label    TEXT NOT NULL,             -- "Housekeeping" (button text + menu phrase)
  member_uid    TEXT,                      -- resolved Clerk uid of the staff account (NULL until accepted)
  member_number TEXT NOT NULL,             -- the staff member's AvaTOK number (E.164 digits, no '+')
  voice_name    TEXT NOT NULL DEFAULT 'Aoede', -- Ava voice for this dept's fallback
  greeting_text TEXT,                      -- per-dept Ava opener override (optional)
  invite_status TEXT NOT NULL DEFAULT 'pending', -- pending | active | removed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- One active entry per slot per team.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_slot ON team_members(team_id, slot) WHERE invite_status != 'removed';
CREATE INDEX IF NOT EXISTS idx_team_members_uid ON team_members(member_uid);
CREATE INDEX IF NOT EXISTS idx_team_members_number ON team_members(member_number);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- O(1) charge-time lookup: which team (if any) a uid belongs to, and who pays.
-- Denormalized billing_uid so billingUidFor() is a single PK read on the hot path.
CREATE TABLE IF NOT EXISTS team_billing_map (
  member_uid  TEXT PRIMARY KEY,            -- staff uid (one team per member in v1)
  team_id     TEXT NOT NULL,
  billing_uid TEXT NOT NULL,               -- = teams.billing_uid
  member_tier INTEGER NOT NULL DEFAULT 2,  -- entitlement granted while on the team
  updated_at  INTEGER NOT NULL
);

-- Tag the existing receptionist voicemail rows with team context so the message
-- card can be fanned out to the dialed staffer + the manager, and metered against
-- the team pool. Backward-compatible (nullable; old rows stay valid).
ALTER TABLE receptionist_sessions ADD COLUMN team_id TEXT;
ALTER TABLE receptionist_sessions ADD COLUMN team_slot INTEGER;
