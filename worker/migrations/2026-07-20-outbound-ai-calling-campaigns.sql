-- [AVA-CAMP-A2] Outbound AI calling campaigns — Phase A (Foundations) D1 schema.
--
-- Spec: Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md, §3 (Data model) and §17
-- ("A — Foundations: ... `user_dids` migration + receptionist-number
-- backfill, ..."). This file ships the DDL only — see the TODO block at the
-- bottom for the receptionist-number backfill, which is a data step, not
-- schema, and is intentionally NOT run here.
--
-- Shard: metaDb (DB_META / `avatok-meta`, staging `avatok-meta-staging`) —
-- "D1 is the authoritative store" for campaign state (spec §1.5, §2). All
-- seven tables below are low-write global/per-account surfaces, consistent
-- with the rest of DB_META (receptionist, wallet_ledger audit rows, etc.);
-- high-write execution state stays in the DOs (CampaignDO, DialerGateDO,
-- WalletDO) per the architecture in §2.
--
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS); safe to re-run. Apply:
--   scripts/cf.sh worker d1 execute DB_META --remote \
--     --file=migrations/2026-07-20-outbound-ai-calling-campaigns.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 per the repo's
-- staging/prod rules — never invoke wrangler directly.)
--
-- Column-type conventions matched to the rest of this migrations/ directory
-- (see 2026-07-16-pstn-platform.sql, 2026-07-18-marketplace-verticals.sql):
--   * timestamps are INTEGER epoch-ms (`created_ms`-style), NOT TEXT ISO,
--     except where the spec names a field `_at` and it is being frozen at a
--     later phase — those are left INTEGER (epoch ms) here too for
--     consistency; the app layer formats display.
--   * booleans are INTEGER 0/1 (SQLite has no native BOOLEAN).
--   * "JSON" columns per spec (retry_policy, provider_meta, extra,
--     kb_files_meta, transcript, tools_used) are TEXT storing serialized
--     JSON, same convention as `pstn_forwarding`/`marketplace_verticals`
--     above and `wallet_ledger` elsewhere in this directory.
--   * ids (`id`, `campaign_id`, `contact_id`) are TEXT (uuid), matching
--     `attempt_uuid` and the rest of the DO-adjacent tables in this schema —
--     D1 is not the id-minting authority, the Worker/DO layer is.
--   * `uid` is TEXT, matching every other per-account table in this repo.

