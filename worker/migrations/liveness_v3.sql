-- Liveness V3 (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md + TRUST-ENGINE-ARCH.md).
-- Server-readable, deterministic (LLM-free) liveness pipeline that EXTENDS V2.
-- Applied to DB_META (same shard as verification_status / kyc_status /
-- identity_proofs / liveness_audit — so the V3 pass path can reuse them).
--
-- DO NOT apply automatically — the orchestrator/owner applies migrations.
-- Three new tables, all additive; nothing in V2 is altered.

-- ── Sessions (Policy-Engine entrypoint output; append-only, status advances). ──
-- One row per /api/liveness/v3/session. The KV mirror (livenessv3:sess:*) is the
-- hot-path source of truth; this D1 row is the durable audit copy + status track.
CREATE TABLE IF NOT EXISTS liveness_v3_sessions (
  session_id      TEXT PRIMARY KEY,   -- uuid
  uid             TEXT NOT NULL,      -- Clerk user id
  policy_id       TEXT NOT NULL,      -- caller policy (liveness never branches on it)
  requester       TEXT NOT NULL,      -- onboarding | marketplace_publish | guardian_require_verification | periodic_recheck
  nonce           TEXT NOT NULL,      -- single-use session nonce
  challenges      TEXT NOT NULL,      -- JSON array of randomized challenge actions
  overlay         TEXT NOT NULL,      -- JSON {shape,position,offset_x,offset_y,size_factor}
  capture_offsets TEXT NOT NULL,      -- JSON array of frame-sample offsets (0..1)
  status          TEXT NOT NULL,      -- created | pass | fail | review
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_livenessv3_sess_uid    ON liveness_v3_sessions(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_livenessv3_sess_status ON liveness_v3_sessions(status, created_at);

-- ── Content-hash dedupe (idempotency / replay defense — plan §3 runbook). ─────
-- SHA-256 of the uploaded video object. First-writer-wins: a later session whose
-- object hashes to an already-seen value is a REPLAY_ATTACK and spends NO
-- Rekognition. The PRIMARY KEY on content_hash enforces the dedupe.
CREATE TABLE IF NOT EXISTS liveness_v3_hashes (
  content_hash TEXT PRIMARY KEY,      -- sha256 hex of the video object
  uid          TEXT NOT NULL,         -- the FIRST account that submitted this object
  session_id   TEXT NOT NULL,         -- the FIRST session that submitted it
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_livenessv3_hashes_uid ON liveness_v3_hashes(uid, created_at);

-- ── Verdicts (APPEND-ONLY — never update-in-place; universal law 3/4). ────────
-- One immutable row per verify outcome, with the versioned ruleset + provider so
-- any decision is reproducible months later. reason_codes + rule_pass_map are the
-- machine-readable explanation for analytics/appeals/provider migration.
CREATE TABLE IF NOT EXISTS liveness_v3_verdicts (
  id                 TEXT PRIMARY KEY,   -- uuid per verdict
  session_id         TEXT NOT NULL,
  uid                TEXT NOT NULL,
  verdict            TEXT NOT NULL,      -- PASS | REVIEW | FAIL
  reason_codes       TEXT NOT NULL,      -- JSON array of ReasonCode
  rule_pass_map      TEXT NOT NULL,      -- JSON array of {id,pass,reason,detail}
  ruleset_version    TEXT NOT NULL,      -- e.g. LIVENESS_RULESET_V3_0
  provider           TEXT NOT NULL,      -- aws_rekognition | workers_ai | mixed | none
  provider_version   TEXT NOT NULL,      -- pinned model/API version
  cost_usd_estimate  REAL NOT NULL,      -- rough Rekognition spend for this verify
  requester          TEXT NOT NULL,
  policy_id          TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_livenessv3_verdicts_uid     ON liveness_v3_verdicts(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_livenessv3_verdicts_session ON liveness_v3_verdicts(session_id);
CREATE INDEX IF NOT EXISTS idx_livenessv3_verdicts_verdict ON liveness_v3_verdicts(verdict, created_at);
