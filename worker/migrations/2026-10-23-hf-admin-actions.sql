-- [HF-ADMIN-COMPLETE-1] Admin desk timeline: notes, resolves, report reviews and replies sent from the desk. Not applied yet: apply with the usual
-- D1 migration step BEFORE deploying the worker (the action routes answer 500 "nothing was changed" until this table exists; the lists still load).
-- Also needs 2026-10-23-hf-reports.sql (hf_reports) for the /report queue.
CREATE TABLE IF NOT EXISTS hf_admin_actions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,            -- ticket | report | incident | member | money
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,                  -- note | resolve | reopen | reviewed | actioned | closed | open | reply_email | reply_whatsapp
  body TEXT,                             -- the note / reason / message that was sent
  channel TEXT,                          -- email | whatsapp for replies
  admin_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_admin_actions_subject ON hf_admin_actions(subject_type, subject_id, created_at);
