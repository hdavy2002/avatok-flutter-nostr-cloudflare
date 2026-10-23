-- [HF-POLICY-WITHDRAW-1] Receipts for people who accept a NEWER version of a policy page after registering.
-- Additive; the original registration receipts (hf_registration_policy_acceptances) are never touched.
CREATE TABLE IF NOT EXISTS hf_policy_reacceptances (
  uid TEXT NOT NULL,
  policy TEXT NOT NULL,
  document_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (uid, policy, document_version)
);
