-- Progressive Identity (Trust Ladder) — DB_META
-- Proposal: Specs/proposals/PROPOSAL-PROGRESSIVE-IDENTITY.md
-- L0 visitor (handle-only guest) → L1 member (Clerk email+password) →
-- L2 verified human (liveness) → L3 KYC (Stripe Identity, payouts).

CREATE TABLE IF NOT EXISTS identity_proofs (
  uid TEXT NOT NULL,
  proof TEXT NOT NULL,            -- 'handle'|'email'|'password'|'phone'|'liveness'|'stripe_kyc'|app-specific
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'verified'|'rejected'|'expired'
  provider TEXT,                  -- 'clerk'|'workersai'|'rekognition'|'stripe_identity'|'firebase'|'system'
  evidence_ref TEXT,              -- R2 key of liveness thumbnail, stripe session id, …
  verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, proof)
);
CREATE INDEX IF NOT EXISTS idx_identity_proofs_uid ON identity_proofs(uid);

-- L0 guest bookkeeping. Guests reserve a handle before any Clerk account
-- exists; rows are purged after 90 days of inactivity (opportunistic sweep on
-- guest creation + deletion cron backstop). users.uid = 'guest:<uuid>'.
CREATE TABLE IF NOT EXISTS guest_accounts (
  uid TEXT PRIMARY KEY,           -- 'guest:<uuid>'
  handle TEXT NOT NULL,
  device_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  upgraded_uid TEXT               -- set when merged into a Clerk account
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_handle ON guest_accounts(handle);

-- ── Backfill existing accounts into the ledger ──────────────────────────────
INSERT OR IGNORE INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
  SELECT uid, 'handle', 'verified', 'system', updated_at, updated_at
  FROM users WHERE handle IS NOT NULL;

INSERT OR IGNORE INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
  SELECT uid, 'email', 'verified', 'clerk', email_verified_at, updated_at
  FROM contact_verification WHERE email_verified = 1;

INSERT OR IGNORE INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
  SELECT uid, 'phone', 'verified', 'firebase', phone_verified_at, updated_at
  FROM contact_verification WHERE phone_verified = 1;

INSERT OR IGNORE INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
  SELECT uid, 'liveness', 'verified', COALESCE(provider,'rekognition_liveness'), verified_at, updated_at
  FROM kyc_status WHERE status = 'verified';

INSERT OR IGNORE INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
  SELECT uid, 'stripe_kyc', 'verified', 'stripe_identity', verified_at, updated_at
  FROM kyc_status WHERE status = 'verified' AND provider LIKE 'stripe%';
