-- [HF-CALL-SAFETY-BE] Influencer accepted call rules version N (sign-up step, or once for existing influencers). DB_META.
CREATE TABLE IF NOT EXISTS hf_call_rules_accept (
  uid TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL
);
