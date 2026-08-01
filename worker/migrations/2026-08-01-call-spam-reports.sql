-- [CALL-SPAM-REPORT-1] Report-a-caller evidence store (Phase 2 of
-- Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md). worker/src/routes/api.ts
-- callReportSpam() is the only writer.
--
-- D1 BINDING: DB_META (avatok-meta) — the same database as `blocks` and the
-- `spam_*` families, because a report frequently accompanies a block and the
-- two must be readable together.
--
-- NAMING CAVEAT (mirrors the note in 2026-07-12-spam-reputation.sql): there are
-- now THREE unrelated spam tables and they must not be confused —
--   spam_reports        message moderation, conv-keyed  (spam_reports.sql)
--   spam_number_reports phone-number reputation, e164-keyed (2026-07-12-…)
--   call_spam_reports   THIS ONE: an AvaTOK CALLER, uid-keyed
-- A caller on an AvaTOK-to-AvaTOK call has a uid, not a number, so neither
-- existing table fits: spam_number_reports requires a normalized E.164 and
-- rejects anything under 6 digits, and spam_reports requires a conv + pulls
-- message envelopes out of the reporter's InboxDO.
--
-- WHY THE EXTRA COLUMNS: "A reported B" is not enough evidence to action
-- anything. The frozen spec requires enough context to tell a genuine abuse
-- report from a mis-tap or a retaliatory report — whether the two had any prior
-- relationship, whether the reporter had the caller in contacts, how long the
-- call had been ringing, and which identity snapshot the reporter actually saw
-- (so a later profile rename cannot rewrite what they were looking at).
-- Deliberately NOT captured: call audio or content. A report is not consent to
-- retain a recording.
--
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote \
--   --file=migrations/2026-08-01-call-spam-reports.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules.)

CREATE TABLE IF NOT EXISTS call_spam_reports (
  id                       TEXT NOT NULL,          -- report id (uuid)
  reporter_uid             TEXT NOT NULL,          -- the CALLEE who reported
  reported_uid             TEXT NOT NULL,          -- the CALLER being reported
  call_id                  TEXT NOT NULL,          -- ties the report to one ring
  report_category          TEXT NOT NULL DEFAULT 'spam', -- spam|scam|harassment|other
  call_started_at          INTEGER,                -- when the ring began (ms)
  report_created_at        INTEGER NOT NULL,       -- when they tapped Report (ms)
  ring_duration_ms         INTEGER,                -- how long it rang before the tap
  identity_snapshot_version INTEGER,               -- caller profile version they SAW
  reported_display_name    TEXT,                   -- the name shown at report time
  prior_relationship       TEXT,                   -- none|contact|prior_call|prior_chat
  contacts_match           INTEGER NOT NULL DEFAULT 0, -- 1 = caller was in reporter's contacts
  also_blocked             INTEGER NOT NULL DEFAULT 0, -- 1 = reporter also blocked them
  client_device_id         TEXT,
  PRIMARY KEY (id)
);

-- One report per (reporter, call). A double-tap or an FCM action replay must
-- not inflate a caller's report count — that is trivially weaponisable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_spam_reports_reporter_call
  ON call_spam_reports (reporter_uid, call_id);

-- "How many people reported this caller, and when" — the scoring read path.
CREATE INDEX IF NOT EXISTS idx_call_spam_reports_reported
  ON call_spam_reports (reported_uid, report_created_at);

-- "What has this reporter filed" — abuse-of-reporting detection.
CREATE INDEX IF NOT EXISTS idx_call_spam_reports_reporter
  ON call_spam_reports (reporter_uid, report_created_at);
