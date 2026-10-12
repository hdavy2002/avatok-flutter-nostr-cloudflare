-- [HF-REF-AUTH-COMPLETE-1] Durable, account-owned registration steps. No OTPs.
CREATE TABLE IF NOT EXISTS hf_registration_progress (
  uid TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  kyc_choice INTEGER CHECK (kyc_choice IN (0,1)),
  accepted_policies_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Separate immutable receipts avoid inventing versions for historical accepts.
CREATE TABLE IF NOT EXISTS hf_registration_policy_acceptances (
  uid TEXT NOT NULL,
  policy TEXT NOT NULL,
  document_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (uid, policy)
);
