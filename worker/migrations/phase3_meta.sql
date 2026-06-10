-- Phase 3 — AvaIdentity (Stripe Identity as a second KYC provider behind the
-- existing AvaID gateway) + compliance runway (A1). Applies to DB_META.
--
-- Stripe Identity rides the SAME tables the Rekognition path uses
-- (verification_status / verification_attempts / kyc_status) — one gate, two
-- providers. We only add the columns the second provider needs.

-- Which provider an attempt went through ('rekognition' | 'stripe').
-- NULL on historical rows ⇒ rekognition.
ALTER TABLE verification_attempts ADD COLUMN provider TEXT;

-- Why the last verification failed / what input Stripe still needs
-- (surfaced by GET /api/id/status for the AvaIdentity screen).
ALTER TABLE verification_status ADD COLUMN failure_reason TEXT;

-- Stripe VerificationReport id (we never store document images — Stripe holds
-- them; we keep only the report reference, per Phase 3 spec).
ALTER TABLE kyc_status ADD COLUMN report_id TEXT;

-- A1 compliance runway: ToS / creator-agreement acceptance log. Recorded
-- before first withdrawal (Phase 3) and on first listing creation (Phase 6).
-- Versioned docs live in R2; bumping the version forces re-acceptance.
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  doc_id      TEXT NOT NULL,            -- 'creator-agreement' | 'tos' | ...
  version     TEXT NOT NULL,            -- doc version accepted, e.g. '1'
  accepted_at INTEGER NOT NULL,
  ip          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agree_uid_doc_ver ON agreement_acceptances(uid, doc_id, version);
CREATE INDEX IF NOT EXISTS idx_agree_uid ON agreement_acceptances(uid);
