-- STREAM H (AI Messenger Batch) — [LIVE-GATE-1] liveness audit trail.
-- Owner decision 2026-07-03 (D15): STORE EVERYTHING for BOTH pass and fail —
-- reverses the old delete-on-pass/fail behaviour. One row per verification
-- ATTEMPT (pass / fail / abandoned), plus the request geo/device fingerprint
-- and the R2 prefix where the clip + audit frames are kept for safety review.
--
-- Applied to DB_META (same shard as verification_status / kyc_status / identity_proofs).

CREATE TABLE IF NOT EXISTS liveness_audit (
  id           TEXT PRIMARY KEY,      -- uuid per attempt row
  uid          TEXT NOT NULL,         -- Clerk user id (or guest:… never — guests can't verify)
  provider     TEXT NOT NULL,         -- 'rekognition' | 'workersai'
  status       TEXT NOT NULL,         -- 'pass' | 'fail' | 'abandoned'
  confidence   REAL,                  -- 0..100 (Rekognition) or null
  ip           TEXT,                  -- CF-Connecting-IP
  country      TEXT,                  -- request.cf.country / CF-IPCountry
  city         TEXT,                  -- request.cf.city
  colo         TEXT,                  -- request.cf.colo (edge PoP)
  asn          TEXT,                  -- request.cf.asn
  device_model TEXT,                  -- from the client verify body
  os           TEXT,                  -- from the client verify body
  app_version  TEXT,                  -- from the client verify body
  r2_prefix    TEXT,                  -- liveness/<uid>/<session>/ in the VERIFICATION bucket
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_liveness_audit_uid    ON liveness_audit(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_liveness_audit_status ON liveness_audit(status, created_at);
