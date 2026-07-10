-- [AVA-IDGATE-1] Just-in-time identity gating.
-- Spec: Specs/SPEC-2026-07-10-identity-gating.md
--
-- Apply: scripts/cf.sh worker d1 execute avatok-meta --remote --file=migrations/2026-07-10-identity-gating.sql
-- Run against DB_META. Run ONCE (SQLite has no ADD COLUMN IF NOT EXISTS).
--
-- ── NOTE ON WHERE LIVENESS LIVES ────────────────────────────────────────────────
-- Liveness state is NOT stored on `clerk_account_link`. An earlier draft of this
-- migration added columns there because auth.ts:requireVerifiedKV() reads that table.
-- That was wrong and would have bricked the gate:
--   • clerk_account_link is LEGACY, uid-keyed, and cfnative.sql says it gets dropped.
--   • Nothing inserts into it, so a new user has no row.
--   • requireVerifiedKV() has zero callers.
-- The live record is `identity_proofs` (uid, proof='liveness'), already written by
-- applyDiditPass(). We add no columns to it — its existing shape is exactly right:
--   verified_at   = when liveness passed (the 90-day window is measured from here)
--   provider      = 'didit' | 'grandfathered'
--   evidence_ref  = 'didit:<session id>'
-- Nothing here touches kyc_status or tier. kyc.ts owns those.

-- ---------------------------------------------------------------------------
-- 1. Make the gate's hot read cheap.
-- ---------------------------------------------------------------------------
-- gatePublicAction() runs on EVERY public action, and reads exactly this.
CREATE INDEX IF NOT EXISTS idx_identity_proofs_liveness
  ON identity_proofs(uid, proof, status);

-- ---------------------------------------------------------------------------
-- 2. Biometric consent + retention track (spec §10)
-- ---------------------------------------------------------------------------
-- BIPA §15(b): informed written consent BEFORE capture. An electronic signature is
-- sufficient (Public Act 103-0769, 2024-08-02). Recorded with the policy VERSION so
-- we can prove which disclosure the user actually saw. A bumped version invalidates
-- prior consent — nobody may be held to a retention period they never read.
ALTER TABLE users ADD COLUMN biometric_consent_at      INTEGER;
ALTER TABLE users ADD COLUMN biometric_consent_version TEXT;

-- Self-declared at the consent step. NOT IP geolocation (spec §10.2).
ALTER TABLE users ADD COLUMN residency_state TEXT;

-- 'extended'   = 256-day video retention (CONFIRMED non-IL/TX resident)
-- 'protective' = video deleted at account deletion (IL/TX, OR residency UNKNOWN)
--
-- Default 'protective'. Unknown residency must NEVER fail toward 'extended': IP tells
-- you where a device is, not where a person resides, and BIPA carries a private right
-- of action with statutory damages. Retaining a video we should have destroyed cannot
-- be undone; destroying one we could have kept costs a file we'd almost never use.
ALTER TABLE users ADD COLUMN retention_track TEXT NOT NULL DEFAULT 'protective';

-- ---------------------------------------------------------------------------
-- 3. Legal hold (spec §10.5, §10.6)
-- ---------------------------------------------------------------------------
-- Set by handleCsam() and any CSAM / serious-harm report. While 1, handleDeletion()
-- and purgeLivenessEvidence() MUST refuse. Destroying evidence on a reported account
-- may constitute spoliation; US law generally requires preserving reported CSAM.
ALTER TABLE users ADD COLUMN legal_hold        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN legal_hold_reason TEXT;
ALTER TABLE users ADD COLUMN legal_hold_at     INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_legal_hold ON users(legal_hold);

-- ---------------------------------------------------------------------------
-- 4. Deletion retention queue (spec §10.1) — the +256d sweep drains this.
-- ---------------------------------------------------------------------------
-- Metadata retained on BOTH tracks: a lawful request asks who, when, and verified how.
-- That is answered without the face. email_hash (not the address) is what `users` holds
-- anyway, and it is enough to confirm an account existed.
CREATE TABLE IF NOT EXISTS deleted_account_retention (
  uid                TEXT PRIMARY KEY,
  email_hash         TEXT,
  liveness_passed_at INTEGER,                  -- identity_proofs.verified_at
  liveness_source    TEXT,                     -- 'didit' | 'grandfathered'
  liveness_ref       TEXT,                     -- identity_proofs.evidence_ref
  retention_track    TEXT NOT NULL,
  video_retained     INTEGER NOT NULL DEFAULT 0, -- 1 only on the 'extended' track
  created_at         INTEGER,
  deleted_at         INTEGER NOT NULL,
  purge_after        INTEGER NOT NULL            -- deleted_at + 256d
);
CREATE INDEX IF NOT EXISTS idx_dar_purge_after ON deleted_account_retention(purge_after);