-- ---------------------------------------------------------------------------
-- user_dids — owned Vobiz (and future-provider) DIDs, shared pool between the
-- AI receptionist and outbound campaigns (spec §3, §5 "DID renewal").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_dids (
  id                TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  e164              TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'vobiz',
  purpose           TEXT NOT NULL,               -- receptionist | campaign | shared
  monthly_tokens    INTEGER NOT NULL DEFAULT 700,
  status            TEXT NOT NULL DEFAULT 'active', -- active | past_due | released
  purchased_at      INTEGER NOT NULL,             -- epoch ms
  next_renewal_at   INTEGER,                      -- epoch ms
  provider_meta     TEXT                          -- JSON
);
CREATE INDEX IF NOT EXISTS idx_user_dids_uid ON user_dids (uid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_dids_e164 ON user_dids (e164);

-- ---------------------------------------------------------------------------
-- campaigns — one row per outbound campaign (spec §3, §5, §6, §17 seam 4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                        TEXT PRIMARY KEY,
  uid                       TEXT NOT NULL,
  name                      TEXT NOT NULL,
  goal_text                 TEXT NOT NULL,

  -- frozen at launch (§4, §19 seam 4):
  prompt_version            INTEGER,
  compiled_prompt           TEXT,
  compiled_prompt_hash      TEXT,
  tool_runtime_version      INTEGER,
  fsm_version               INTEGER,
  kb_version                INTEGER,
  analytics_schema_version  INTEGER,

  kb_store                  TEXT,                 -- campaign Gemini File Search store name
  business_kb_attached      INTEGER NOT NULL DEFAULT 0,

  did_e164                  TEXT,
  language_hint             TEXT,
  voice_persona             TEXT,

  status                    TEXT NOT NULL DEFAULT 'draft',
  -- draft|ready|running|pausing|paused|cancelling|window_wait|completed|cancelled|out_of_tokens

  concurrency               INTEGER NOT NULL DEFAULT 1,
  window_start_min          INTEGER NOT NULL DEFAULT 600,   -- 10:00 IST
  window_end_min            INTEGER NOT NULL DEFAULT 1140,  -- 19:00 IST
  retry_policy              TEXT,                 -- JSON, per-cause (§6.4)
  spend_cap_tokens          INTEGER NOT NULL,      -- mandatory (§5)

  booking_enabled           INTEGER NOT NULL DEFAULT 0,
  handover_enabled          INTEGER NOT NULL DEFAULT 0,
  handover_number           TEXT,
  handover_window           TEXT,                 -- JSON or text window spec
  max_handovers_per_day     INTEGER,
  record_handover           INTEGER NOT NULL DEFAULT 0,

  -- counters — columns, not JSON (spec explicit):
  n_total                   INTEGER NOT NULL DEFAULT 0,
  n_done                    INTEGER NOT NULL DEFAULT 0,
  n_answered                INTEGER NOT NULL DEFAULT 0,
  n_missed                  INTEGER NOT NULL DEFAULT 0,
  n_busy                    INTEGER NOT NULL DEFAULT 0,
  n_machine                 INTEGER NOT NULL DEFAULT 0,
  n_failed                  INTEGER NOT NULL DEFAULT 0,
  n_dnc                     INTEGER NOT NULL DEFAULT 0,

  tokens_spent              INTEGER NOT NULL DEFAULT 0,
  seconds_talked            INTEGER NOT NULL DEFAULT 0,

  created_by                TEXT NOT NULL,
  created_at                INTEGER NOT NULL,      -- epoch ms
  contacts_hash             TEXT,                  -- audit (ingestion dedupe, §6.2)
  started_at                INTEGER,               -- epoch ms
  completed_at              INTEGER                -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_campaigns_uid_status ON campaigns (uid, status);

-- ---------------------------------------------------------------------------
-- campaign_contacts — ingested contact list rows (spec §3, §6.2, §6.3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
  name             TEXT,
  e164_raw         TEXT,                 -- as parsed, pre-normalization (audit)
  e164             TEXT,                 -- normalized E.164
  extra            TEXT,                 -- JSON, arbitrary mapped columns
  source_row       INTEGER,              -- original row number in the upload
  status           TEXT NOT NULL DEFAULT 'pending',
  -- pending|dial_reserved|calling|done|missed|busy|voicemail|invalid|dnd_blocked|failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_outcome     TEXT,
  last_called_at   INTEGER,              -- epoch ms
  next_attempt_at  INTEGER               -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_status
  ON campaign_contacts (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_next_attempt
  ON campaign_contacts (campaign_id, next_attempt_at);

-- ---------------------------------------------------------------------------
-- campaign_call_attempts — one row per dial attempt (spec §3, §4, §5, §19
-- seams 2/3/4/5/6/7).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_call_attempts (
  attempt_uuid              TEXT PRIMARY KEY,
  campaign_id                TEXT NOT NULL REFERENCES campaigns(id),
  contact_id                 TEXT NOT NULL REFERENCES campaign_contacts(id),
  call_uuid                  TEXT,               -- provider (Vobiz) call id

  purpose                    TEXT NOT NULL DEFAULT 'LIVE',  -- LIVE | TEST

  -- frozen version snapshot, all five on this one row (§19 seam 4):
  prompt_version              INTEGER,
  tool_runtime_version         INTEGER,
  fsm_version                  INTEGER,
  kb_version                   INTEGER,
  analytics_schema_version     INTEGER,

  kb_store_name               TEXT,               -- so replay survives KB GC (§19 seam 3)
  kb_files_meta                TEXT,               -- JSON: hashes/names

  created_at                  INTEGER NOT NULL,    -- epoch ms, before the outbound POST
  ring_at                      INTEGER,
  answered_at                  INTEGER,
  ended_at                      INTEGER,

  outcome                       TEXT,               -- answered|no_answer|busy|machine|failed|canceled
  hangup_cause_raw              TEXT,               -- provider cause, verbatim

  amd_result                    TEXT,
  amd_confidence                 REAL,

  ai_duration_s                  INTEGER,            -- distinct from pstn_total (§19 seam 2)
  pstn_total_duration_s           INTEGER,

  human_segment_seconds            INTEGER,

  tokens_reserved                   INTEGER,
  tokens_spent                       INTEGER,

  recording_key                       TEXT,
  recording_status                     TEXT,          -- pending_upload | stored | expired
  human_recording_key                   TEXT,

  transcript_lang                        TEXT,
  transcript                              TEXT,        -- JSON
  summary_text                             TEXT,

  tools_used                                TEXT,      -- JSON: [{tool, success, elapsed_ms, result_summary}]

  booking_event_id                           TEXT,

  handover_status                             TEXT     -- none|attempted|connected|failed|failed_machine|caller_abandoned
);
CREATE INDEX IF NOT EXISTS idx_campaign_call_attempts_campaign
  ON campaign_call_attempts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_call_attempts_call_uuid
  ON campaign_call_attempts (call_uuid);

-- ---------------------------------------------------------------------------
-- fsm_transitions — CallFSM audit rows (spec §3, §4, §15, §19 seam 4/6).
-- NOTE: `from`/`to` are SQL reserved-ish identifiers; the spec's shorthand
-- `(attempt_uuid, from, to, ts, trigger, correlation_id)` is implemented here
-- as `from_state`/`to_state` per the task instruction, to avoid needing
-- quoting on every query.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fsm_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_uuid    TEXT NOT NULL REFERENCES campaign_call_attempts(attempt_uuid),
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  ts              INTEGER NOT NULL,     -- epoch ms
  trigger         TEXT,                 -- webhook | tool | user | system
  correlation_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fsm_transitions_attempt ON fsm_transitions (attempt_uuid);

-- ---------------------------------------------------------------------------
-- campaign_kb_files — per-campaign KB uploads (spec §3, §9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_kb_files (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  r2_key        TEXT NOT NULL,
  name          TEXT NOT NULL,
  bytes         INTEGER,
  sha256        TEXT,
  indexed_at    INTEGER,               -- epoch ms
  status        TEXT NOT NULL DEFAULT 'pending'  -- pending|indexed|failed|deleted
);
CREATE INDEX IF NOT EXISTS idx_campaign_kb_files_campaign ON campaign_kb_files (campaign_id);

-- ---------------------------------------------------------------------------
-- dnc_suppression — account-level, permanent do-not-call list (spec §3, §14).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dnc_suppression (
  uid                 TEXT NOT NULL,
  e164                TEXT NOT NULL,
  reason              TEXT,             -- opt_out | ndnc_complaint | manual
  source_campaign_id  TEXT,
  created_at          INTEGER NOT NULL, -- epoch ms
  PRIMARY KEY (uid, e164)
);

-- ---------------------------------------------------------------------------
-- TODO (follow-up data step, NOT part of this DDL — spec §5 "DID renewal",
-- §17 Phase A: "user_dids migration + receptionist-number backfill"):
--
-- Existing receptionist-purchased Vobiz DIDs (tracked today in the
-- receptionist tables — see migrations/receptionist.sql /
-- migrations/receptionist_v2.sql / migrations/2026-07-16-pstn-platform.sql
-- `pstn_dids`) need one INSERT OR IGNORE per DID into `user_dids` with
-- purpose='receptionist', so both features share one store per spec §5
-- ("Backfill receptionist-purchased numbers into user_dids so both features
-- share one store; reusing an existing DID is free.").
--
-- This is a data backfill (reads live owner/DID assignments), not schema, so
-- it is deliberately NOT run inline here — it should ship as its own
-- idempotent migration file once the exact source table/columns for the
-- receptionist DID-to-owner mapping are confirmed against the current
-- receptionist schema, e.g.:
--
--   INSERT OR IGNORE INTO user_dids
--     (id, uid, e164, provider, purpose, monthly_tokens, status, purchased_at)
--   SELECT
--     'did_' || lower(hex(randomblob(8))),
--     <owner_uid_column>,
--     did,
--     'vobiz',
--     'receptionist',
--     700,
--     'active',
--     <purchased_at_or_added_ms_column>
--   FROM <receptionist_did_ownership_table>
--   WHERE <owner_uid_column> IS NOT NULL;
--
-- Do NOT uncomment/run this without first confirming the receptionist
-- ownership table and column names against the live schema — ship it as a
-- separate reviewed migration (AVA-CAMP-A-backfill or similar issue id).
-- ---------------------------------------------------------------------------
