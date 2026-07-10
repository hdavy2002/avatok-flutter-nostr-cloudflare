-- [AVA-IDGATE-1] Just-in-time identity gating.
-- Spec: Specs/SPEC-2026-07-10-identity-gating.md
--
-- Run against DB_META. Idempotent-ish: SQLite has no ADD COLUMN IF NOT EXISTS,
-- so re-running errors on the ALTERs. That is fine — run once, deliberately.
--
-- NOTE ON `tier` (spec §3.4): liveness WRITES tier='verified' but NEVER clears it.
-- kyc.ts sets the same boolean. Clearing it on 90-day liveness expiry would silently
-- revoke KYC status. `liveness_passed_at` is the SOLE source of truth for expiry.

-- ---------------------------------------------------------------------------
-- 1. Liveness validity (90 days) + provenance
-- ---------------------------------------------------------------------------
ALTER TABLE clerk_account_link ADD COLUMN liveness_passed_at INTEGER;
ALTER TABLE clerk_account_link ADD COLUMN liveness_ref       TEXT;
-- 'didit'        = a real liveness check ran.
-- 'grandfathered'= NO check ever ran (pre-cutover user). See spec §11.1.
-- Never conflate these. This column is what a lawful request relies on.
ALTER TABLE clerk_account_link ADD COLUMN liveness_source    TEXT;

CREATE INDEX IF NOT EXISTS idx_cal_liveness_passed_at
  ON clerk_account_link(liveness_passed_at);

-- ---------------------------------------------------------------------------
-- 2. Biometric consent + retention track (spec §10)
-- ---------------------------------------------------------------------------
-- BIPA §15(b): informed written consent BEFORE capture. Electronic signature is
-- sufficient (Public Act 103-0769, 2024-08-02). Recorded with policy version so we
-- can prove WHICH disclosure the user saw.
ALTER TABLE users ADD COLUMN biometric_consent_at      INTEGER;
ALTER TABLE users ADD COLUMN biometric_consent_version TEXT;

-- Self-declared at the consent step. NOT ip geolocation (spec §10.2).
ALTER TABLE users ADD COLUMN residency_state TEXT;

-- 'extended'   = 256-day video retention (confirmed non-IL/TX resident)
-- 'protective' = video deleted at account deletion (IL/TX, OR residency UNKNOWN)
-- Default is 'protective'. Unknown residency must NEVER fail toward 'extended':
-- IP tells you where a device is, not where a person resides, and BIPA carries a
-- private right of action with statutory damages.
ALTER TABLE users ADD COLUMN retention_track TEXT NOT NULL DEFAULT 'protective';

-- ---------------------------------------------------------------------------
-- 3. Legal hold (spec §10.5, §10.6)
-- ---------------------------------------------------------------------------
-- Set by handleCsam() and any CSAM / serious-harm report. While 1, deletion and
-- evidence-purge paths MUST refuse. Destroying evidence on a reported account may
-- constitute spoliation.
ALTER TABLE users ADD COLUMN legal_hold        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN legal_hold_reason TEXT;
ALTER TABLE users ADD COLUMN legal_hold_at     INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_legal_hold ON users(legal_hold) WHERE legal_hold = 1;

-- ---------------------------------------------------------------------------
-- 4. Deletion retention queue (spec §10.1) — +256d sweep
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deleted_account_retention (
  uid              TEXT PRIMARY KEY,
  email_hash       TEXT,
  liveness_passed_at INTEGER,
  liveness_source  TEXT,
  liveness_ref     TEXT,
  retention_track  TEXT NOT NULL,
  video_retained   INTEGER NOT NULL DEFAULT 0, -- 1 only on the 'extended' track
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER NOT NULL,
  purge_after      INTEGER NOT NULL            -- deleted_at + 256d
);
CREATE INDEX IF NOT EXISTS idx_dar_purge_after ON deleted_account_retention(purge_after);
