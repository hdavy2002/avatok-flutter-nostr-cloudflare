-- [HF-WIRE-9] Hello Fraands Reels app: "Invite" votes for influencers who are not on the app yet. DB_META.
-- CREATE only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-invite-votes.sql)
-- One vote per fan per (handle, platform). handle is stored lowercase WITHOUT the leading @. Purged with the account (hf_purge.ts).
CREATE TABLE IF NOT EXISTS hf_invite_votes (
  handle TEXT NOT NULL,
  platform TEXT NOT NULL,                         -- instagram|youtube
  uid TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (handle, platform, uid)
);
CREATE INDEX IF NOT EXISTS hf_invite_votes_rank ON hf_invite_votes(platform, handle);
CREATE INDEX IF NOT EXISTS hf_invite_votes_uid ON hf_invite_votes(uid);
